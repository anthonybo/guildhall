/**
 * A session's conversation, read backwards, a page at a time.
 *
 * The terminal view cannot show history and never will: Claude Code draws on the
 * terminal's ALTERNATE screen, and Ghostty — which cmux embeds — hardcodes
 * `scrollback-limit = 0` there, so the lines are discarded by the emulator before cmux
 * or guildhall could see them. Measured on this machine: every Claude and Codex pane
 * reports `scrollback_rows: 0`, while a plain shell pane reports 115. It is cmux issue
 * #2334 and it is open.
 *
 * Rebuilding a scrollback from the screens guildhall already polls was tried and does
 * not work — see MISTAKES.md. So the history is read from the file that has it all
 * along.
 *
 * Everything here is shaped by these files being enormous: 124MB and 30,115 records for
 * one session measured here, and `transcript.ts` records 171MB at 1.2s to parse whole.
 * So this NEVER reads a whole file. It seeks to the end and walks backwards in bounded
 * chunks, stopping as soon as it has a page, and hands back an offset to continue from.
 */
import fs from 'node:fs'
import { transcriptIndex } from './transcript.ts'

/** One thing that happened, already flattened for display. */
export type Entry = {
	at: string
	role: 'user' | 'assistant'
	/** What it is, so the view can style it the way the terminal does. */
	kind: 'text' | 'thinking' | 'tool' | 'result'
	text: string
	/** Present on a tool call: the tool's name, for the `⏺ Update(...)` line. */
	tool?: string
}

export type Page = {
	entries: Entry[]
	/** Byte offset to pass back as `before` for the next page, or null at the start. */
	cursor: number | null
	/** Total bytes, so a client can show how far back it is. */
	size: number
}

/** How much file to pull in one go. A page of conversation is far smaller than this. */
const CHUNK = 256 * 1024
/** Never walk further than this for one page, so a run of huge tool results cannot
 *  turn one request into reading the entire file. */
const MAX_WALK = 4 * 1024 * 1024
/** Long tool output is for the terminal, not for a history page. */
const CAP = { text: 8000, result: 400, tool: 300, thinking: 4000 } as const

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` … +${s.length - n} more characters` : s)

/**
 * Flatten one transcript record into zero or more display entries.
 *
 * Returns several because one assistant turn is commonly a thought, some prose and a
 * tool call, and showing them as one blob loses the shape the terminal gives them.
 */
function entriesOf(rec: unknown): Entry[] {
	const r = rec as {
		type?: string
		timestamp?: string
		message?: { role?: string; content?: unknown }
	}
	if (r.type !== 'user' && r.type !== 'assistant') return []
	const role = r.type
	const at = typeof r.timestamp === 'string' ? r.timestamp : ''
	const content = r.message?.content
	if (typeof content === 'string') {
		const text = content.trim()
		return text ? [{ at, role, kind: 'text', text: clip(text, CAP.text) }] : []
	}
	if (!Array.isArray(content)) return []
	const out: Entry[] = []
	for (const raw of content) {
		const b = raw as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown }
		if (b.type === 'text' && b.text?.trim()) out.push({ at, role, kind: 'text', text: clip(b.text.trim(), CAP.text) })
		else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ at, role, kind: 'thinking', text: clip(b.thinking.trim(), CAP.thinking) })
		else if (b.type === 'tool_use') {
			// The one line the terminal draws for a call: the tool and its subject.
			const input = b.input as Record<string, unknown> | undefined
			const subject = input ? (input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? '') : ''
			out.push({ at, role, kind: 'tool', tool: String(b.name ?? 'tool'), text: clip(String(subject ?? ''), CAP.tool) })
		} else if (b.type === 'tool_result') {
			const c = b.content
			const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string })?.text ?? '').join('\n') : ''
			const trimmed = text.trim()
			if (trimmed) out.push({ at, role, kind: 'result', text: clip(trimmed, CAP.result) })
		}
	}
	return out
}

/**
 * A page of conversation ending at `before`, newest last.
 *
 * `before` is a byte offset from a previous page's cursor; omitted means the end of the
 * file. Entries come back in file order so the view can append them above what it has.
 */
export function historyPage(sessionId: string, before?: number, want = 60): Page | null {
	const file = transcriptIndex().get(sessionId)
	if (!file) return null
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		return null
	}
	try {
		const size = fs.fstatSync(fd).size
		let end = before === undefined ? size : Math.max(0, Math.min(before, size))
		const entries: Entry[] = []
		let walked = 0
		while (end > 0 && entries.length < want && walked < MAX_WALK) {
			const len = Math.min(CHUNK, end)
			const start = end - len
			const buf = Buffer.alloc(len)
			fs.readSync(fd, buf, 0, len, start)
			walked += len
			const text = buf.toString('utf8')
			// The first line is almost certainly cut in half by the chunk boundary, so it
			// is dropped and the cursor is left pointing at its start — the next page picks
			// it up whole. Except at offset 0, where nothing precedes it.
			const nl = text.indexOf('\n')
			const usable = start === 0 ? text : nl === -1 ? '' : text.slice(nl + 1)
			const consumed = start === 0 ? 0 : start + (nl === -1 ? len : nl + 1)
			const page: Entry[] = []
			for (const line of usable.split('\n')) {
				if (!line.trim()) continue
				try {
					page.push(...entriesOf(JSON.parse(line)))
				} catch {
					// A half-written last line while the session is live. Skipping it is
					// right: the next poll gets it complete.
				}
			}
			entries.unshift(...page)
			end = consumed
			if (start === 0) break
		}
		// Every entry read is returned, and the cursor is exactly where reading stopped.
		//
		// This capped the page with `entries.slice(-want * 4)`, which silently LOSES
		// history: the entries dropped were the oldest in the page, they came from inside
		// the chunk the cursor now points past, and no later page can reach them again.
		// A cap is safe only if the cursor is moved back to match it, and there is no
		// need for one — the loop stops at the first chunk that satisfies `want`, so a
		// page is bounded by the chunk size, not by the record count.
		return { entries, cursor: end > 0 ? end : null, size }
	} finally {
		fs.closeSync(fd)
	}
}

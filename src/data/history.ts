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
	kind: 'text' | 'thinking' | 'tool' | 'result' | 'image'
	text: string
	/**
	 * On an image: where it is, as `<byte offset of its line>:<which image in that line>`,
	 * for `imageAt` to fetch. The pixels are never in a page — one screenshot is up to
	 * 2MB of base64 in the transcript, and a page full of them would be a download nobody
	 * asked for. Images Claude read carry `for`, the call that read them; one with no
	 * `for` was pasted into a message.
	 */
	image?: string
	/** On your messages: the byte offset of the line it is on, for the "You" list. */
	line?: number
	/** On your messages: sent while Claude was working, so it arrived queued. */
	queued?: true
	/** Present on a tool call: the tool's name, for the `⏺ Update(...)` line. */
	tool?: string
	/**
	 * Pairing, so a result can be folded under the call it answers.
	 *
	 * By id rather than by position. They do arrive adjacent today — and every
	 * assistant turn measured here made exactly one call — but "the next entry" is an
	 * assumption about someone else's file format, and this file already carries the
	 * ids that say it outright: `tool_use.id` and `tool_result.tool_use_id`.
	 */
	id?: string
	/** On a result: the id of the call it answers. */
	for?: string
	/** On a result: the tool reported failure, which is worth seeing without expanding. */
	error?: true
	/**
	 * The change itself, for a tool that made one.
	 *
	 * A tool RESULT for an edit is a receipt — "the file has been updated" — so opening
	 * one showed the filename and nothing else: "I see it saying it is editing files
	 * then go to expand and it just shows the files not the actual code that was
	 * changed". The code is in the tool's INPUT, which was being read for the file path
	 * and thrown away.
	 */
	before?: string
	after?: string
}

export type Page = {
	entries: Entry[]
	/** Byte offset to pass back as `before` for the next page, or null at the start. */
	cursor: number | null
	/** Total bytes, so a client can show how far back it is. */
	size: number
	/**
	 * On the newest page, and on anything newer: where the last COMPLETE line ends. The
	 * history asks for what came after it to stay current. Not `size`: a line still being
	 * written when this was read was skipped, and starting past it would lose it.
	 */
	end?: number
}

/** Just past the last newline at or before `size`; 0 when there is none in reach. */
function lineEnd(fd: number, size: number): number {
	let to = size
	while (to > 0 && size - to < MAX_WALK) {
		const len = Math.min(CHUNK, to)
		const buf = Buffer.alloc(len)
		fs.readSync(fd, buf, 0, len, to - len)
		const nl = buf.lastIndexOf(10)
		if (nl !== -1) return to - len + nl + 1
		to -= len
	}
	return 0
}

/** More than this written since the last look, and the view starts over from the newest
 *  page rather than being sent all of it — a long absence, or a run of big images. */
const MAX_AFTER = 8 * 1024 * 1024

/**
 * What a session has written since `after`, oldest first — how an open history stays
 * current. The history used to be read once, on opening, so anything said while it was
 * open never appeared until it was closed and opened again.
 *
 * `reset` when there is too much to send, or `after` is past the end (the file was
 * replaced): the view reloads its newest page instead.
 */
export function historyAfter(sessionId: string, after: number): { entries: Entry[]; end: number } | { reset: true } | null {
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
		if (after > size || size - after > MAX_AFTER) return { reset: true }
		const buf = Buffer.alloc(size - after)
		fs.readSync(fd, buf, 0, buf.length, after)
		const entries: Entry[] = []
		let from = 0
		for (;;) {
			const eol = buf.indexOf(10, from)
			// A line not finished yet waits for the next look.
			if (eol === -1) break
			const line = buf.subarray(from, eol).toString('utf8')
			if (line.trim()) {
				try {
					entries.push(...entriesOf(JSON.parse(line), after + from))
				} catch {
					// Not JSON even though complete: nothing to show for it.
				}
			}
			from = eol + 1
		}
		return { entries, end: after + from }
	} finally {
		fs.closeSync(fd)
	}
}

/** How much file to pull in one go. A page of conversation is far smaller than this. */
const CHUNK = 256 * 1024
/** Never walk further than this for one page, so a run of huge tool results cannot
 *  turn one request into reading the entire file. */
const MAX_WALK = 4 * 1024 * 1024
/**
 * Long tool output is for the terminal, not for a history page.
 *
 * `before`/`after` are generous because they are the answer to "what actually changed",
 * and stingy compared with the file: an edit's new text here runs to a median of 2,148
 * characters and a measured maximum of 3,053, so most survive whole and the rest say how
 * much was left. They ride along rather than being fetched on demand because opening the
 * transcript is a deliberate act, not a poll.
 */
const CAP = { text: 8000, result: 400, tool: 300, thinking: 4000, before: 900, after: 2200 } as const

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` … +${s.length - n} more characters` : s)

/**
 * Flatten one transcript record into zero or more display entries.
 *
 * Returns several because one assistant turn is commonly a thought, some prose and a
 * tool call, and showing them as one blob loses the shape the terminal gives them.
 */
/**
 * The words of something typed: a string, or the text blocks of a message that has no
 * tool results in it (those are a tool answering, not you). Empty when there are none.
 */
export function typedText(content: unknown): string {
	if (typeof content === 'string') return content.trim()
	if (!Array.isArray(content)) return ''
	const blocks = content as { type?: string; text?: string }[]
	if (blocks.some((b) => b?.type === 'tool_result')) return ''
	return blocks
		.filter((b) => b?.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text!.trim())
		.filter(Boolean)
		.join('\n')
}

export function entriesOf(rec: unknown, line = -1): Entry[] {
	const r = rec as {
		type?: string
		timestamp?: string
		message?: { role?: string; content?: unknown }
		attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string } }
	}
	// A message you sent while Claude was working. It is stored as an attachment, not a
	// user turn, so the history skipped every one — measured: 185 in one session, most
	// of what was typed during long turns.
	if (r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.origin?.kind === 'human') {
		const text = typedText(r.attachment.prompt)
		return text ? [{ at: r.timestamp ?? '', role: 'user', kind: 'text', text: clip(text, CAP.text), queued: true, ...(line >= 0 ? { line } : {}) }] : []
	}
	if (r.type !== 'user' && r.type !== 'assistant') return []
	const role = r.type
	const at = typeof r.timestamp === 'string' ? r.timestamp : ''
	const content = r.message?.content
	// Where your messages start in the file, so the "You" list can jump to one.
	const mark = role === 'user' && line >= 0 ? { line } : {}
	if (typeof content === 'string') {
		const text = content.trim()
		return text ? [{ at, role, kind: 'text', text: clip(text, CAP.text), ...mark }] : []
	}
	if (!Array.isArray(content)) return []
	const out: Entry[] = []
	// Images are numbered in the order `imagesIn` finds them, which is this same order:
	// each block, and inside a tool result, its own content.
	let n = 0
	const picture = (extra: Partial<Entry> = {}) => {
		const ref = `${line}:${n++}`
		if (line >= 0) out.push({ at, role, kind: 'image', text: '', image: ref, ...extra })
	}
	for (const raw of content) {
		const b = raw as {
			type?: string
			text?: string
			thinking?: string
			name?: string
			input?: unknown
			content?: unknown
			id?: string
			tool_use_id?: string
			is_error?: boolean
		}
		if (b.type === 'image') picture()
		else if (b.type === 'text' && b.text?.trim()) out.push({ at, role, kind: 'text', text: clip(b.text.trim(), CAP.text), ...mark })
		else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ at, role, kind: 'thinking', text: clip(b.thinking.trim(), CAP.thinking) })
		else if (b.type === 'tool_use') {
			// The one line the terminal draws for a call: the tool and its subject.
			const input = b.input as Record<string, unknown> | undefined
			const subject = input ? (input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? '') : ''
			// The change itself, where the tool made one. `Write` has no before: the whole
			// file is the after, and showing an empty removal beside it would imply one.
			const name = String(b.name ?? 'tool')
			const before = typeof input?.old_string === 'string' ? input.old_string : undefined
			const after =
				typeof input?.new_string === 'string'
					? input.new_string
					: typeof input?.content === 'string'
						? input.content
						: typeof input?.new_source === 'string'
							? input.new_source
							: undefined
			out.push({
				at,
				role,
				kind: 'tool',
				tool: name,
				text: clip(String(subject ?? ''), CAP.tool),
				...(b.id ? { id: b.id } : {}),
				...(before ? { before: clip(before, CAP.before) } : {}),
				...(after ? { after: clip(after, CAP.after) } : {}),
			})
		} else if (b.type === 'tool_result') {
			const c = b.content
			const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string })?.text ?? '').join('\n') : ''
			const trimmed = text.trim()
			// A failed call is worth a marker even when it printed nothing, so this is
			// kept when the text is empty and `is_error` is set.
			if (trimmed || b.is_error) {
				out.push({
					at,
					role,
					kind: 'result',
					text: clip(trimmed, CAP.result),
					...(b.tool_use_id ? { for: b.tool_use_id } : {}),
					...(b.is_error ? { error: true as const } : {}),
				})
			}
			// A Read of an image answers with the image itself.
			if (Array.isArray(c)) for (const x of c) if ((x as { type?: string })?.type === 'image') picture(b.tool_use_id ? { for: b.tool_use_id } : {})
		}
	}
	return out
}

type Block = { type?: string; content?: unknown; source?: { type?: string; data?: string; media_type?: string } }

/** Every image block in a record, in the order `entriesOf` numbers them. */
function imagesIn(rec: unknown): Block[] {
	const content = (rec as { message?: { content?: unknown } })?.message?.content
	if (!Array.isArray(content)) return []
	const out: Block[] = []
	for (const b of content as Block[]) {
		if (b?.type === 'image') out.push(b)
		else if (b?.type === 'tool_result' && Array.isArray(b.content)) for (const x of b.content as Block[]) if (x?.type === 'image') out.push(x)
	}
	return out
}

/** Media types an image is served as. Anything else in a transcript is not sent. */
const SERVABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** The longest line read to find one: the biggest seen here is 2MB, and a line is read
 *  whole, so this is the cap on what one request can make the server read. */
const MAX_LINE = 32 * 1024 * 1024

/**
 * One image out of a session's own transcript, by the reference a page gave for it.
 *
 * No more than the history view already discloses: it is the same file, behind the same
 * control token, and only image blocks come out of it. The offset has to be the start of
 * a line — a reference cannot be aimed into the middle of one — and the line is parsed,
 * never sliced, so all that can come back is an image the transcript actually holds.
 */
export function imageAt(sessionId: string, ref: string): { bytes: Buffer; type: string } | null {
	const m = /^(\d{1,15}):(\d{1,4})$/.exec(ref)
	if (!m) return null
	const at = Number(m[1])
	const n = Number(m[2])
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
		if (at >= size) return null
		if (at > 0) {
			const prev = Buffer.alloc(1)
			fs.readSync(fd, prev, 0, 1, at - 1)
			if (prev[0] !== 10) return null
		}
		const parts: Buffer[] = []
		let pos = at
		let read = 0
		for (;;) {
			const buf = Buffer.alloc(Math.min(CHUNK, size - pos))
			if (!buf.length) break
			fs.readSync(fd, buf, 0, buf.length, pos)
			const nl = buf.indexOf(10)
			parts.push(nl === -1 ? buf : buf.subarray(0, nl))
			read += nl === -1 ? buf.length : nl
			if (nl !== -1 || read > MAX_LINE) break
			pos += buf.length
		}
		if (read > MAX_LINE) return null
		let rec: unknown
		try {
			rec = JSON.parse(Buffer.concat(parts).toString('utf8'))
		} catch {
			return null
		}
		const src = imagesIn(rec)[n]?.source
		if (src?.type !== 'base64' || typeof src.data !== 'string' || !SERVABLE.has(String(src.media_type))) return null
		return { bytes: Buffer.from(src.data, 'base64'), type: String(src.media_type) }
	} finally {
		fs.closeSync(fd)
	}
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
		// The bytes read but not yet parsed: the tail end of a line that began before the
		// chunk just read. Joined onto the next chunk back, so a line longer than a chunk
		// is completed rather than lost.
		//
		// It used to be dropped. A chunk with no newline in it — any line over 256KB, which
		// a screenshot in the conversation always is — moved the cursor to the END of the
		// chunk, which is where it already was. The page came back empty with the same
		// cursor, every later request asked for the same page, and the history simply
		// stopped. Measured on a real 538MB transcript with 485 such lines: 78 entries,
		// then 29, then nothing, from three screens above the bottom.
		let carry = Buffer.alloc(0)
		// Two offsets, because carried bytes sit between them: `end` is where the next read
		// stops, and `cursor` is the start of the oldest line actually parsed — the page
		// boundary. Using one for both re-read the carried bytes and duplicated them.
		let cursor = end
		// Bounded by MAX_WALK only once something has been parsed, so a single line bigger
		// than the walk is still read through rather than wedging the cursor in front of it.
		while (end > 0 && entries.length < want && (walked < MAX_WALK || !entries.length)) {
			const len = Math.min(CHUNK, end)
			const start = end - len
			const buf = Buffer.alloc(len)
			fs.readSync(fd, buf, 0, len, start)
			walked += len
			const joined = carry.length ? Buffer.concat([buf, carry]) : buf
			// The first line is almost certainly cut in half by the chunk boundary, so it is
			// kept back for the next chunk and the cursor is left pointing just past it.
			// Except at offset 0, where nothing precedes it. Searched in bytes, not text: a
			// newline byte is never part of a multi-byte character, so splitting there
			// cannot cut one in half the way decoding a raw chunk boundary can.
			const nl = start === 0 ? -1 : joined.indexOf(10)
			if (start > 0 && nl === -1) {
				// No line ends in here: all of it belongs to a line that started further back.
				carry = joined
				end = start
				continue
			}
			carry = start === 0 ? Buffer.alloc(0) : joined.subarray(0, nl + 1)
			// Line by line in bytes, so each record knows where it starts in the file —
			// which is how an image in it is fetched later (see imageAt).
			const page: Entry[] = []
			let from = start === 0 ? 0 : nl + 1
			while (from < joined.length) {
				const eol = joined.indexOf(10, from)
				const stop = eol === -1 ? joined.length : eol
				const line = joined.subarray(from, stop).toString('utf8')
				if (line.trim()) {
					try {
						page.push(...entriesOf(JSON.parse(line), start + from))
					} catch {
						// A half-written last line while the session is live. Skipping it is
						// right: the next poll gets it complete.
					}
				}
				from = stop + 1
			}
			entries.unshift(...page)
			end = start
			cursor = start === 0 ? 0 : start + nl + 1
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
		return { entries, cursor: cursor > 0 ? cursor : null, size, ...(before === undefined ? { end: lineEnd(fd, size) } : {}) }
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * Every message you typed in a session, start to finish, for the history's "You" list.
 *
 * The list used to be built from the pages the history had loaded, and a page is the
 * last 60 entries — in a session that runs dozens of tools per reply, often none of them
 * yours. It said "none of your messages are loaded yet" and needed "Show earlier" tapped
 * over and over. Measured: 545 typed messages across 64,225 lines in one transcript.
 *
 * Read once per transcript and then only what was added since, because a whole one takes
 * a moment — measured 1.4s for 603MB, 0.7s for 196MB — and the reading yields between
 * chunks so the server keeps answering meanwhile.
 */
import fs from 'node:fs'
import { inserted, typedForm } from '../../web/said.ts'
import { transcriptIndex } from './transcript.ts'
import { typedText } from './history.ts'

export type Mine = {
	at: string
	/** The start of it, enough for a row in a list. */
	text: string
	/** Byte offset of its line, which is how the history finds the card to jump to. */
	line: number
	/** Sent while Claude was working, so it arrived queued rather than as a turn. */
	queued?: true
}

const CHUNK = 4 * 1024 * 1024
const SHORT = 300
/** Lines bigger than this are images and tool output, never something typed. */
const LONGEST = 200_000
const USER = Buffer.from('"type":"user"')
const QUEUED = Buffer.from('"queued_command"')

const seen = new Map<string, { scanned: number; items: Mine[]; busy?: Promise<void> }>()

export async function yourMessages(sessionId: string): Promise<Mine[] | null> {
	const file = transcriptIndex().get(sessionId)
	if (!file) return null
	let state = seen.get(file)
	if (!state) seen.set(file, (state = { scanned: 0, items: [] }))
	// One read at a time per file; a second asker waits for the first.
	while (state.busy) await state.busy
	state.busy = scan(file, state).finally(() => {
		if (state) state.busy = undefined
	})
	await state.busy
	return state.items
}

async function scan(file: string, state: { scanned: number; items: Mine[] }) {
	const fh = await fs.promises.open(file, 'r')
	try {
		const size = (await fh.stat()).size
		// Replaced by a shorter file: start over.
		if (size < state.scanned) {
			state.scanned = 0
			state.items = []
		}
		let pos = state.scanned
		let carry = Buffer.alloc(0)
		while (pos < size) {
			const buf = Buffer.alloc(Math.min(CHUNK, size - pos))
			const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
			if (!bytesRead) break
			const joined = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
			const base = pos - carry.length
			let from = 0
			for (;;) {
				const eol = joined.indexOf(10, from)
				if (eol === -1) break
				const line = joined.subarray(from, eol)
				if (line.length < LONGEST && (line.indexOf(USER) !== -1 || line.indexOf(QUEUED) !== -1)) {
					const m = typed(line.toString('utf8'), base + from)
					if (m) state.items.push(m)
				}
				from = eol + 1
			}
			carry = joined.subarray(from)
			pos += bytesRead
			// Only complete lines count; a half-written last one is read next time.
			state.scanned = pos - carry.length
		}
	} finally {
		await fh.close()
	}
}

/** The message in one line, if it is something you typed. */
function typed(raw: string, line: number): Mine | null {
	let rec: { type?: string; timestamp?: string; message?: { content?: unknown }; attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string }; timestamp?: string } }
	try {
		rec = JSON.parse(raw)
	} catch {
		return null
	}
	const short = (s: string) => (s.length > SHORT ? `${s.slice(0, SHORT)}…` : s)
	if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command' && rec.attachment.origin?.kind === 'human') {
		const text = typedText(rec.attachment.prompt)
		return text ? { at: rec.timestamp ?? rec.attachment.timestamp ?? '', text: short(text), line, queued: true } : null
	}
	if (rec.type !== 'user') return null
	const text = typedText(rec.message?.content)
	// Claude Code writes notices into the conversation as if you had said them; those
	// are not yours (see web/said.ts).
	if (!text || inserted(text) !== null) return null
	return { at: rec.timestamp ?? '', text: short(typedForm(text)), line }
}

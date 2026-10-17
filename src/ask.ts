/**
 * Typing a message into a session and making sure it went in.
 *
 * Split out of control.ts when the long-paste fix pushed it past the length this
 * repository allows. Everything here is the one path that types AND presses Enter,
 * so it is kept together where its guards can be read in one place.
 */
import { type Pane, type Result, paneOf, paneParams, readScreen, rpcAt } from './control.ts'

/**
 * Type `text` into the session and submit it.
 *
 * Text and Enter are one operation on purpose. Exposing them separately would
 * make a bare Enter reachable, and a bare Enter is how you accept whatever
 * prompt happens to be on screen — including a permission request.
 */
export async function ask(where: string | Pane, text: string, io: Io = cmuxIo): Promise<Result> {
	const pane = paneOf(where)
	if (!paneParams(pane)) return { ok: false, error: 'not a workspace id' }
	const body = text.trim()
	if (!body) return { ok: false, error: 'nothing to send' }
	// A single line. Newlines inside would submit early and run the remainder as
	// separate turns, which is not what anyone typing into a box intends.
	if (/[\r\n]/.test(body)) return { ok: false, error: 'send one line at a time' }
	// Long pasted logs are a normal thing to send. Was 4000, which refused them;
	// measured against a real session, Claude Code takes 20,000 characters through
	// this path as a paste and submits it whole.
	if (body.length > MAX_ASK) return { ok: false, error: `too long — ${body.length.toLocaleString('en-US')} characters, the limit is ${MAX_ASK.toLocaleString('en-US')}` }
	// The text ALONE. Enter follows from settled(), and only once the text is seen
	// sitting in the prompt.
	//
	// It used to travel in the same write, and that is fine for a short line and
	// broken for a long one. Claude Code decides a burst of input is a PASTE, folds it
	// into `[Pasted text #1 +1 lines]`, and the carriage return arriving inside the
	// burst becomes a newline in the paste instead of a submit. Measured against a
	// scratch session: a 3,000-character line arrived and sat unsent; a separate Enter
	// afterwards submitted it at once. That was "my long logs get stuck and doubled".
	//
	// `terminal.input` rather than `send` for a second reason, and it is a bug in
	// its own right: `send` INTERPRETS `\n`, `\r` and `\t` in the text it is given.
	// Verified against a scratch shell — sending `X\nY` submits `X` and leaves `Y`
	// behind on the next prompt. So any message containing a literal backslash-n was
	// being split in half and its remainder run as a separate turn, which is exactly
	// the failure the guard above is meant to prevent and could not see, because it
	// looks for real newline characters and this is two ordinary ones. cmux offers no
	// way to escape it. `terminal.input` takes the text raw and passes it through
	// unread, so there is nothing to escape.
	//
	// Text and Enter are STILL one operation to every caller, which is the safety
	// property that matters: nothing outside this function can reach a bare Enter, and
	// the Enter inside it is only pressed into a prompt that is holding THIS text.
	const typed = await io.input(pane, body)
	if (!typed.ok) return typed
	return settled(pane, body, io)
}

/** Longest message accepted. A pasted log, not a novel. */
export const MAX_ASK = 20_000

/** How a send reaches a terminal. A seam so the dangerous paths can be tested. */
export type Io = {
	input: (pane: Pane, text: string) => Promise<Result>
	read: (pane: Pane) => Promise<Result>
	wait: (ms: number) => Promise<void>
}
/**
 * A long message in pieces, because one big write LOSES text.
 *
 * Measured against a scratch session, read back from its transcript: in one write,
 * 12,000 characters arrived as 3,941 and 20,000 as 2,626, and a 3,900-character
 * line lost its start. The terminal's input queue is small and a single write
 * overruns it before Claude Code can drain it — which is why a paste from a real
 * terminal, fed in pieces, never does this. 512 characters with 20ms between was
 * whole in five of five trials up to 20,000 characters; 1,024 with 10ms already
 * dropped and garbled text. The screen check after cannot see a loss, so the piece
 * size is the only protection the content has — do not raise it to go faster.
 */
export function pieces(text: string, size = 512): string[] {
	const out: string[] = []
	let cur = ''
	// By code point, so a character outside the BMP is never split into a lone half.
	for (const ch of text) {
		if (cur.length + ch.length > size) {
			out.push(cur)
			cur = ''
		}
		cur += ch
	}
	if (cur) out.push(cur)
	return out
}

const cmuxIo: Io = {
	async input(pane, text) {
		const parts = pieces(text)
		for (let i = 0; i < parts.length; i++) {
			if (i) await new Promise((r) => setTimeout(r, 20))
			const r = await rpcAt('terminal.input', pane, { text: parts[i] })
			// Part of it is already in the prompt, unsent. Say so, or the retry this
			// invites would put a second copy beside it.
			if (!r.ok) return i ? { ok: false, error: `only part of the message went in (${r.error}) — clear the session's prompt at the machine before sending again` } : r
		}
		return { ok: true, text: '' }
	},
	read: (pane) => readScreen(pane, 40),
	wait: (ms) => new Promise((r) => setTimeout(r, ms)),
}

/**
 * Did the message actually go in — and if not, put it right.
 *
 * Reported repeatedly as "I have to send everything twice", and every attempt to
 * fix it by reasoning about the mechanism missed, because the mechanism is not
 * reliably reproducible: 26 trials here, idle and busy, atomic and delayed, all
 * passed. Something between a phone and this function drops a send sometimes and
 * I cannot make it happen on demand.
 *
 * So this stops trying to be right about the cause and checks the outcome
 * instead. The screen is the ground truth about whether a message landed, it is
 * already readable, and reading it costs about 150ms — far less than noticing by
 * hand and typing the whole thing again.
 *
 * It looks at WHERE the text is rather than just whether it worked:
 *
 *  - Sitting in the input box: it arrived and is waiting for Enter. Press Enter —
 *    never re-type, or the message lands twice.
 *  - In the box once, gone after Enter: submitted. Done, whatever the scrollback
 *    shows, because a long message echoes taller than the screen that is read.
 *  - Never seen in the box: it did not arrive. Reported, NOT re-typed. Re-typing
 *    was how a long log ended up in the prompt twice: the check could not find
 *    it, decided it was lost, and sent a second copy beside the first. The "lost"
 *    send this once repaired turned out to be a browser tap that never made a
 *    request (MISTAKES.md), so the repair was only ever doing harm.
 *
 * Anything found in the SCROLLBACK is already submitted and must be left alone.
 * That distinction is the whole reason this reads the input box specifically: a
 * submitted message echoes with the same chevron the prompt uses, and an earlier
 * version of the test harness matched those echoes and called every success a
 * failure.
 *
 * Exported so the repair can be driven against a real session rather than trusted:
 * the dangerous outcome here is a message delivered twice, and that has to be
 * demonstrated not to happen.
 */
export async function settled(pane: Pane, body: string, io: Io = cmuxIo): Promise<Result> {
	// Compared with whitespace collapsed. The TUI wraps a long message across
	// several lines, so a raw substring test would miss text that plainly arrived.
	const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
	const head = flat(body).slice(0, 60)
	const tail = flat(body).slice(-60)
	// Its start, its end, or the marker Claude Code folds a paste into. The start
	// alone was the old test and it is the part a long message scrolls OUT of the
	// box: measured, a 3,900-character line showed only its last eleven rows.
	// Codex folds a big paste into `[Pasted Content N chars]`.
	const holds = (box: string) => box.includes(head) || box.includes(tail) || /\[Pasted (text #|Content )\d+/.test(box)
	const enter = () => io.input(pane, '\r')
	let pressed = 0

	// Waits grow: a 20,000-character paste takes Claude Code visibly longer to draw
	// than a short line, and a box read mid-draw looks empty.
	//
	// Codex gets a longer schedule and more presses. Once text arrives in more than one
	// write it ignores Enter for seconds, growing with the length — measured in a scratch
	// pane: 400 characters (one write) sent at 0.3s; 800 stuck at 0.3s; 2,900 stuck at
	// 1, 3 and 5s and sent at 7 and 10s; 8,000 still stuck at 7s. An early Enter loses
	// nothing — a later one still sends — so this keeps looking and pressing, inside the
	// browser's 20-second deadline.
	const CLAUDE = [250, 400, 700, 1000, 1500]
	const CODEX = [250, 750, 1500, 2500, 3500, 4500, 5500]
	let waits = CLAUDE
	let most = 3
	for (let i = 0; i < waits.length; i++) {
		await io.wait(waits[i])
		const seen = await io.read(pane)
		if (seen.ok && waits === CLAUDE && isCodex(seen.text)) {
			waits = CODEX
			most = 6
		}
		const box = seen.ok ? inputBox(seen.text) : ''
		// No screen, or no prompt to find on it: cannot judge, so behave as the
		// original single write did and press Enter once. Never more than once blind.
		if (!seen.ok || !hasBox(seen.text)) {
			if (pressed) return { ok: true, text: '' }
			return enter()
		}
		if (holds(flat(box))) {
			// Waiting in the prompt. Enter only; it is THIS text, so this cannot be
			// a permission prompt being answered.
			if (pressed >= most) break
			pressed++
			const r = await enter()
			if (!r.ok) return r
			continue
		}
		// Was in the box, Enter pressed, no longer there: it went.
		if (pressed) return { ok: true, text: '' }
		// Not arrived yet. Look again rather than type it a second time.
	}
	return {
		ok: false,
		error: pressed
			? 'the message is in the session but would not submit — check it at the machine'
			: 'the message did not arrive — check the session at the machine before sending it again',
	}
}

/**
 * The prompt's input box: the line between the last two rules.
 *
 * Not "does the text appear on screen". A message that submitted successfully is
 * echoed into the scrollback with the same `❯` the prompt draws, so searching the
 * whole screen reports every success as a stuck message.
 */
export function inputBox(screen: string) {
	return claudeBox(screen) ?? codexBox(screen) ?? ''
}

/** A Codex composer and no Claude box: which schedule `settled` should keep. */
const isCodex = (screen: string) => claudeBox(screen) === null && codexBox(screen) !== null

/** Whether there is an input box on this screen at all, in either harness's shape. */
export const hasBox = (screen: string) => claudeBox(screen) !== null || codexBox(screen) !== null

function claudeBox(screen: string) {
	const lines = screen.split('\n')
	const rules: number[] = []
	lines.forEach((l, i) => {
		if (/^\s*─{20,}/.test(l)) rules.push(i)
	})
	if (rules.length < 2) return null
	const [a, b] = rules.slice(-2)
	const inside = lines.slice(a + 1, b).join(' ')
	// Claude's box always holds its `❯`. Two rules without one are something a session
	// printed — a table, a separator in Codex's output — not a prompt.
	if (!inside.includes('❯')) return null
	return inside.replace(/❯/g, '').trim()
}

/**
 * Codex draws no rules: its composer is a line starting `›`, with the model and the
 * shortcuts hint below it. Sent messages are echoed above with the same `›`, but always
 * ABOVE the composer, so the LAST such line is the box. Measured on Codex 0.162 in a
 * scratch pane: after a submit the last `›` is the placeholder "Ask Codex to do anything".
 *
 * This is what lets a Codex pane be checked rather than pressed blind. Blind, a
 * 2,900-character message sat in the composer unsent — Codex treats a fast burst as a
 * paste, like Claude Code, and swallowed the one Enter. A second Enter sent it.
 */
function codexBox(screen: string) {
	const lines = screen.split('\n')
	let at = -1
	lines.forEach((l, i) => {
		if (/^›(\s|$)/.test(l)) at = i
	})
	if (at < 0) return null
	return lines.slice(at).join(' ').replace(/^›/, '').trim()
}

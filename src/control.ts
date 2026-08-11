/**
 * Driving a session's real terminal, rather than watching it.
 *
 * Everything else in guildhall reads. This file is the one exception, and it is
 * deliberately the only one: if it is not called, the program cannot change
 * anything, which keeps "is this still read-only?" a question with a one-file
 * answer.
 *
 * It works through cmux's socket API — `read-screen` to see what a session's
 * terminal actually shows, `send` and `send-key` to type into it. That drives
 * the terminal you already have open, which is the point. The alternative,
 * `claude -p --resume <id>`, starts a SECOND process on the same transcript:
 * two writers on one conversation, and nothing appears on your own screen.
 *
 * What this deliberately does not do:
 *
 *  - answer a permission prompt. A remote caller that can approve tool use has
 *    escalated itself to running arbitrary commands, so `y` and its friends are
 *    refused and the prompt has to be answered by a person at the machine.
 *  - address a workspace by position. cmux's `workspace:N` refs are not in tab
 *    order, so a number would eventually type into the wrong project's terminal.
 *    Only the UUID from the session map is accepted.
 */
import { execFile } from 'node:child_process'
import { CMUX } from './data/cmux-bin.ts'

/** Long enough for a busy app, short enough that a hung socket is not a stall. */
const TIMEOUT = 5000

/**
 * Keys that would answer a prompt rather than type into one.
 *
 * Claude Code's permission prompts accept a bare letter or Enter, and the whole
 * safety story here rests on a person being the one who approves tool use. A
 * remote `send-key y` is indistinguishable from consent, so this refuses to
 * carry one. Enter is allowed only as the submit that follows text this same
 * process just sent — see `ask` — never on its own.
 */
const REFUSED = new Set(['y', 'n', 'a', 'd', 'Y', 'N', 'A', 'D', 'Tab', 'Escape', 'Esc'])

export type Result = { ok: true; text: string } | { ok: false; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function run(args: string[]): Promise<Result> {
	return new Promise((resolve) => {
		execFile(CMUX, args, { timeout: TIMEOUT, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => {
			if (err) return resolve({ ok: false, error: (stderr || err.message || 'failed').trim().slice(0, 200) })
			resolve({ ok: true, text: stdout })
		})
	})
}

/**
 * The terminal as a styled grid: every span with its colour, weight and place.
 *
 * `read-screen` returns plain text, which loses the two things a TUI is made of
 * — colour and exact position — so Claude Code's status bar arrived as grey
 * rubble. This is the same screen as structured data: a style table, and spans
 * that each name a row, a column and a style id. Reconstructing it is exact
 * rather than approximate, because nothing was flattened on the way out.
 *
 * `terminal.replay` is not in `cmux --help`; it is in `cmux capabilities` under
 * `methods`, which is where the richer API lives.
 *
 * The parameter is `workspace_id`, snake_case. `workspaceId` is not rejected —
 * it is IGNORED, and the call returns whichever surface happens to be focused.
 * That is the worst possible failure for this feature: every session showed the
 * same screen while `send` still targeted correctly, so you could read one
 * project and type into another. Anything added here must assert it got the
 * surface it asked for; see the test.
 */
export async function readGrid(workspace: string): Promise<Result> {
	if (!UUID.test(workspace)) return { ok: false, error: 'not a workspace id' }
	return run(['rpc', 'terminal.replay', JSON.stringify({ workspace_id: workspace })])
}

/** What the session's terminal is showing right now, as plain text. */
export async function readScreen(workspace: string, lines = 120, scrollback = false): Promise<Result> {
	if (!UUID.test(workspace)) return { ok: false, error: 'not a workspace id' }
	const args = ['read-screen', '--workspace', workspace, '--lines', String(Math.max(1, Math.min(2000, lines)))]
	if (scrollback) args.push('--scrollback')
	return run(args)
}

/**
 * Type `text` into the session and submit it.
 *
 * Text and Enter are one operation on purpose. Exposing them separately would
 * make a bare Enter reachable, and a bare Enter is how you accept whatever
 * prompt happens to be on screen — including a permission request.
 */
export async function ask(workspace: string, text: string): Promise<Result> {
	if (!UUID.test(workspace)) return { ok: false, error: 'not a workspace id' }
	const body = text.trim()
	if (!body) return { ok: false, error: 'nothing to send' }
	// A single line. Newlines inside would submit early and run the remainder as
	// separate turns, which is not what anyone typing into a box intends.
	if (/[\r\n]/.test(body)) return { ok: false, error: 'send one line at a time' }
	if (body.length > 4000) return { ok: false, error: 'too long' }
	// One call, and the carriage return travels with the text.
	//
	// This was `send` followed by a separate `send-key Enter`: two processes, with
	// a gap of a hundred milliseconds or so in between, and the reported failure was
	// a message that arrived in Claude Code's prompt and just sat there unsubmitted —
	// the text landing and the Enter not taking. Intermittent, which is what a race
	// looks like from the outside. There is no gap to lose it in now.
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
	// Text and Enter are STILL one operation, which is the safety property that
	// matters: no caller can reach a bare Enter, and a bare Enter is how you accept
	// whatever prompt happens to be on screen — including a permission request.
	return run(['rpc', 'terminal.input', JSON.stringify({ workspace_id: workspace, text: `${body}\r` })])
}

/** Exposed for the tests: whether a key would be refused as an approval. */
export const refuses = (key: string) => REFUSED.has(key)

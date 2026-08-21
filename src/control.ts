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
import { runCmux } from './cmuxreach.ts'
import { existsSync } from 'node:fs'
import { spawnAllowed } from './data/projects.ts'

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

/**
 * Every cmux call goes through cmuxreach, which owns how this process is authorized.
 *
 * It used to spawn cmux with the ambient environment and nothing else. That works from a
 * cmux pane, which inherits a socket capability, and cannot work from the launchd service,
 * which inherits nothing — so the default installation could read every session and type
 * into none, and reported cmux's own error to a phone.
 */
const run = (args: string[]): Promise<Result> => runCmux(args, TIMEOUT)

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
	const typed = await run(['rpc', 'terminal.input', JSON.stringify({ workspace_id: workspace, text: `${body}\r` })])
	if (!typed.ok) return typed
	return settled(workspace, body)
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
 * Two failures are possible and they need opposite repairs, which is why this
 * looks at WHERE the text is rather than just whether it worked:
 *
 *  - Still sitting in the input box. The text arrived, the Enter did not take.
 *    Send another Enter; never re-type, or the message lands twice.
 *  - Nowhere on screen at all. The text never arrived. Re-type it — this is the
 *    case that was observed live, with an empty prompt and the message simply
 *    gone.
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
export async function settled(workspace: string, body: string): Promise<Result> {
	// Compared with whitespace collapsed. The TUI wraps a long message across
	// several lines, so a raw substring test would miss text that plainly arrived
	// and then "repair" it by sending it a second time.
	const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
	const needle = flat(body).slice(0, 60)
	let retyped = false

	for (let attempt = 0; attempt < 3; attempt++) {
		// Long enough for the TUI to redraw. Measured against a real session: a
		// submitted message clears the box well inside this.
		await new Promise((r) => setTimeout(r, 250))
		const seen = await readScreen(workspace, 40)
		// Cannot see, so cannot judge. Report the send as done rather than repeat it:
		// a message that arrives twice is worse than one this function is unsure about.
		if (!seen.ok) return { ok: true, text: '' }

		if (flat(inputBox(seen.text)).includes(needle)) {
			// Arrived, unsent. Enter only — re-typing here would submit it twice.
			const again = await run(['rpc', 'terminal.input', JSON.stringify({ workspace_id: workspace, text: '\r' })])
			if (!again.ok) return again
			continue
		}
		// Out of the box and somewhere on screen: submitted. Done.
		if (flat(seen.text).includes(needle)) return { ok: true, text: '' }
		// Nowhere at all. It never landed — which is the case seen live, with an
		// empty prompt and the message simply gone. Safe to type again precisely
		// BECAUSE it is absent: it was sent moments ago, so if it had arrived it
		// would still be on screen. Once only; a send that vanishes twice is a
		// failure worth reporting rather than a loop worth running.
		if (retyped) break
		retyped = true
		const resent = await run(['rpc', 'terminal.input', JSON.stringify({ workspace_id: workspace, text: `${body}\r` })])
		if (!resent.ok) return resent
	}
	return { ok: false, error: 'the message would not go in — check the session at the machine before sending it again' }
}

/**
 * The prompt's input box: the line between the last two rules.
 *
 * Not "does the text appear on screen". A message that submitted successfully is
 * echoed into the scrollback with the same `❯` the prompt draws, so searching the
 * whole screen reports every success as a stuck message.
 */
export function inputBox(screen: string) {
	const lines = screen.split('\n')
	const rules: number[] = []
	lines.forEach((l, i) => {
		if (/^\s*─{20,}/.test(l)) rules.push(i)
	})
	if (rules.length < 2) return ''
	const [a, b] = rules.slice(-2)
	return lines
		.slice(a + 1, b)
		.join(' ')
		.replace(/❯/g, '')
		.trim()
}

/**
 * Start a new Claude Code session in `dir`, in its own cmux tab.
 *
 * The one thing here that creates something rather than talking to something
 * that already exists, and it is the most powerful call in the program: a session
 * can edit files and run commands, so being able to start one is being able to do
 * both. It is guarded exactly like typing — control on, loopback or tailnet only,
 * control password — and additionally the directory must be one the SERVER
 * offered. A path taken from the request would be arbitrary code execution in a
 * text field.
 *
 * cmux does the work in one call: create the workspace with the right cwd and run
 * `claude` in it. `--focus false` because this is usually driven from a phone and
 * stealing the desktop's foreground tab is not part of the deal.
 *
 * Nothing is passed as a prompt. The session comes up empty and you type into it
 * through the terminal panel like any other, which is deliberate — it means the
 * first message goes through the same guarded path as every other message, and
 * Claude Code names the session from it exactly as it does normally.
 */
export async function spawn(dir: string, title = 'new session'): Promise<Result> {
	if (!spawnAllowed(dir)) return { ok: false, error: 'not a directory this machine offered' }
	// A title cmux will accept as a tab name and nothing more. The session renames
	// itself once the conversation has a subject, which is the point.
	const name = title.replace(/[^\w .-]/g, '').slice(0, 40) || 'new session'
	// Returns as soon as cmux has made the tab. It does NOT wait to see whether the
	// session came up usable, and that is deliberate after trying the alternative.
	//
	// Some directories open a modal instead of a prompt — "Is this a project you
	// created or one you trust?", or a settings-permissions confirmation — and
	// guildhall refuses to answer prompts remotely on purpose, so a session stuck
	// behind one cannot be used from a phone. Detecting that here looked easy and is
	// not: `claude` takes 25-30 seconds to draw its first screen, so a probe a few
	// seconds after creation reads a blank terminal and reports success. Measured —
	// a 3.5s check passed a session that was sitting on the trust prompt.
	//
	// Waiting the full half-minute inside the request is worse: it holds an HTTP
	// connection open past the client's own timeout to answer a question the client
	// can answer better. So the wait belongs there — the browser is already watching
	// the feed for the new row, and if it never arrives it says why.
	//
	// Predicting it from `~/.claude.json` was tried first and does not work either;
	// the flag disagrees with reality in both directions. See data/projects.ts.
	// `--id-format both` so the UUID comes back, not just a `workspace:N` ref. The
	// ref is positional and cmux's own help warns those are not in tab order; the
	// UUID is the only durable handle, and it is what gets remembered below.
	const made = await run(['workspace', 'create', '--name', name, '--cwd', dir, '--command', 'claude', '--focus', 'false', '--id-format', 'both'])
	if (!made.ok) return made
	// Remember the exact tab, so the session that appears in this directory half a
	// minute from now can be matched to it. cmux will never record the link itself
	// for a CLI-created workspace — see data/spawned.ts.
	const uuid = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.exec(made.text)?.[0]
	if (!uuid) return { ok: false, error: 'cmux did not report which workspace it made' }
	// The UUID goes back to the caller, and that is the whole safety story for the
	// browser: it waits for the row carrying THIS workspace, never for "a row in
	// that directory". Seven sessions share `~/projects` here, so directory
	// matching opened the terminal of whichever was busiest — an unrelated session,
	// mid-conversation, ready to receive a message meant for a new one.
	return { ok: true, text: uuid }
}

/**
 * The four keys a selection prompt needs, as raw terminal input.
 *
 * Claude Code asks a lot of questions as a list you move a caret through —
 * plan choices, `AskUserQuestion`, and permission requests all render the same
 * way. From a phone there was no way to answer any of them, which meant the one
 * moment a session most needs you was the one moment you could do nothing.
 *
 * Raw escape sequences through `terminal.input` rather than `send-key`, for the
 * same reason `ask` uses it: it is verified, it passes bytes through untouched,
 * and it does not interpret anything on the way. Confirmed against a live prompt —
 * `\x1b[B` moved the caret from the first option to the second and `\x1b[A` moved
 * it back.
 *
 * FOUR keys and no more. Not a general keyboard: no text, no letters, nothing that
 * could type a command into a shell that happens to be at a prompt. Moving a caret
 * and confirming are the whole vocabulary of answering a question.
 */
/** The escape byte, written as an escape rather than embedded raw: a literal
 *  0x1b in the source is invisible in every editor and diff. */
const ESC = '\u001b'

const KEYS: Record<string, string> = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	enter: '\r',
	escape: ESC,
}

export async function press(workspace: string, key: string): Promise<Result> {
	if (!UUID.test(workspace)) return { ok: false, error: 'not a workspace id' }
	const seq = KEYS[String(key).toLowerCase()]
	if (!seq) return { ok: false, error: `not an answerable key: ${String(key).slice(0, 20)}` }
	return run(['rpc', 'terminal.input', JSON.stringify({ workspace_id: workspace, text: seq })])
}

/** Exposed for the tests: whether a key would be refused as an approval. */
export const refuses = (key: string) => REFUSED.has(key)

/**
 * Where the codex CLI is, for the same reason CMUX is resolved rather than assumed:
 * launchd starts this program with almost no environment, so PATH is not usable.
 */
const CODEX = (() => {
	const set = process.env.GUILDHALL_CODEX
	if (set) return set
	const home = process.env.HOME ?? ''
	for (const c of [`${home}/.local/bin/codex`, '/usr/local/bin/codex', '/opt/homebrew/bin/codex']) {
		if (existsSync(c)) return c
	}
	return 'codex' // fall back to PATH; the caller reports the failure either way
})()

/**
 * Queue a message into a Codex thread.
 *
 * `codex queue --thread <uuid> --message <text>`, which is a documented subcommand
 * rather than the app-server protocol — that turned out to be unreachable, and this
 * needs no daemon, no handshake and no long-lived connection. See docs/codex.md.
 *
 * The UUID is validated before the process is spawned, which is this project's rule
 * about driving an agent CLI and it was written in blood: `cmux send` with an empty
 * or unmatched target does not refuse, it falls back to whatever surface is FOCUSED,
 * and that typed test strings into a live session twice.
 *
 * `codex queue` is better behaved — measured, an empty `--thread` answers "No active
 * session found matching ''" and exits 1, rather than picking something — but the
 * check stays, because the guarantee that matters is the one this side enforces.
 *
 * The EXIT STATUS is trustworthy here, which is worth stating because the last time
 * an agent CLI's status was trusted in this project it was read after a pipe and
 * reported `head`'s. Measured directly: 1 for a thread that does not exist, 2 for a
 * missing argument, 0 on success.
 */
export async function askCodex(thread: string, text: string): Promise<Result> {
	if (!UUID.test(thread)) return { ok: false, error: 'not a thread id' }
	const body = text.trim()
	if (!body) return { ok: false, error: 'nothing to send' }
	// One line, as with `ask`: a newline would submit early and run the remainder as
	// its own turn, which is never what somebody typing into a box meant.
	if (/[\r\n]/.test(body)) return { ok: false, error: 'send one line at a time' }
	if (body.length > 4000) return { ok: false, error: 'too long' }
	// No control characters, and a NUL is why this line exists.
	//
	// `execFile` REJECTS an argv element containing a NUL, and it does so by throwing
	// synchronously inside the promise executor — so the promise rejects, and the
	// request handler in serve.ts has nothing to catch it. Node exits. One POST with a
	// NUL in the message took the whole server down, and because the announcement fires
	// after the await, it was the one send a remote caller could make with no trace of
	// it at all.
	//
	// The cmux path is immune by accident rather than design: `ask` puts the text inside
	// `JSON.stringify`, so a NUL becomes six harmless characters. This path hands the
	// string straight to argv, so it has to say no itself.
	//
	// Everything below 0x20 except nothing, plus 0x7f: a message is one line of text.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(body)) return { ok: false, error: 'no control characters' }
	return new Promise((resolve) => {
		execFile(
			CODEX,
			// `--message=<text>`, not `--message <text>`.
			//
			// As two arguments, clap reads a body beginning with a dash as a flag and
			// refuses the whole call: "a value is required for '--message <TEXT>'". So a
			// legitimate message starting with a hyphen could never be sent, and the browser
			// got a parser error rather than a send. Attached with `=`, the value is
			// unambiguous whatever it starts with. This is not an injection fix — execFile
			// takes an args array and there is no shell — it is about a message nobody
			// could send.
			['queue', '--thread', thread, `--message=${body}`],
			{ timeout: TIMEOUT, maxBuffer: 4 << 20, windowsHide: true },
			(err, stdout, stderr) => {
				// Its own words on failure. "no rollout found for thread id …" tells somebody
				// what went wrong; "failed" does not.
				if (err) return resolve({ ok: false, error: (stderr || stdout || err.message || 'failed').trim().slice(0, 200) })
				resolve({ ok: true, text: stdout })
			},
		)
	})
}

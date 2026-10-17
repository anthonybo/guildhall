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

/** Long enough for a busy app, short enough that a hung socket is not a stall.
 *  Settable for the tests that stand a script in for cmux: in the full suite at load 80
 *  that script measured over 5s just to start, and the key test failed on the clock. */
const TIMEOUT = Number(process.env.GUILDHALL_CMUX_TIMEOUT) || 5000

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

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every cmux call goes through cmuxreach, which owns how this process is authorized.
 *
 * It used to spawn cmux with the ambient environment and nothing else. That works from a
 * cmux pane, which inherits a socket capability, and cannot work from the launchd service,
 * which inherits nothing — so the default installation could read every session and type
 * into none, and reported cmux's own error to a phone.
 */
export const run = (args: string[]): Promise<Result> => runCmux(args, TIMEOUT)

/**
 * A terminal to drive: the tab, and the pane inside it when that is known.
 *
 * The tab alone is not an address once a tab is split. cmux resolves a bare
 * `workspace_id` to whichever pane is FOCUSED, and a tab holding Claude beside a
 * second pane — a backlog TUI, as reported on a real project — sent the browser that pane's
 * screen, and would have typed messages into it. cmux records which pane holds the
 * agent (see data/cmux.ts), so the pane is named whenever it is known. Measured on a
 * scratch split: `surface_id` beside `workspace_id` reached the unfocused pane for
 * both `terminal.input` and `terminal.replay`, and each reply named that surface.
 */
export type Pane = { workspace: string; surface?: string }

export const paneOf = (p: string | Pane): Pane => (typeof p === 'string' ? { workspace: p } : p)

/** The cmux parameters naming exactly this terminal, or null if either id is malformed. */
export function paneParams(p: Pane): { workspace_id: string; surface_id?: string } | null {
	if (!UUID.test(p.workspace)) return null
	if (p.surface === undefined) return { workspace_id: p.workspace }
	return UUID.test(p.surface) ? { workspace_id: p.workspace, surface_id: p.surface } : null
}

/**
 * A `terminal.*` call against one pane. When a pane was named, a reply from any other
 * pane is an error — cmux has ignored a parameter it did not recognise before
 * (`workspaceId`), and the fallback is always the focused pane.
 */
export async function rpcAt(method: string, where: string | Pane, extra: Record<string, unknown> = {}): Promise<Result> {
	const p = paneOf(where)
	const params = paneParams(p)
	if (!params) return { ok: false, error: 'not a workspace id' }
	const r = await run(['rpc', method, JSON.stringify({ ...params, ...extra })])
	if (!r.ok || !p.surface) return r
	let got = ''
	try {
		got = String(JSON.parse(r.text).surface_id ?? '')
	} catch {
		return { ok: false, error: 'unreadable reply from cmux' }
	}
	return got.toUpperCase() === p.surface.toUpperCase() ? r : { ok: false, error: 'cmux answered from a different pane than the session is in' }
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
export async function readGrid(where: string | Pane): Promise<Result> {
	return rpcAt('terminal.replay', where)
}

/** What the session's terminal is showing right now, as plain text. */
export async function readScreen(where: string | Pane, lines = 120, scrollback = false): Promise<Result> {
	const p = paneOf(where)
	if (!paneParams(p)) return { ok: false, error: 'not a workspace id' }
	const args = ['read-screen', '--workspace', p.workspace, '--lines', String(Math.max(1, Math.min(2000, lines)))]
	if (p.surface) args.push('--surface', p.surface)
	if (scrollback) args.push('--scrollback')
	return run(args)
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
/**
 * The durable id behind a positional ref.
 *
 * `workspace list --json` carries `id` and `ref` on the same row, so this is a lookup
 * rather than an inference — the distinction that matters in this file, where matching a
 * session to a tab by anything approximate has gone wrong before.
 */
export async function uuidOfRef(
	ref: string,
	list = () => run(['workspace', 'list', '--json']),
	wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<string | null> {
	// ASKED AGAIN until it shows up. cmux answers `workspace create` before the new tab is
	// in its own list: measured five times in a row, it appeared after 664, 730, 810, 1069
	// and 1242 ms. One immediate lookup found nothing and reported failure for a tab it
	// had just made — a new project came up in cmux while the phone said
	// "cmux did not report which workspace it made". Ten seconds is eight times the worst.
	for (let t = 0; t < 40; t++) {
		if (t) await wait(250)
		const listed = await list()
		if (!listed.ok) continue
		try {
			const parsed: unknown = JSON.parse(listed.text)
			const rows = (Array.isArray(parsed) ? parsed : ((parsed as { workspaces?: unknown[] })?.workspaces ?? [])) as { id?: unknown; ref?: unknown }[]
			const hit = rows.find((w) => w.ref === ref)
			if (hit) return typeof hit.id === 'string' && UUID.test(hit.id) ? hit.id : null
		} catch {
			// a half-written reply is as good as no reply: ask again
		}
	}
	return null
}

export async function spawn(dir: string, title = 'new session', resume?: string): Promise<Result> {
	if (!spawnAllowed(dir)) return { ok: false, error: 'not a directory this machine offered' }
	// A session id, or nothing. Validated to a UUID before it can reach a command line for
	// the same reason `ask` validates a workspace: this string becomes an argument to a
	// process, and the one rule this file has is that nothing the browser sends is trusted
	// as a path or as an argument.
	if (resume !== undefined && !UUID.test(resume)) return { ok: false, error: 'not a session id' }
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
	// The UUID is the only durable handle — a `workspace:N` ref is positional and cmux's
	// own help warns those are not in tab order — but cmux no longer offers a way to ask
	// for one at creation. `--id-format both` was passed here and is not a flag any more:
	// `workspace create --help` does not list it, cmux ignores the unknown argument, and
	// the reply is `OK workspace:19` with no UUID in it. The regex below then found
	// nothing and this function reported failure for a tab it had just successfully
	// created — measured on a scratch workspace. The ref is resolved through
	// `workspace list --json`, which carries `id` and `ref` side by side.
	// `--resume <id>` picks up the conversation that transcript belongs to, rather than
	// starting an empty one. This is the whole difference between "open a session" and
	// "open THAT session", and it is why closing one on the machine no longer means losing
	// your way back to it from a phone.
	const cmd = resume ? `claude --resume ${resume}` : 'claude'
	const made = await run(['workspace', 'create', '--name', name, '--cwd', dir, '--command', cmd, '--focus', 'false'])
	if (!made.ok) return made
	// Remember the exact tab, so the session that appears in this directory half a
	// minute from now can be matched to it. cmux will never record the link itself
	// for a CLI-created workspace — see data/spawned.ts.
	// A UUID if a future cmux prints one, else the ref it does print, resolved.
	const direct = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.exec(made.text)?.[0]
	const ref = /workspace:\d+/.exec(made.text)?.[0]
	const uuid = direct ?? (ref ? await uuidOfRef(ref) : null)
	if (!uuid) return { ok: false, error: 'cmux did not report which workspace it made' }
	// The UUID goes back to the caller, and that is the whole safety story for the
	// browser: it waits for the row carrying THIS workspace, never for "a row in
	// that directory". Seven sessions share `~/projects` here, so directory
	// matching opened the terminal of whichever was busiest — an unrelated session,
	// mid-conversation, ready to receive a message meant for a new one.
	return { ok: true, text: uuid }
}

/**
 * Say yes to "Is this a project you created or one you trust?" — ONLY for a folder
 * guildhall made itself, a moment ago, empty, because it was asked to.
 *
 * Every new folder opens on that prompt, with "No, exit" highlighted. From a phone
 * the obvious move is ⏎, which closes the session that was just asked for. There is
 * nothing in a folder created seconds ago to distrust, so this answers it: ▼ to the
 * yes, read the screen again, and Enter only if the yes is what the caret is on.
 *
 * Watched for a minute because `claude` takes 25-30 seconds to draw anything (see
 * spawn). Stops as soon as the prompt is answered or an input box appears instead.
 * Measured on a scratch folder: ▼ then Enter on this prompt led to a ready session.
 */
export async function trustNew(workspace: string, io = { read: readScreen, press, wait: (ms: number) => new Promise((r) => setTimeout(r, ms)) }) {
	if (!UUID.test(workspace)) return false
	const ASKING = /Is this a project you created or one you trust\?/
	for (let t = 0; t < 30; t++) {
		await io.wait(2000)
		const screen = await io.read(workspace, 40)
		if (!screen.ok) continue
		if (!ASKING.test(screen.text)) {
			// A prompt line between rules means the session is past any question.
			if (/^\s*─{20,}[\s\S]*❯[\s\S]*─{20,}/m.test(screen.text)) return false
			continue
		}
		await io.press(workspace, 'down')
		await io.wait(300)
		const moved = await io.read(workspace, 40)
		if (!moved.ok || !/❯\s*Yes, I trust this folder/.test(moved.text)) return false
		return (await io.press(workspace, 'enter')).ok
	}
	return false
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
 * FOUR keys here, and a few named shortcuts below. Not a general keyboard: no text, no
 * letters, nothing that could type a command into a shell that happens to be at a
 * prompt. Moving a caret and confirming are the whole vocabulary of answering a question.
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

/**
 * Claude Code's own shortcuts, for the moments it tells you to press one.
 *
 * Asked for from a phone, which has no ctrl or shift to send them with. Still a closed
 * list of named keys — no letters, no text, nothing a shell would run — and each was
 * pressed on a scratch session and seen to do its job:
 *
 *  - ctrl+enter sends a queued message now, interrupting the turn in progress.
 *  - shift+tab cycles the permission mode: manual, accept edits, plan, auto.
 *  - ctrl+b moves a running shell command to the background.
 *  - ctrl+o opens and closes the detailed transcript.
 *
 * ctrl+c and ctrl+d are left out on purpose: twice ctrl+c quits Claude Code, and a
 * ctrl+d at a shell prompt closes the shell.
 *
 * Through `surface.send_key`, not raw bytes. Once Claude Code has started, cmux types
 * `terminal.input` as keystrokes, so a raw `ESC [ Z` arrived as an Escape and then the
 * text "[Z" in the input box — measured — while the arrows above still work raw.
 * send_key names the key and lets the terminal encode it the way the program asked.
 */
const NAMED = new Set(['ctrl+enter', 'shift+tab', 'ctrl+b', 'ctrl+o'])

export async function press(where: string | Pane, key: string): Promise<Result> {
	if (!paneParams(paneOf(where))) return { ok: false, error: 'not a workspace id' }
	const name = String(key).toLowerCase()
	if (NAMED.has(name)) return rpcAt('surface.send_key', where, { key: name })
	const seq = KEYS[name]
	if (!seq) return { ok: false, error: `not an answerable key: ${String(key).slice(0, 20)}` }
	return rpcAt('terminal.input', where, { text: seq })
}

/**
 * A left click at a cell of a pane, through cmux's own `terminal.mouse`.
 *
 * For the panes BESIDE a session — a backlog TUI that folds and opens items on a
 * click — which a phone has no other way to drive. cmux encodes the press and release
 * the way the program asked for, and sends nothing to a program that did not ask:
 * measured with a scratch program echoing its input, `{row, col}` (from 0) arrived as
 * `ESC[<0;col+1;row+1M` then `…m`, and the same call into a plain shell typed nothing.
 * `x`/`y` and `column` were accepted and ignored — cmux does not reject unknown keys.
 */
export async function click(where: Pane, row: number, col: number): Promise<Result> {
	if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row > 999 || col > 999) return { ok: false, error: 'not a cell' }
	return rpcAt('terminal.mouse', where, { row, col })
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

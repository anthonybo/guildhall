/**
 * A glance at what a session's screen is showing, for the room to draw.
 *
 * SYNCHRONOUS, and that is the shape of the whole file. Both renderers are synchronous —
 * `draw()` in main.ts and `frame()` in web/room.ts — so a promise is useless to them: its
 * value arrives after the frame that wanted it. This answers from cache immediately and
 * refreshes behind the answer, which is what `data/usage.ts` already does for the same
 * reason. The first version was `async` and could not be called by anything that draws.
 *
 * THE COST IS THE SPAWN. Measured: a screen read costs ~0.08 cpu-s whether it returns 1KB
 * of plain text or 58KB of styled grid, because both start a cmux process. Seven desks on
 * a two-second timer is 0.28 cpu-s per second — a third of a core, continuously, which is
 * the cost CLAUDE.md apologises for. So this does not run on a timer.
 *
 * IT READS WHEN THE CONTENT MIGHT HAVE MOVED, not when a clock says so. The caller passes
 * a `token` — anything that changes when the session does, and `collect()` already has
 * one for free in the transcript size it stats for every digest. An idle session costs
 * NOTHING: same token, no read, no process. A timer is wrong in both directions at once,
 * re-reading a session that has done nothing and lagging one that is busy.
 *
 * Deliberately does not import `control.ts`. That file's header exists so "is this still
 * read-only?" has a one-file answer, and a module the room draws from should not widen
 * it. This builds its own read-screen call over `runCmux`.
 */
import { runCmux } from './cmuxreach.ts'

/**
 * How much of a screen to keep.
 *
 * Was 14, which was sized for a four-line wall display. A desk screen drawn as an image
 * holds seven rows or more, and after `clean()` strips the box rules, the blank half below
 * the prompt and the spinner, fourteen raw lines routinely became three — so the screen
 * filled a third of itself and the rest was dark glass.
 *
 * Reading more costs nothing: measured, a screen read is ~0.08 cpu-s whether it returns 1KB
 * or 58KB, because the cost is starting the cmux process and not the bytes it hands back.
 */
export const PEEK_LINES = 40

/** A glance that takes longer than this is not a glance. */
const TIMEOUT = 4000

/**
 * A backstop, for what the token cannot see.
 *
 * A long `bash` run streams output without the transcript growing, so the token sits
 * still while the screen moves. Thirty seconds costs nothing on an idle room — one read
 * per session per half minute at worst — and keeps a busy desk from going badly stale.
 */
const BACKSTOP = 30_000

/**
 * How long to wait after a failure.
 *
 * `usage.ts` says this in bold: it had no backoff and got its calls rate-limited. A cmux
 * that cannot be reached at all — the launchd case in MISTAKES.md — would otherwise be
 * asked again on every frame, forever.
 */
const AFTER_ERROR = 30_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Glance = {
	/** Newest last. Empty until the first read lands, which is not the same as blank. */
	lines: string[]
	/** When these lines were read, or 0 if they never were. */
	at: number
	/** A read is out right now. */
	reading: boolean
	/** The last attempt failed; `lines` is the last good text, or empty. */
	error?: string
}

type Entry = {
	lines: string[]
	at: number
	/** The token these lines were read for, so an unchanged session is not re-read. */
	token: string
	reading: boolean
	error?: string
	failedAt: number
	/**
	 * Bumped whenever an entry is dropped or replaced.
	 *
	 * A read landing after `resetPeek()` or `keepOnly()` used to write itself back and
	 * resurrect a workspace nobody was watching — and two reads could end up in flight on
	 * one workspace with the second silently discarded, which is the pile-up this file
	 * claims cannot happen. The landing read checks this before writing.
	 */
	gen: number
}

const seen = new Map<string, Entry>()
let generation = 0
/** In-flight reads, so a test can wait for a refresh this synchronous API started. */
const running = new Set<Promise<unknown>>()

export function resetPeek() {
	generation++
	seen.clear()
}
export const peekSize = () => seen.size
/** Test seam: the API is synchronous, so there is otherwise no way to await the refresh
 *  it kicked off. */
export async function whenQuiet() {
	while (running.size) await Promise.allSettled([...running])
}

/**
 * How a screen is read.
 *
 * A parameter so a test can count the reads and answer without a cmux on the machine —
 * the call count is the design here and cannot be observed from outside. Note this is NOT
 * the `liveSessions(dir)` pattern, which is a path; there is no function-injection
 * precedent in src/, so this one stands on its own reasoning.
 */
export type Reader = (workspace: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

const readScreen: Reader = async (workspace) => {
	const r = await runCmux(['read-screen', '--workspace', workspace, '--lines', String(PEEK_LINES)], TIMEOUT)
	return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error }
}

/**
 * The prompt, which is the boundary everything else here hangs off.
 *
 * `❯` is measured: it is what a live session's input line actually starts with, and it is
 * not a character that markdown, `diff` or a REPL produces, so it can be trusted anywhere.
 *
 * `>` cannot. It is a blockquote, a diff marker and a Python prompt as well as an older
 * input line, and treating it as a boundary truncated 14 lines to ONE when a wrapped quote
 * opened the window. It is accepted only with nothing but chrome below it — which is where
 * a real prompt sits and where none of the four false positives ever are.
 */
const PROMPT = /^❯\s?/
const OLD_PROMPT = /^>\s?/

/**
 * The status block below the prompt: gauges, model, context, mode.
 *
 * Used to CUT FROM THE FIRST MATCH rather than pop from the end. Popping stopped at the
 * first line that matched nothing, and a background-agent line (`◯ general-purpose
 * Running … ↓ 122.3k tokens`) sits in the middle of the block — so the pop stopped there
 * and the whole status block below it survived, spend included.
 */
const CHROME = /[█░▓]{3,}|Today\s+\$|\d+k\/\d+[MK]|auto mode|shift\+tab|^Weekly\b|\d+hr\s+\d+m/i

/**
 * The day's spend, and the context gauge that sits with it.
 *
 * Dropped wherever it appears, not just off the end — the ONE unconditional rule in this
 * file, because it is the one whose failure cannot be undone: `tools/make-docs-images`
 * renders this room into images that get committed to a public repo. Measured leaking
 * through the fallback branch below before this existed.
 *
 * Deliberately narrow. `$` alone is not a spend figure — a session discussing what
 * something cost keeps its words — so this matches only the two shapes the status bar
 * produces and nothing a person writes.
 */
const SPEND = /Today\s+\$\s*[\d.]|\d+k\/\d+[MK]\b/

/**
 * The trailer ABOVE the prompt.
 *
 * A spinner, an update notice, a token counter, a bare prompt. Measured across seven live
 * sessions: after the prompt boundary ran, FIVE of them had nothing but this in the last
 * four lines — the board drew a spinner, "Update installed", and an empty `❯`, which is a
 * display of the terminal's furniture rather than of the session.
 *
 * Removed only when something else survives, so a session that has just started still
 * shows its spinner rather than claiming there is nothing on screen.
 */
const TRAILER = /^[✢✻✳✽✶✷✸✹⏺◯●*]\s|Update installed|Restart to update|↓\s*[\d.]+k tokens|esc to interrupt|ctrl\+b to run in background|^Tip:\s/

/** A prompt carrying an unsent message — worth seeing from across a room. A bare one is
 *  not, and it costs a quarter of the board. */
const TYPED = /^[❯>]\s*\S/
const BARE_PROMPT = /^[❯>]\s*$/

/**
 * Tidy a screen into lines worth drawing.
 *
 * A TUI screen is mostly furniture: box rules, the gutters tool output is indented with,
 * and a blank half below the prompt. None of it survives being drawn small, and all of it
 * costs room somebody wants for words.
 */
export function clean(text: string): string[] {
	const lines = text
		.split('\n')
		.map((l) =>
			l
				.replace(/^[\s│⎿]+/, '')
				.replace(/\s+$/, '')
				// A rule with something on the end of it.
				//
				// The filter below only drops a line made ENTIRELY of box characters, so
				// `─────────────  waiting` survived and spent a THIRD of a three-line glass on a
				// horizontal line. Seen on the board in a live session, which is the only reason
				// it was noticed — nothing about it is visible in a test fixture.
				.replace(/^[─━═]{3,}\s*/, '')
				.replace(/\s*[─━═]{3,}$/, '')
				.replace(/[ \t]{3,}/g, '  '),
		)
		// Blank lines go too. On a display this short a blank is a third of the content.
		.filter((l) => l && !/^[─│╭╮╰╯┌┐└┘━┃╔╗╚╝═║]+$/.test(l))
	while (lines.length && !lines[lines.length - 1]) lines.pop()
	// Drop the status block off the bottom.
	//
	// Two reasons, and the second is the important one. It is the least informative part
	// of the screen — model, context percentage, mode — and all of it is already in the
	// table below the room, so spending a small display on it says nothing twice. And it
	// carries the DAY'S SPEND, which is not something to paint on a wall: this project's
	// own rule is that no dollar figure leaves the machine, and `tools/make-docs-images`
	// renders this room into images that get committed.
	//
	// THE PROMPT IS THE BOUNDARY. Everything below the last `❯` is chrome — model, gauges,
	// mode — and everything above it is the conversation. That is a structural fact about
	// the screen rather than a guess about its wording, so it does not rot when a model
	// gets renamed or a gauge changes shape. Matching "Opus 5 1M" was the alternative, and
	// a status line naming the model is exactly the sort of thing that changes.
	//
	// See PROMPT for why the two markers are not treated alike.
	let prompt = lines.findLastIndex((l) => PROMPT.test(l))
	if (prompt < 0) {
		const old = lines.findLastIndex((l) => OLD_PROMPT.test(l))
		if (old >= 0 && lines.slice(old + 1).every((l) => CHROME.test(l))) prompt = old
	}
	if (prompt >= 0) lines.length = prompt + 1
	// Then sweep the tail for status chrome regardless of whether a prompt was found. A
	// screen whose prompt has been pushed out of the window is the case that leaked, and
	// cutting from the FIRST match takes the interleaved agent lines with it.
	const tail = Math.max(0, lines.length - PEEK_LINES)
	for (let i = tail; i < lines.length; i++) {
		if (!CHROME.test(lines[i]!)) continue
		lines.length = i
		break
	}
	// The backstop. Everything above is structural and could be defeated by a screen shape
	// nobody has seen; this is a flat refusal to draw the two shapes only the status bar
	// makes, wherever they turn up.
	let out = lines.filter((l) => !SPEND.test(l))
	// An empty prompt goes unconditionally: it is a quarter of the board spent saying the
	// session has an input box. A prompt carrying an unsent message stays — see TYPED.
	out = out.filter((l) => TYPED.test(l) || !BARE_PROMPT.test(l))
	// The furniture immediately above it goes only if something else survives — a session
	// that has just started is better served by its spinner than by "nothing on screen
	// yet", which reads as broken rather than as busy.
	const said = out.filter((l) => l && !TRAILER.test(l))
	if (said.length) out = said
	while (out.length && !out[out.length - 1]) out.pop()
	return out.slice(-PEEK_LINES)
}

/**
 * What this workspace's screen was showing, and a refresh if it might have moved.
 *
 * Returns immediately, always. `token` is anything that changes when the session does — a
 * transcript size is ideal and free. Same token in, no read out.
 */
export function glance(workspace: string, token: string, now = Date.now(), read: Reader = readScreen): Glance {
	// Junk in, nothing out, and no entry minted for it. `runCmux` would refuse the id too,
	// but only after paying for a process, and a caller passing rubbish in a loop would
	// grow this map a key at a time.
	if (!UUID.test(workspace)) return { lines: [], at: 0, reading: false, error: 'not a workspace id' }
	const had = seen.get(workspace)
	// `slice()`, never the cached array itself: handing that out let one caller's `pop()`
	// corrupt every other reader of the same session.
	const state: Glance = had
		? { lines: had.lines.slice(), at: had.at, reading: had.reading, ...(had.error !== undefined ? { error: had.error } : {}) }
		: { lines: [], at: 0, reading: false }

	if (had?.reading) return state
	const moved = !had || had.token !== token
	const old = !had || now - had.at >= BACKSTOP
	const waiting = had?.error !== undefined && now - had.failedAt < AFTER_ERROR
	if ((!moved && !old) || waiting) return state

	const gen = generation
	const before: Entry = {
		lines: had?.lines ?? [],
		at: had?.at ?? 0,
		token,
		reading: true,
		failedAt: had?.failedAt ?? 0,
		...(had?.error !== undefined ? { error: had.error } : {}),
		gen,
	}
	seen.set(workspace, before)
	state.reading = true

	const job = (async () => {
		let out: { ok: true; text: string } | { ok: false; error: string }
		try {
			out = await read(workspace)
		} catch (e) {
			// A reader that REJECTS rather than returning a Result. The first version left
			// the pending promise in place, so every later call got the same rejection and
			// the workspace never recovered short of a restart.
			out = { ok: false, error: e instanceof Error ? e.message : 'read failed' }
		}
		// Dropped or replaced while this was out: do not resurrect it.
		if (generation !== gen || seen.get(workspace)?.gen !== gen) return
		if (out.ok) seen.set(workspace, { lines: clean(out.text), at: now, token, reading: false, failedAt: 0, gen })
		// The last good text is kept: a desk showing slightly old output beats one that
		// blanks itself whenever cmux is busy.
		else seen.set(workspace, { lines: before.lines, at: before.at, token, reading: false, error: out.error, failedAt: now, gen })
	})()
	running.add(job)
	void job.finally(() => running.delete(job))
	return state
}

/** Forget workspaces no longer on screen, or the map grows for the life of a program meant
 *  to run for days — the rule `prune` already follows for held names in settle.ts. */
export function keepOnly(live: Iterable<string>) {
	const keep = new Set(live)
	for (const k of [...seen.keys()]) {
		if (keep.has(k)) continue
		// Deleting is enough, and bumping the GLOBAL generation here was actively wrong: it
		// invalidated the in-flight read of every other workspace too, and this now runs on
		// every frame, so one session leaving the room would throw away everyone's read. A
		// landing read already refuses to write when its entry is gone — `seen.get()` returns
		// undefined and the gen comparison fails — which is exactly the case this is.
		seen.delete(k)
	}
}

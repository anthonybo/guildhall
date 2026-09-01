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

/** Enough to see what a session is doing without being a terminal. */
export const PEEK_LINES = 14

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
				.replace(/[ \t]{3,}/g, '  '),
		)
		.filter((l) => !/^[─│╭╮╰╯┌┐└┘━┃╔╗╚╝═║]+$/.test(l))
	while (lines.length && !lines[lines.length - 1]) lines.pop()
	return lines.slice(-PEEK_LINES)
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
		generation++
		seen.delete(k)
	}
}

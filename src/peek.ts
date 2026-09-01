/**
 * A glance at what a session's screen is showing — cheap enough to do for several.
 *
 * The terminal view reads a full styled grid: colour and exact position for every cell,
 * 58KB, which is right when you are reading one screen and absurd when you want a
 * glimpse of seven. This reads the last few lines as plain text instead: 1KB, measured.
 *
 * THE COST IS THE SPAWN, NOT THE BYTES. Measured on this machine: the styled grid costs
 * 0.09 cpu-s per call and the plain text 0.08, because both are dominated by starting a
 * cmux process. Seven sessions on a two-second poll would be 0.6 cpu-s per round — about
 * a third of a core, continuously, which is the exact shape of the cost this project has
 * a written apology for.
 *
 * So the payload is small and the CALLS are what is rationed:
 *
 *  - a cache with a TTL, because several desks and several clients asking about the same
 *    session must cost one read, not one each
 *  - one read in flight per workspace, so a slow cmux cannot pile up spawns behind it
 *  - nothing here runs on the poll path; `collect()` has a 12 cpu-ms budget and this
 *    would eat it whole
 */
import { readScreen } from './control.ts'

/** Enough to see what a session is doing without being a terminal. */
export const PEEK_LINES = 14

/**
 * How long a glance stays fresh.
 *
 * The room redraws far more often than this. Two seconds matches the terminal view's own
 * poll, which is the fastest anything here reads a screen, and means a room full of
 * desks costs the same as one open terminal rather than one per desk.
 */
const TTL = 2000

type Entry = { at: number; lines: string[]; pending?: Promise<string[]> }

/**
 * How a screen is read.
 *
 * A parameter purely so a test can count the reads without a cmux on the machine — the
 * same seam `liveSessions(dir)` keeps, and for the same reason: what these tests are
 * about is HOW MANY TIMES this is called, which cannot be observed from outside.
 * ESM exports are read-only bindings, so there is nothing to stub in place.
 */
export type Reader = (workspace: string, lines?: number) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

const seen = new Map<string, Entry>()

/** Test seam, and a way for a caller to drop everything when control is turned off. */
export function resetPeek() {
	seen.clear()
}

/** How many workspaces are being remembered, so a leak is visible rather than inferred. */
export const peekSize = () => seen.size

/**
 * The last few lines of a workspace's screen, from cache when it is fresh.
 *
 * Never throws and never returns partial nonsense: a read that fails gives back the last
 * good lines if there are any, and an empty list otherwise. A desk showing slightly old
 * text is better than a desk that goes blank every time cmux is busy.
 */
export async function peek(workspace: string, now = Date.now(), read: Reader = readScreen): Promise<string[]> {
	const had = seen.get(workspace)
	if (had && now - had.at < TTL) return had.lines
	// Already being read. Join that read rather than starting a second one — this is the
	// difference between one spawn per session and one per caller.
	if (had?.pending) return had.pending
	const pending = (async () => {
		const r = await read(workspace, PEEK_LINES)
		let lines: string[]
		if (r.ok) {
			lines = r.text.split('\n').map((l) => l.replace(/\s+$/, ''))
			// Drop the trailing blanks outright. Most of a TUI screen below the prompt is
			// empty, and carrying it means a desk drawing nothing but its own bottom edge.
			while (lines.length && !lines[lines.length - 1]) lines.pop()
			lines = lines.slice(-PEEK_LINES)
		} else {
			lines = seen.get(workspace)?.lines ?? []
		}
		// Stamped with WHEN IT WAS ASKED, not when it came back. Using the wall clock here
		// meant the freshness window could not be reasoned about — a slow read made the
		// entry look newer than the moment it describes, and an injected clock could not
		// see the cache at all.
		seen.set(workspace, { at: now, lines })
		return lines
	})()
	seen.set(workspace, { at: had?.at ?? 0, lines: had?.lines ?? [], pending })
	return pending
}

/**
 * Forget workspaces that are no longer on screen.
 *
 * Called with the set still in use. Without this the map grows for the life of a program
 * meant to run for days — the same rule `prune` follows for held names in settle.ts.
 */
export function keepOnly(live: Iterable<string>) {
	const keep = new Set(live)
	for (const k of seen.keys()) if (!keep.has(k)) seen.delete(k)
}

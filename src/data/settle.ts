/**
 * Keeping a session's name still while its work wanders.
 *
 * A session is named after the project its recent tool calls keep touching. That
 * is the right answer most of the time and a confusing one exactly when it
 * matters: spend an hour in a sibling project and the row silently renames
 * itself, so the session you were talking to appears to vanish and a new one
 * appears in its place. It renames back later, just as quietly.
 *
 * The wandering is real and worth showing — it is just not a change of identity.
 * So the name only moves once the new project has been the winner for a while,
 * and until then the row can say where the work has gone: `guildhall → pressroom`.
 *
 * An earlier attempt anchored the name to where the session STARTED, read from
 * the head of its transcript. Measured against the live sessions here it was
 * useless: these run for days, so it anchored guildhall to `wrenhaven`, willow to
 * `sparrowcreek` and quillfeather to `seedbank` — all true, all long irrelevant.
 * Stale is not the same as stable.
 */

/**
 * How long a new project must stay the winner before it becomes the name.
 *
 * Long enough that a detour to read a sibling's source does not rename anything,
 * short enough that a session which has genuinely moved on settles within a
 * coffee break.
 */
export const HOLD_MS = 10 * 60_000

type Held = { name: string; candidate?: { name: string; since: number } }

const held = new Map<string, Held>()

export type Settled = {
	/** The name to call it. Stable across a detour. */
	name: string
	/** Where the work currently is, when that is somewhere else. */
	away?: string
}

/**
 * The stable name for a session, given what it is touching right now.
 *
 * First sight wins outright — there is no history to be loyal to, and making a
 * fresh session wait ten minutes for a name would be worse than the problem.
 */
export function settle(id: string, current: string, now = Date.now()): Settled {
	const entry = held.get(id)
	if (!entry) {
		held.set(id, { name: current })
		return { name: current }
	}
	if (current === entry.name) {
		// back home before the hold elapsed: the detour is over, forget it happened
		entry.candidate = undefined
		return { name: entry.name }
	}
	if (!entry.candidate || entry.candidate.name !== current) {
		entry.candidate = { name: current, since: now }
		return { name: entry.name, away: current }
	}
	if (now - entry.candidate.since >= HOLD_MS) {
		entry.name = current
		entry.candidate = undefined
		return { name: current }
	}
	return { name: entry.name, away: current }
}

/**
 * Drop sessions that are gone.
 *
 * Without this the map grows for the life of the process — every session ever
 * seen, on a program meant to be left running for days.
 */
export function prune(live: Iterable<string>) {
	const keep = new Set(live)
	for (const id of held.keys()) if (!keep.has(id)) held.delete(id)
}

/** Exposed for the tests: forget everything. */
export function reset() {
	held.clear()
}

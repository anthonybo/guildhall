/**
 * How much work a session has done, and what rank that earns.
 *
 * Kept separate from collection because the weights and the curve are the part
 * most likely to be argued about, and both are anchored to measurements rather
 * than taste. Changing a number here should mean re-checking those measurements.
 */

/**
 * Four signals, weighted by how much each one proves.
 *
 *   commits  25  a delivered milestone — the strongest evidence of finished work
 *   edits     3  a file actually changed
 *   subagents 15 work dispatched and supervised
 *   minutes    1 time genuinely spent working, summed from turn durations
 *
 * Commits are weighted highest but cannot be the base: three of the busiest
 * sessions measured had zero, because commits happen only when asked for, so they
 * measure the operator's instructions rather than the session's work.
 *
 * Active minutes come from per-turn durations, never from wall-clock age — a
 * session left open overnight has done nothing and must score nothing.
 *
 * Token counts are deliberately excluded: most tokens in agentic work go to
 * reading and review rather than production, so counting them repeats the
 * lines-of-code mistake.
 */
export function xpOf(d: { commits?: number; edits?: number; subs?: number; activeMin?: number }) {
	return 25 * (d.commits ?? 0) + 3 * (d.edits ?? 0) + 15 * (d.subs ?? 0) + (d.activeMin ?? 0)
}

/**
 * Level n costs n^3 / 3 XP.
 *
 * Both earlier attempts fitted the curve to a snapshot of the current sessions,
 * which is the wrong anchor: what decides whether a ceiling is reachable is how
 * fast a session accumulates. Measured over real transcript lifetimes, the
 * heaviest session sustained ~572 XP/day. Anchoring to that rate:
 *
 *     1 day -> 11    1 month -> 37    6 months -> 67    ~1.5 years -> 99
 *     1 week -> 22   3 months -> 53   1 year -> 85
 *
 * A cube root is what satisfies both ends — plain n^3 had the right shape and the
 * wrong scale, reading 19 where it should read 27. Dividing by 3 fixes the scale
 * without flattening the curve into the no-headroom quadratic that replaced it.
 */
export const xpForLevel = (n: number) => n ** 3 / 3
export const levelFor = (xp: number) => Math.max(1, Math.min(99, Math.floor(Math.cbrt(xp * 3))))

/**
 * A session in a long turn — subagents, a slow build — legitimately shows a
 * `busy` stamp that is many minutes old, because the registry only writes on a
 * state CHANGE, never as a heartbeat. So `busy` is trusted unless the status
 * stamp AND the transcript have both gone quiet, which is what a session killed
 * mid-turn looks like.
 */
export const ZOMBIE_WINDOW = 45 * 60_000
/** Finished inside this window means the next move is still yours. */
export const DONE_WINDOW = 30 * 60_000

/**
 * Deciding what matters and in what order.
 *
 * Kept free of any node import so the browser client can use the same rules. If
 * "needs you" meant one thing in the terminal and another on the phone, the two
 * would quietly disagree about which session to worry about — which is the one
 * thing both views exist to tell you.
 */
import type { Session } from './types.ts'

/**
 * One function decides what deserves your attention. The gutter marker, the sort
 * tier, the faults filter, the header count and the phone's highlight all read
 * from here, so adding a condition touches exactly one place.
 */
export function needsAttention(s: Session): string | null {
	if (s.state === 'needs') return s.waitingFor ?? 'blocked'
	if (s.ctxUsed / s.ctxLimit > 0.9) return 'context almost full'
	return null
}

/**
 * Two tiers. Only the attention tier floats, and everything else holds a stable
 * order — if rows reshuffled whenever a status changed, the cursor would land on a
 * different session than the one being read. Longest-ignored first within a tier,
 * and session id as the final tiebreak so the order never depends on the name.
 */
export function order(list: Session[]) {
	return [...list].sort((a, b) => {
		const at = needsAttention(a) ? 0 : 1
		const bt = needsAttention(b) ? 0 : 1
		if (at !== bt) return at - bt
		if (a.stale !== b.stale) return b.stale - a.stale
		return a.id.localeCompare(b.id)
	})
}

/**
 * Is there more than one harness in this list?
 *
 * Here rather than in table.ts because the ROOM asks it too, and it is a question
 * about a list of sessions rather than about a table. The rule it serves: a mark that
 * is identical on every row, on every desk, forever, is decoration — it costs a
 * column of the project name in the table and a hue on every monitor in the room, and
 * tells you nothing. Both surfaces show the harness only once there is a harness to
 * tell apart.
 */
export const mixedHarness = (list: Session[]) => new Set(list.map((s) => s.agent ?? 'claude')).size > 1

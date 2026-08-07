/**
 * Deciding whose turn it is.
 *
 * Claude Code's registry reports an instantaneous `status`, which is not the same
 * question. `busy` is written on state CHANGE and never as a heartbeat, so a
 * session killed mid-turn stays `busy` forever; and a session that ended its turn
 * on a question is reported `idle` even though it is waiting on a person. Both of
 * those are the difference between "leave it alone" and "go look at it", so state
 * is derived rather than passed through.
 */
import { DONE_WINDOW, ZOMBIE_WINDOW } from './score.ts'
import type { Digest, State } from './types.ts'

export type Signals = {
	/** the registry's own status: busy | shell | idle | waiting */
	raw: string
	/** how long since the registry last wrote anything about this session */
	stale: number
	/** whether cmux still shows the tab as unread */
	unread: boolean
	/** milliseconds since the newest transcript record, if there is one */
	sinceRecord: number
}

export function stateOf(d: Digest, s: Signals): State {
	// an API error or a failed stop is the only failure the transcript exposes
	if (d.failed) return 'error'
	// the registry says so outright
	if (s.raw === 'waiting') return 'needs'
	// or a question was asked, which the registry never reports as waiting
	if (d.asked && s.raw !== 'busy') return 'needs'

	// Trust `busy` unless BOTH the status stamp and the transcript have gone quiet.
	// A long turn — subagents, a slow build — legitimately shows a stamp many
	// minutes old, and demoting it made a fifteen-minute build read as finished.
	const quiet = Math.min(s.stale, s.sinceRecord) > ZOMBIE_WINDOW
	if (s.raw === 'busy' && !quiet) return 'working'
	if (s.raw === 'shell' && !quiet) return 'shell'

	// cmux knows whether the tab has been looked at, which beats guessing
	// "finished recently" from a clock.
	if (s.unread && s.stale < DONE_WINDOW * 4) return 'review'
	return s.stale < DONE_WINDOW ? 'done' : 'parked'
}

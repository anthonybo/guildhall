/**
 * Everything guildhall knows, assembled.
 *
 * Nothing is installed and no session is instrumented — Claude Code already writes
 * a registry entry per running process and a transcript per session, and cmux
 * already writes its window layout. This module reads those three sources and
 * joins them into one `Session` per live process. The pieces live under `data/`:
 *
 *   registry    which processes are actually running
 *   transcript  finding the live transcript, and lifetime work counters
 *   digest      what a session is doing right now, from the tail
 *   state       whose turn it is
 *   score       how much work has been done, and what rank that earns
 *   describe    turning a tool call into words
 *   cmux        which tab to jump to
 */
import path from 'node:path'
import { assignLooks } from './characters.ts'
import { cmuxMap } from './data/cmux.ts'
import { KIND, doingText, firstSentence, shortText } from './data/describe.ts'
import { digest } from './data/digest.ts'
import { liveSessions } from './data/registry.ts'
import { levelFor, xpOf } from './data/score.ts'
import { prune, settle } from './data/settle.ts'
import { stateOf } from './data/state.ts'
import { transcriptIndex } from './data/transcript.ts'
import type { Digest, Session } from './data/types.ts'

export type { Digest, Registry, Session, State } from './data/types.ts'
export { RANK } from './data/types.ts'
export { levelFor, xpForLevel, xpOf } from './data/score.ts'
export { cut, firstSentence } from './data/describe.ts'
export { transcriptIndex } from './data/transcript.ts'
export { needsAttention, order } from './data/select.ts'
export { liveSessions } from './data/registry.ts'

/** Directories that hold projects rather than being one. */
const CONTAINER = /^(projects|repos|workspace)$/

/**
 * A session started from a container like ~/projects reports "projects" as its
 * name, which tells you nothing when eight of nine share it. Fall back to the
 * directory its own tool calls keep touching.
 */
function projectName(cwd: string, d: Digest, given?: string) {
	const base = path.basename(cwd)
	if (!CONTAINER.test(base)) return base
	// A session that has not touched a subdirectory yet — one opened a minute ago,
	// or one that has only talked — has no tool calls to be named after, and the
	// fallback used to be the container itself. That is the collision this is here
	// to avoid: six sessions in ~/projects all answering to "projects". The
	// registry's own name is dull but unique, which is the property that matters.
	return d.subProj || given || base
}

/**
 * Subagents, in words.
 *
 * "sent out an agent" in the doing column says one went out; it does not say
 * whether four are still running. Worth spelling out, because a session with
 * agents out looks idle from the outside while being the busiest thing here.
 */
function agentsLine(d: Digest) {
	const out = d.pending ?? 0
	const total = d.subs ?? 0
	if (out > 0) return `${out} running now${total ? ` · ${total} dispatched in all` : ''}`
	return total ? `${total} dispatched` : undefined
}

/** Context consumed this turn. Cache reads count — they occupy the window too. */
function contextUsed(d: Digest) {
	const u = d.usage
	if (!u) return 0
	return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

export function collect(): Session[] {
	const idx = transcriptIndex()
	const tabs = cmuxMap()
	const now = Date.now()
	const registry = liveSessions()
	// held names belong to live sessions only, or the map grows for the life of a
	// program meant to be left running for days
	prune(registry.map((s) => s.sessionId))
	// Looks are handed out by index over a stable ordering, so a session keeps the
	// same character for its whole life and no two collide until the sheets run out.
	// Ordered by cwd first, so sessions in the same repo read as one team and match
	// the pod nameplate they sit under.
	const looks = assignLooks(
		[...registry]
			.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.sessionId.localeCompare(b.sessionId))
			.map((s) => s.sessionId),
	)

	const out = registry.map((s) => {
		const file = idx.get(s.sessionId)
		const d: Digest = file ? digest(file) : {}
		const tab = tabs.get(s.sessionId)
		const stale = now - (s.statusUpdatedAt || s.updatedAt || 0)
		const state = stateOf(d, {
			raw: s.status ?? 'idle',
			stale,
			unread: !!tab?.unread,
			sinceRecord: d.lastTs ? now - d.lastTs : Infinity,
		})
		// The name a session answers to must not move because it read a sibling's
		// source for ten minutes — see settle.ts.
		const { name: proj, away } = settle(s.sessionId, projectName(s.cwd, d, s.name))
		const used = contextUsed(d)
		const xp = xpOf(d)

		return {
			id: s.sessionId,
			pid: s.pid,
			// the derived name ("projects-fa") says nothing; the AI title says what the
			// session is actually about, so prefer it wherever there is room
			name: s.name ?? proj,
			proj,
			away,
			cwd: s.cwd,
			state,
			waitingFor: s.waitingFor ?? (d.asked ? 'answer a question' : undefined),
			stale,
			title: d.title || (s.nameSource === 'derived' ? '' : (s.name ?? '')) || proj,
			doing: doingText(d, state, s.waitingFor),
			short: shortText(d, state, s.waitingFor),
			last: firstSentence(d.text),
			ctxUsed: used,
			// crossing the 200k mark is the only visible sign of a 1M-context session
			ctxLimit: used > 190_000 ? 1_000_000 : 200_000,
			tab: tab?.tab,
			workspace: tab?.workspace || undefined,
			unread: !!tab?.unread,
			toolKind: (d.tool && KIND[d.tool]) || 'think',
			turns: d.turns ?? 0,
			agents: agentsLine(d),
			level: levelFor(xp),
			xp: Math.round(xp),
			palette: looks.get(s.sessionId)?.palette ?? 0,
			hueShift: looks.get(s.sessionId)?.hueShift ?? 0,
		}
	})
	return disambiguate(out)
}

/**
 * Give rows that share a name a way to be told apart.
 *
 * A project name is a good label and not an identity: three live sessions can all
 * be `tidepool` — one whose directory it is, and two rooted at the container whose
 * tool calls keep landing there. Three identical rows is a list you cannot act on,
 * and it is not hypothetical; it happened with `pressroom` too.
 *
 * The tab is the discriminator worth showing when there is one — it is what you
 * would actually type to get there. Falling back to the session id's first four
 * characters is dull, but it is the only thing guaranteed to be unique, and a dull
 * unique label beats an elegant ambiguous one.
 *
 * Only set when a name really is shared, so the ordinary one-session-per-project
 * case stays clean.
 */
function disambiguate(list: Session[]): Session[] {
	const counts = new Map<string, number>()
	for (const s of list) counts.set(s.proj, (counts.get(s.proj) ?? 0) + 1)
	for (const s of list) {
		if ((counts.get(s.proj) ?? 0) < 2) continue
		s.distinct = s.tab ? `⌘${s.tab}` : s.id.slice(0, 4)
	}
	return list
}

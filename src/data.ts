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
	// Looks are handed out by index over a stable ordering, so a session keeps the
	// same character for its whole life and no two collide until the sheets run out.
	// Ordered by cwd first, so sessions in the same repo read as one team and match
	// the pod nameplate they sit under.
	const looks = assignLooks(
		[...registry]
			.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.sessionId.localeCompare(b.sessionId))
			.map((s) => s.sessionId),
	)

	return registry.map((s) => {
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
		const proj = projectName(s.cwd, d, s.name)
		const used = contextUsed(d)
		const xp = xpOf(d)

		return {
			id: s.sessionId,
			pid: s.pid,
			// the derived name ("projects-fa") says nothing; the AI title says what the
			// session is actually about, so prefer it wherever there is room
			name: s.name ?? proj,
			proj,
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
}

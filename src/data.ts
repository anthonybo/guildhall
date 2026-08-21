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
import { execFileSync } from 'node:child_process'
import { assignLooks } from './characters.ts'
import { cmuxMap, tabForTty } from './data/cmux.ts'
import { KIND, doingText, firstSentence, shortText } from './data/describe.ts'
import { digest } from './data/digest.ts'
import { liveSessions } from './data/registry.ts'
import { levelFor, xpOf } from './data/score.ts'
import { prune, settle } from './data/settle.ts'
import { stateOf } from './data/state.ts'
import { transcriptIndex } from './data/transcript.ts'
import type { Digest, Registry, Session } from './data/types.ts'
import { codexSessions } from './data/codex.ts'

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
	// Where it WRITES beats where it looks.
	//
	// `subProj` counts every path in every tool call, so a session building one
	// project while reading another's source can be outvoted by the reading. That
	// is not hypothetical: a session writing into `harbor` sat labelled `saltmarsh`
	// for 53 minutes because bursts of reading kept flipping the winner, and each
	// flip restarted settle()'s ten-minute hold, so it could never elapse.
	//
	// Putting files on disk somewhere is working there; reading a sibling's source
	// is a detour. Preferring the write also makes the signal STABLE, which is what
	// actually unsticks the hold — a name that stops oscillating settles on its own.
	if (d.writeProj) return d.writeProj
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

/**
 * Every live session, as the room and the browser see them.
 *
 * `codex` is passed in rather than read from the config here, so this stays free of
 * a file read on a path that runs every two seconds — and so a test can ask for the
 * second harness without writing a config file. Defaulting to false means every
 * existing caller keeps behaving exactly as it did.
 */
export function collect(codex = false): Session[] {
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
	// Codex sessions, or nothing at all when the flag is off — which is the default.
	// Read BEFORE looks are handed out, because their ids have to be appended after
	// the Claude ones: `assignLooks` assigns by index, so sorting them in among the
	// existing sessions would silently change what everybody already looks like.
	const extra = codex ? codexSessions(now) : []
	const looks = assignLooks([
		...[...registry]
			.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.sessionId.localeCompare(b.sessionId))
			.map((s) => s.sessionId),
		...extra.map((s) => s.id),
	])

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
	// `fold` and `pairByTty` are about Claude Code's registry — a session paired with
	// its background jobs by tty — so Codex sessions do not go through them. They do
	// go through `disambiguate`, because two sessions called `guildhall` need telling
	// apart whichever harness they came from.
	const folded = pairByTty(fold(out, registry))
	if (!extra.length) return disambiguate(folded)
	const withLooks = extra.map((s) => ({
		...s,
		palette: looks.get(s.id)?.palette ?? 0,
		hueShift: looks.get(s.id)?.hueShift ?? 0,
	}))
	return disambiguate([...folded, ...withLooks])
}

/**
 * Fold a parked session into the background job that took its conversation.
 *
 * Backgrounding an interactive session does not end it. The terminal process
 * stays alive and gains `parkedJobId`, naming the job that now owns the
 * conversation, and that job runs on under its own pid with its own registry
 * entry. Both are genuinely live, so both were listed — two rows for one
 * conversation. On this machine those were two of the three `tidepool` rows, and
 * the job's transcript carried 962 references to the terminal's session id,
 * which is the handoff made visible: one conversation, copied forward.
 *
 * The job's row is the one kept, because that is where the work now is — the
 * parked terminal's transcript stops dead at the moment of the handoff, so its
 * row would sit there claiming to be working on something it left minutes ago.
 * What the terminal has that the job does not is the cmux tab, so that is carried
 * across; otherwise folding would cost the only way to go and look at it.
 *
 * Linked by job id rather than pid, because a job respawns — it did so mid-
 * investigation, keeping its id and taking a new pid.
 *
 * Only folds when the named job is actually present. If it finished, or never
 * became live, the parked row stays exactly as it was rather than vanishing.
 */
export function fold(list: Session[], registry: Registry[]): Session[] {
	const rowOfJob = new Map<string, string>()
	let anyParked = false
	for (const r of registry) {
		if (r.jobId) rowOfJob.set(r.jobId, r.sessionId)
		if (r.parkedJobId) anyParked = true
	}
	if (!anyParked) return list
	const bySession = new Map(list.map((s) => [s.id, s]))
	const drop = new Set<string>()
	for (const r of registry) {
		if (!r.parkedJobId) continue
		const target = rowOfJob.get(r.parkedJobId)
		if (!target || target === r.sessionId) continue
		const parked = bySession.get(r.sessionId)
		const job = bySession.get(target)
		if (!parked || !job) continue
		if (job.tab === undefined) {
			job.tab = parked.tab
			job.workspace = parked.workspace
			job.unread = parked.unread
			// Say what the tab actually is, because it is two things at once.
			//
			// It DRAWS the job's output and it TYPES into the parked terminal, whose own
			// conversation has stopped — measured on this machine as a parked transcript
			// untouched for 34 minutes beside a job transcript written seconds ago. So a
			// message lands in a box belonging to a conversation that is over, queues,
			// and waits. Nothing about the screen says so, which is why it read as the
			// send having silently failed and got sent again.
			//
			// A warning rather than a refusal. Refusing was shipped first and was worse:
			// it took away the only route to the session and offered nothing instead.
			job.deferred = 'queued — this conversation is running as a background job, and the tab you are typing into is the parked terminal it left behind. It will not be picked up until that job finishes.'
		}
		drop.add(r.sessionId)
	}
	return drop.size ? list.filter((s) => !drop.has(s.id)) : list
}

/**
 * Give a row its tab by looking up the terminal device its process is attached to.
 *
 * The exact answer, for the sessions cmux never recorded as agents. A workspace
 * created from the CLI gets no `terminal.agent` and no `resumeBinding` — measured
 * still empty at 90 seconds — so `cmuxMap` cannot see it and the row arrives with
 * no tab, no terminal button, and nothing to type into.
 *
 * Every panel carries `ttyName`, every Claude process has a tty, and a tty belongs
 * to exactly one terminal. Nothing is inferred and nothing is remembered.
 *
 * Two worse attempts came first and are worth naming so they are not repeated.
 * Matching on the shared DIRECTORY was ambiguous — seven sessions here have
 * `~/projects` as their cwd — and the browser opened whichever had been active
 * most recently, which was an unrelated session mid-conversation, one keystroke
 * away from receiving a message meant for a new one. Remembering the workspace at
 * spawn time was exact but lived in memory, and the dev watcher restarts the
 * server on every source change, so the claim was usually gone before the session
 * appeared.
 */
export function pairByTty(list: Session[]): Session[] {
	const orphans = list.filter((s) => !s.workspace)
	if (!orphans.length) return list
	for (const s of orphans) {
		const at = tabForTty(ttyOf(s.pid))
		if (!at) continue
		s.tab = at.tab
		s.workspace = at.workspace
		s.unread = at.unread
	}
	return list
}

/** The terminal a process is attached to, or '' for one with none — a background
 *  job reports `??` and has no tab to find. */
function ttyOf(pid: number): string {
	try {
		return execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()
	} catch {
		return ''
	}
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

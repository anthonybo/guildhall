import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session, State } from './types.ts'

/**
 * Codex sessions, read from the rollout files it already writes.
 *
 * Files only, no daemon: the app-server's `status` is per-instance, so a freshly
 * spawned one reports `notLoaded` for every thread however live it is, and the shared
 * daemon that does know could not be reached. See docs/codex.md.
 *
 * Two directories carry everything:
 *
 *  - `~/.codex/thread-writer-locks/<id>.lock` exists while the process writing that
 *    thread is alive. This is the registry, the counterpart of
 *    `~/.claude/sessions/<pid>.json`.
 *  - `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` is the transcript, read
 *    head and tail, which says what the thread was doing when it last wrote.
 *
 * Nothing here touches how Claude Code sessions are read, and it returns nothing at
 * all until `codex` is switched on in the config.
 */

const HOME = os.homedir()
/** Resolved per call, not at import, so a test can point them anywhere. */
const dir = () => process.env.GUILDHALL_CODEX_DIR || path.join(HOME, '.codex', 'sessions')
const lockDir = () => process.env.GUILDHALL_CODEX_LOCKS || path.join(HOME, '.codex', 'thread-writer-locks')

/**
 * How recently a rollout must have been written to count, when there is no lock
 * directory to ask. A fallback only, for an older Codex that writes no locks.
 */
const RECENT_MS = 6 * 60 * 60 * 1000

/**
 * How long a LOCKED thread may go unwritten before the lock is treated as stale.
 *
 * A lock is an open file descriptor, so a clean exit removes it — but macOS does not
 * unlink on close, so a SIGKILL leaves the file behind, and without a bound one
 * crashed session is a worker that sits in the room forever. The Claude path has
 * `isAlive(pid)` for this; a rollout names no process, so a generous age is what there
 * is. A day: long enough that a session left open overnight is still a session, short
 * enough that a crash clears by the next morning.
 */
const STALE_LOCK_MS = 24 * 60 * 60 * 1000

/** Nothing written for this long, with no turn marker to go on, is not working. */
const IDLE_MS = 10 * 60 * 1000

/**
 * How much of the end of the file to read.
 *
 * Measured over the real corpus: records are p50 526 B, p90 2.75 KB, p99 14.5 KB, so
 * 64KB usually holds the last several. But 38 records there exceed 64KB and the largest
 * is 2.9 MB, and a final record bigger than the window used to erase every field — the
 * partial line is dropped and nothing else is in the buffer. So a read that comes back
 * with nothing usable retries once, much larger.
 */
const TAIL_BYTES = 65_536
const TAIL_RETRY_BYTES = 4 << 20

/** The header is one line: 246–470 bytes across the real corpus, so this is ample. */
const HEAD_BYTES = 8_192

/** A rollout that has not grown cannot have changed. Same trick as digest.ts. */
const cache = new Map<string, { size: number; r: Rollout }>()

/**
 * Where each thread's rollout file is, remembered across polls.
 *
 * This is what makes the steady state free. Bounding the walk to stop once every live
 * thread is found helped — 22.36 cpu-ms down to 9.14 at 2000 rollouts — but not enough,
 * because a session started months ago has its file in a months-old directory, so
 * finding it still means walking past everything newer. Codex names a rollout for the
 * date the session STARTED, not the date it last wrote, so no date pruning is safe for
 * exactly the long-lived sessions worth showing.
 *
 * Knowing the path already, a poll is one readdir of the lock directory and one stat
 * per live thread. The walk happens only when a lock appears whose file we have not
 * located yet.
 */
const pathOf = new Map<string, string>()

/**
 * Locks whose rollout file could not be found, and when we last looked.
 *
 * One orphaned lock used to cost a full history walk on every poll, forever: the walk
 * stops when every wanted id is found, an id with no file is never found, and a lock
 * file does not expire. Measured at 1344 rollouts — 0.37 cpu-ms with every lock
 * resolved, 18.82 with one orphan, against a 12 cpu-ms budget for the entire poll. The
 * same thing happens to EVERY lock at once if Codex ever nests rollouts deeper than
 * `YYYY/MM/DD`, which is precisely the "the tool changed its layout under us" case this
 * project has been bitten by before.
 *
 * So a failure to locate is remembered, and retried occasionally rather than
 * relentlessly — a real session's file appears within moments of its lock, and anything
 * that has not shown up in a minute is not about to.
 */
const unfound = new Map<string, number>()
const UNFOUND_RETRY_MS = 60_000

/**
 * The last full listing, for the fallback path only.
 *
 * With no lock directory there is no set of ids to look for, so the walk cannot stop
 * early: measured at 52 cpu-ms over 2000 rollouts, which is four times the entire poll
 * budget. That path only exists for a Codex old enough not to write locks, so it is
 * amortised rather than optimised — recomputed at most every half minute instead of
 * every two seconds.
 */
let listing: { at: number; found: Found[] } | null = null
const LISTING_TTL = 30_000

type Found = { file: string; size: number; mtime: number; id: string }

/**
 * Turns seen per thread, which only ever goes up.
 *
 * `turns` is counted from the TAIL, so a long turn can push earlier endings out of the
 * window and the count would fall — measured going 3, then 3, then 0. A number beside a
 * session that decreases is worse than no number, and this column is shared with the
 * Claude side where it is an authoritative lifetime figure.
 */
const seenTurns = new Map<string, number>()

/** What one rollout file yields, before it becomes a Session. */
type Rollout = {
	id: string
	cwd: string
	/** a turn is open: a start with no ending after it */
	busy: boolean
	/** whether the window held any turn marker at all, so state can fall back honestly */
	decided: boolean
	ctxUsed: number
	ctxLimit: number
	turns: number
	text: string
	tool: string
}

/**
 * Thread ids whose writing process is alive.
 *
 * `null` means there is no registry to consult — an older Codex — and the caller falls
 * back to file age. An unreadable directory is NOT that case: it returns an empty set,
 * so nothing is live, because widening the set of remotely-writable sessions on a
 * permissions error is the wrong direction to fail in.
 */
function liveThreads(at: string): Set<string> | null {
	let names: string[]
	try {
		names = fs.readdirSync(at)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
		return new Set()
	}
	const out = new Set<string>()
	for (const n of names) {
		// `.coordination.lock` lives here and is not a thread.
		if (n.startsWith('.') || !n.endsWith('.lock')) continue
		out.add(n.slice(0, -'.lock'.length).toLowerCase())
	}
	return out
}

const ID_IN_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Rollout files, newest first, stopping once every live thread is accounted for.
 *
 * The walk is the whole cost of this module, and it used to visit every rollout ever
 * written, on every poll, before liveness was consulted. Measured: 3.91 cpu-ms at 45
 * files, 10.46 at 500, 22.36 at 2000 — against a 12 cpu-ms budget for the entire poll,
 * with one live thread throughout. Codex never deletes rollouts, so that is a feature
 * which works for a month and then does not.
 *
 * The lock directory already names the answer, so this looks for those ids and stops.
 * Directories are visited newest-first by NAME: the tree is YYYY/MM/DD, so lexical
 * order is chronological and no stat is needed to sort it.
 */
function files(at: string, want: Set<string> | null): Found[] {
	const out: Found[] = []
	// Nothing is live and there IS a registry: no file is worth opening, so do not walk
	// at all. This is the common case for anybody not running Codex this minute.
	if (want && want.size === 0) return out

	const found = new Set<string>()
	const entries = (p: string) => {
		try {
			return fs.readdirSync(p, { withFileTypes: true })
		} catch {
			return []
		}
	}
	const walk = (from: string, depth: number): boolean => {
		const es = entries(from)
		for (const e of es) {
			if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
			const id = ID_IN_NAME.exec(e.name)?.[1]?.toLowerCase()
			if (!id) continue
			if (want && !want.has(id)) continue
			const full = path.join(from, e.name)
			try {
				const st = fs.statSync(full)
				out.push({ file: full, size: st.size, mtime: st.mtimeMs, id })
			} catch {
				continue // vanished between readdir and stat, which is normal here
			}
			found.add(id)
			// Every live thread accounted for: stop, however much history is left.
			if (want && found.size >= want.size) return true
		}
		if (depth >= 3) return false
		const dirs = es.filter((e) => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))
		for (const d of dirs) {
			if (walk(path.join(from, d.name), depth + 1)) return true
		}
		return false
	}
	walk(at, 0)
	return out
}

/** The window, parsed. Separate so it can be retried larger. */
function scan(fd: number, size: number, id: string, cwd: string, window: number): Rollout | null {
	const from = Math.max(0, size - window)
	const buf = Buffer.alloc(size - from)
	const got = fs.readSync(fd, buf, 0, buf.length, from)
	const lines = buf.subarray(0, got).toString('utf8').split('\n')
	// Drop the partial line at the front, unless the whole file was read. A multi-byte
	// character split by the window boundary is always inside this discarded line.
	if (from > 0) lines.shift()

	let started = -1
	let ended = -1
	let ctxUsed = 0
	let ctxLimit = 0
	let turns = 0
	let text = ''
	let tool = ''
	for (const [i, line] of lines.entries()) {
		if (!line) continue
		let rec: { type?: string; payload?: Record<string, unknown> }
		try {
			rec = JSON.parse(line)
		} catch {
			continue
		}
		const p = rec.payload ?? {}
		const kind = typeof p.type === 'string' ? p.type : (rec.type ?? '')
		if (kind === 'task_started') started = i
		if (kind === 'task_complete' || kind === 'turn_aborted') {
			ended = i
			turns++
			// A turn that has ended is not running a tool. Without this, 18 of the 20
			// finished sessions on this machine reported `doing: "running shell"`.
			tool = ''
		}
		if (kind === 'token_count') {
			const info = (p.info ?? {}) as Record<string, unknown>
			// `last_token_usage`, NOT `total_token_usage`: the total accumulates across
			// compactions and reported one real session at nine times its window.
			const live = (info.last_token_usage ?? {}) as Record<string, unknown>
			if (typeof live.total_tokens === 'number') ctxUsed = live.total_tokens
			if (typeof info.model_context_window === 'number') ctxLimit = info.model_context_window
		}
		if (kind === 'agent_message' && typeof p.message === 'string') text = p.message
		if (kind === 'custom_tool_call' || kind === 'function_call') {
			const name = p.name ?? p.tool
			if (typeof name === 'string') tool = name
		}
	}
	return { id, cwd, busy: started > ended, decided: started >= 0 || ended >= 0, ctxUsed, ctxLimit, turns, text, tool }
}

/** Read the header line and the window, and pull out only what a Session needs. */
function read(file: string, size: number, wantId: string): Rollout | null {
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		// An IO failure, not a verdict about the file. Returning null is right; CACHING it
		// would not be — see the caller.
		return null
	}
	try {
		const head = Buffer.alloc(Math.min(HEAD_BYTES, size))
		const readHead = fs.readSync(fd, head, 0, head.length, 0)
		const firstLine = head.subarray(0, readHead).toString('utf8').split('\n')[0] ?? ''
		let meta: Record<string, unknown> = {}
		try {
			meta = (JSON.parse(firstLine).payload ?? {}) as Record<string, unknown>
		} catch {
			return null // truncated, empty, or an older format with no payload wrapper
		}
		const cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
		if (!cwd) return null
		// The id that decides liveness is the one in the FILENAME; the one in the header
		// is what a send would address. They agree across all 45 real rollouts, and if
		// they ever disagree this would prove one thread alive and then type into another.
		// So the filename wins and a mismatch is dropped rather than guessed at.
		const inner = typeof meta.id === 'string' ? meta.id.toLowerCase() : ''
		if (inner && inner !== wantId) return null

		let r = scan(fd, size, wantId, cwd, TAIL_BYTES)
		// Nothing usable came back and the file is bigger than the window: the final
		// record is larger than the window. One retry, much larger.
		if (r && !r.decided && r.ctxLimit === 0 && !r.text && size > TAIL_BYTES) {
			r = scan(fd, size, wantId, cwd, TAIL_RETRY_BYTES)
		}
		return r
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * What the session is doing.
 *
 * From the TURN MARKERS, not from the type of the last record. Matching the final
 * record was wrong for 23 of the 45 real rollouts here — over half — because a turn
 * commonly ends on `message`, `token_count` or `function_call_output` rather than on
 * `task_complete`, and every one of those read as "working" and then "parked".
 * `task_started` against `task_complete`/`turn_aborted` is unambiguous wherever the
 * markers appear at all: measured over the corpus, 27 files decidable, 0 contradictory.
 */
function stateOf(r: Rollout, stale: number): State {
	if (r.decided) return r.busy ? (stale > IDLE_MS ? 'parked' : 'working') : 'done'
	// No marker in the window: an older format, or a turn whose start is further back
	// than the retry window. Age is all there is.
	return stale > IDLE_MS ? 'done' : 'working'
}

/** First sentence, so a long message does not become the whole row. */
function firstSentence(s: string): string {
	const t = s.trim().replace(/\s+/g, ' ')
	const stop = t.search(/[.!?](\s|$)/)
	return stop > 0 ? t.slice(0, stop + 1) : t.slice(0, 120)
}

/**
 * Codex sessions as this program's own shape.
 *
 * `palette` and `hueShift` are left at zero and filled in by the caller: `assignLooks`
 * hands them out by index, so Codex ids have to be appended after the Claude ones
 * rather than sorted in among them.
 */
/**
 * The rollout file for every thread worth reading, walking only when it must.
 */
function discover(at: string, live: Set<string> | null, now: number): Found[] {
	if (!live) {
		// No registry. Full walk, amortised.
		if (!listing || now - listing.at > LISTING_TTL) listing = { at: now, found: files(at, null) }
		return listing.found
	}
	if (live.size === 0) return []
	const out: Found[] = []
	const missing = new Set(live)
	for (const id of live) {
		const known = pathOf.get(id)
		if (!known) continue
		try {
			const st = fs.statSync(known)
			out.push({ file: known, size: st.size, mtime: st.mtimeMs, id })
			missing.delete(id)
		} catch {
			// The file moved or went away; fall through to the walk and re-learn it.
			pathOf.delete(id)
		}
	}
	// Do not go looking again for something that was not there a moment ago.
	for (const id of [...missing]) {
		const looked = unfound.get(id)
		if (looked !== undefined && now - looked < UNFOUND_RETRY_MS) missing.delete(id)
	}
	if (missing.size) {
		const got = files(at, missing)
		for (const f of got) {
			pathOf.set(f.id, f.file)
			unfound.delete(f.id)
			out.push(f)
		}
		const found = new Set(got.map((f) => f.id))
		for (const id of missing) if (!found.has(id)) unfound.set(id, now)
	}
	// Forget threads that are no longer live, or this grows for the life of the process.
	for (const id of pathOf.keys()) if (!live.has(id)) pathOf.delete(id)
	for (const id of unfound.keys()) if (!live.has(id)) unfound.delete(id)
	return out
}

export function codexSessions(now = Date.now(), at = dir(), locks = lockDir()): Session[] {
	const live = liveThreads(locks)
	const out: Session[] = []
	const keep = new Set<string>()
	for (const f of discover(at, live, now)) {
		if (live) {
			// A lock with nothing written for a day is a crashed process, not a session.
			if (now - f.mtime > STALE_LOCK_MS) continue
		} else if (now - f.mtime > RECENT_MS) {
			continue
		}
		const hit = cache.get(f.file)
		let r: Rollout | null
		if (hit && hit.size === f.size) {
			r = hit.r
		} else {
			r = read(f.file, f.size, f.id)
			// Only a SUCCESSFUL read is cached. Caching a failure keyed on (path, size)
			// made a transient EACCES permanent: an idle session's file never changes size
			// again, so one unreadable moment hid it for the life of the process.
			if (r) cache.set(f.file, { size: f.size, r })
		}
		if (!r) continue
		keep.add(f.file)
		// Rounded, because every other session's `stale` is an integer and the stream's
		// "has anything changed" guard strips `"stale":\d+` — a fractional millisecond
		// from `mtimeMs` survives that strip and stays in the compared string. It happens
		// to be constant per file today, so it does not currently cause a push per tick,
		// but "the guard matches by arithmetic accident" is the exact shape of the 8KB
		// every-two-seconds bug already in MISTAKES.md.
		const stale = Math.round(now - f.mtime)
		const state = stateOf(r, stale)
		const proj = path.basename(r.cwd) || 'codex'
		// Monotonic: the tail-scoped count falls as the window slides.
		const turns = Math.max(r.turns, seenTurns.get(r.id) ?? 0)
		seenTurns.set(r.id, turns)
		out.push({
			id: r.id,
			// No pid: a rollout does not name the process that wrote it, and there is no
			// registry to ask. Nothing in the room needs one for a session it cannot focus.
			pid: 0,
			name: proj,
			proj,
			cwd: r.cwd,
			state,
			stale,
			title: firstSentence(r.text) || proj,
			doing: r.tool ? `running ${r.tool}` : state === 'working' ? 'working' : '',
			short: r.tool || (state === 'working' ? 'working' : ''),
			last: firstSentence(r.text),
			ctxUsed: r.ctxUsed,
			ctxLimit: r.ctxLimit || 200_000,
			// No tab and no workspace: a Codex session is not a cmux pane, so the room must
			// not offer to focus it. Both are optional for exactly this reason.
			unread: false,
			// `toolKind` drives the monitor tint and its vocabulary is Claude's tool names,
			// so there is nothing honest to map a Codex tool onto yet. `think` is the neutral
			// tint rather than a claim about what the session is doing.
			toolKind: 'think',
			turns,
			// Level and XP come from Claude's transcript ledger — messages, tool calls and
			// tokens accumulated over a session's life. Nothing equivalent is read here, so
			// these are a floor rather than a measurement: the badge on a Codex worker means
			// "unranked", not "rank one".
			level: 1,
			xp: 0,
			palette: 0,
			hueShift: 0,
			agent: 'codex',
		})
	}
	// Drop entries for files that are no longer live. `collect()` prunes its own map for
	// the same reason: this program is left running for days, and each entry holds a
	// message body.
	for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k)
	const ids = new Set(out.map((s) => s.id))
	for (const k of seenTurns.keys()) if (!ids.has(k)) seenTurns.delete(k)

	// Stable order: by project then id, NOT by mtime.
	//
	// `assignLooks` assigns sprites by index, so an mtime order meant two live Codex
	// workers swapped appearance every time the other one wrote a line. The Claude side
	// sorts by cwd then id for exactly this reason.
	return out.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id))
}

/** Only for tests, which need each case to start from nothing. */
export function resetCodexCache() {
	cache.clear()
	seenTurns.clear()
	pathOf.clear()
	unfound.clear()
	listing = null
}

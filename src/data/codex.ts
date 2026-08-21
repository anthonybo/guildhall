import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session, State } from './types.ts'

/**
 * Codex sessions, read from the rollout files it already writes.
 *
 * Phase 1 of docs/codex.md: files only, no daemon, and off unless asked for. The
 * app-server is the better source — its thread status IS this program's state model,
 * already computed — but it is not auto-started and is not running on the machine
 * this was written on, so the file path is the floor rather than a stopgap.
 *
 * Nothing here touches how Claude Code sessions are read. The one call site in
 * `collect()` concatenates whatever this returns, which is nothing at all until
 * `codex` is switched on in the config.
 */

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. */
const HOME = os.homedir()
export const CODEX_DIR = process.env.GUILDHALL_CODEX_DIR || path.join(HOME, '.codex', 'sessions')

/**
 * Codex's own registry, which it turns out to have had all along.
 *
 * `~/.codex/thread-writer-locks/<thread-id>.lock` exists while the process writing
 * that thread is alive. Observed against a live session: the lock appeared with the
 * thread, stayed put while the session sat idle at a prompt with `task_complete` as
 * its last record, and the two five-hour-old threads beside it had no lock at all.
 *
 * That makes it the exact counterpart of `~/.claude/sessions/<pid>.json` — which
 * settles the hard part of this whole exercise. The plan assumed no agent CLI but
 * Claude Code writes a live registry, and went looking for one in the app-server
 * instead: a JSON-RPC daemon whose status turned out to be per-instance, so a
 * freshly spawned one reports `notLoaded` for everything and answers nothing. This is
 * one readdir of a directory with a handful of entries.
 *
 * `.coordination.lock` sits beside them and is not a thread, which is why dotfiles
 * are skipped rather than parsed.
 */
const LOCK_DIR = process.env.GUILDHALL_CODEX_LOCKS || path.join(HOME, '.codex', 'thread-writer-locks')

/**
 * How recently a rollout must have been written to count, when there is no lock
 * directory to ask.
 *
 * Only a fallback now. An older Codex without the lock directory leaves us guessing
 * from mtime, and six hours is long enough that a session left sitting still appears
 * while a directory holding months of history does not fill the room. Where the locks
 * exist they decide instead, and age stops mattering: a locked thread is live however
 * long ago it last wrote, and an unlocked one is gone however recently it did.
 */
const RECENT_MS = 6 * 60 * 60 * 1000

/** Thread ids whose writing process is still alive, or null if there is no registry. */
function liveThreads(dir: string): Set<string> | null {
	let names: string[]
	try {
		names = fs.readdirSync(dir)
	} catch {
		return null
	}
	const out = new Set<string>()
	for (const n of names) {
		if (n.startsWith('.') || !n.endsWith('.lock')) continue
		out.add(n.slice(0, -'.lock'.length))
	}
	return out
}

/**
 * How much of the end of the file to read.
 *
 * Records average about 7KB, so this holds roughly nine of them — enough to find the
 * last token count and what the session was last doing. Measured: parsing all 44
 * rollouts in full costs 849 cpu-ms, against a 12 cpu-ms budget for the entire poll.
 * The tail plus the cache below is what makes this affordable at 0.20 cpu-ms once
 * nothing is changing.
 */
const TAIL_BYTES = 65_536

/** The header is one line and small — 246 to 470 bytes across the files here. */
const HEAD_BYTES = 65_536

/** A rollout that has not grown cannot have changed. Same trick as digest.ts. */
const cache = new Map<string, { size: number; r: Rollout | null }>()

/** What one rollout file yields, before it becomes a Session. */
type Rollout = {
	id: string
	cwd: string
	/** The last record's `payload.type`, which is what state is read from. */
	last: string
	/** Tokens in the live context, not the lifetime total. See `read()`. */
	ctxUsed: number
	ctxLimit: number
	turns: number
	/** Newest text the session produced, for the title line. */
	text: string
	tool: string
	mtime: number
}

/**
 * Every rollout file under the date tree, newest first.
 *
 * The WALK is not cached, only the parsing is, and that shows up in the measurement:
 * `collect()` costs 3.74 cpu-ms with this off and 5.58 with it on, for four Codex
 * sessions among 44 rollout files — so about 1.8ms, most of it readdir rather than
 * reading. Against a 12 cpu-ms budget that is affordable and it is written down here
 * so the next person does not have to rediscover where it went. Caching the listing
 * against the directory's own mtime is the obvious next move if it ever matters.
 */
function files(dir: string): { file: string; size: number; mtime: number }[] {
	const out: { file: string; size: number; mtime: number }[] = []
	// Three levels of YYYY/MM/DD. `withFileTypes` so this is one syscall per level
	// rather than a stat per entry.
	const walk = (at: string, depth: number) => {
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(at, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			const full = path.join(at, e.name)
			if (e.isDirectory()) {
				if (depth < 3) walk(full, depth + 1)
				continue
			}
			if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
			try {
				const s = fs.statSync(full)
				out.push({ file: full, size: s.size, mtime: s.mtimeMs })
			} catch {
				// vanished between readdir and stat, which is normal in a live directory
			}
		}
	}
	walk(dir, 0)
	return out.sort((a, b) => b.mtime - a.mtime)
}

/** Read the header line and the tail, and pull out only what a Session needs. */
function read(file: string, size: number, mtime: number): Rollout | null {
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		return null
	}
	try {
		const head = Buffer.alloc(Math.min(HEAD_BYTES, size))
		fs.readSync(fd, head, 0, head.length, 0)
		const firstLine = head.toString('utf8').split('\n')[0] ?? ''
		let meta: Record<string, unknown> = {}
		try {
			meta = (JSON.parse(firstLine).payload ?? {}) as Record<string, unknown>
		} catch {
			// Not a session_meta first line. An empty or truncated file looks like this,
			// and there is nothing to show for it.
			return null
		}
		const id = typeof meta.id === 'string' ? meta.id : ''
		const cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
		if (!id || !cwd) return null

		const from = Math.max(0, size - TAIL_BYTES)
		const tail = Buffer.alloc(size - from)
		fs.readSync(fd, tail, 0, tail.length, from)
		// Drop the partial line at the front unless we read the whole file.
		const lines = tail.toString('utf8').split('\n')
		if (from > 0) lines.shift()

		let last = ''
		let ctxUsed = 0
		let ctxLimit = 0
		let turns = 0
		let text = ''
		let tool = ''
		for (const line of lines) {
			if (!line) continue
			let rec: { type?: string; payload?: Record<string, unknown> }
			try {
				rec = JSON.parse(line)
			} catch {
				continue
			}
			const p = rec.payload ?? {}
			const kind = typeof p.type === 'string' ? p.type : (rec.type ?? '')
			if (kind) last = kind
			if (kind === 'token_count') {
				const info = (p.info ?? {}) as Record<string, unknown>
				// `last_token_usage`, NOT `total_token_usage`.
				//
				// The total is cumulative across compactions: it reports one session on
				// this machine at 977% of its window, where the per-turn figure gives 68%.
				// A context bar built on the obvious field is wrong by construction.
				const live = (info.last_token_usage ?? {}) as Record<string, unknown>
				if (typeof live.total_tokens === 'number') ctxUsed = live.total_tokens
				if (typeof info.model_context_window === 'number') ctxLimit = info.model_context_window
			}
			if (kind === 'task_complete') turns++
			if (kind === 'agent_message' && typeof p.message === 'string') text = p.message
			if (kind === 'custom_tool_call' || kind === 'function_call') {
				const name = p.name ?? p.tool
				if (typeof name === 'string') tool = name
			}
		}
		return { id, cwd, last, ctxUsed, ctxLimit, turns, text, tool, mtime }
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * What the session is doing, from the last record.
 *
 * Deliberately coarse. The rollout says what happened, not what is happening, so
 * anything finer than this would be invention — `thread/status/changed` is what
 * gives the real answer, in phase 3.
 */
function stateOf(last: string, stale: number): State {
	if (last === 'error' || last === 'stream_error') return 'error'
	if (last === 'task_complete' || last === 'turn_aborted') return 'done'
	// Still mid-turn, but nothing has been written for a while: the process is
	// probably gone and nobody closed the turn.
	if (stale > 10 * 60 * 1000) return 'parked'
	return 'working'
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
 * `palette` and `hueShift` are left at zero and filled in by the caller, which is
 * the only way existing sessions keep the looks they already have: `assignLooks`
 * hands them out by index, so Codex ids have to be appended after the Claude ones
 * rather than sorted in among them.
 */
export function codexSessions(now = Date.now(), dir = CODEX_DIR, lockDir = LOCK_DIR): Session[] {
	const live = liveThreads(lockDir)
	const out: Session[] = []
	for (const f of files(dir)) {
		// The thread id is in the filename, so liveness is decided before the file is
		// opened — which is what keeps this to a readdir and a stat for the many
		// finished threads sitting in the directory.
		const id = /-([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(path.basename(f.file))?.[1]
		if (live) {
			if (!id || !live.has(id)) continue
		} else if (now - f.mtime > RECENT_MS) {
			// No lock directory: fall back to the age guess.
			continue
		}
		const hit = cache.get(f.file)
		let r: Rollout | null
		if (hit && hit.size === f.size) {
			r = hit.r
		} else {
			r = read(f.file, f.size, f.mtime)
			cache.set(f.file, { size: f.size, r })
		}
		if (!r) continue
		const stale = now - r.mtime
		const state = stateOf(r.last, stale)
		const proj = path.basename(r.cwd) || 'codex'
		out.push({
			id: r.id,
			// No pid: a rollout file does not name the process that wrote it, and there
			// is no registry to ask. Phase 3 gets this from the app-server, or not at
			// all — nothing in the room needs it for a session it cannot focus.
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
			// Codex reports its own window rather than leaving it to be guessed, so this
			// is the reported number and not a pair of magic constants.
			ctxLimit: r.ctxLimit || 200_000,
			// No tab and no workspace: a Codex session is not a cmux pane, so the room
			// must not offer to focus it. Both are optional for exactly this reason.
			unread: false,
			toolKind: 'think',
			turns: r.turns,
			level: 1,
			xp: 0,
			palette: 0,
			hueShift: 0,
			agent: 'codex',
		})
	}
	return out
}

/** Only for tests, which need each case to start from nothing. */
export function resetCodexCache() {
	cache.clear()
}

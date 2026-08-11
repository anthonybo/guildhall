/**
 * Which Claude Code sessions are actually running.
 *
 * The registry is a directory of `<pid>.json` files that Claude Code writes on
 * every state change. A file outliving its process is normal — a crash leaves one
 * behind — so liveness is checked against the OS, and a recycled PID is caught by
 * comparing start times.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { SESS_DIR } from './paths.ts'
import { agentSessions, refreshAgents } from './agents.ts'
import type { Registry } from './types.ts'

/**
 * Job ids already known to own real work, so the check below runs once per job
 * instead of once per poll. A job never reverts to being a spare — claiming one
 * rewrites its registry entry with a fresh job id — so caching only the positive
 * answer cannot go stale.
 */
const startedJobs = new Set<string>()

/**
 * A pre-warmed background process that no job has claimed yet.
 *
 * The daemon keeps a spare Claude Code running so that starting a background job
 * feels instant. On this machine that spare writes a registry entry that looks
 * exactly like a session's — a pid, a sessionId, a cwd, `kind: "bg"` — but nobody
 * asked for it, it holds no conversation, and `claude agents --json` does not list
 * it. Left in, it is a permanently idle row named after its own job id, sitting in
 * whichever project the spare happened to inherit.
 *
 * **Not argv.** A spare that HAS been claimed still shows `claude bg-spare …` as
 * its command line for the rest of its life, because argv is fixed at exec. While
 * this was written the busiest session in the room was running under exactly that
 * command line — a real job the daemon logged as `bg claimed-spare 6bb3d548` —
 * next to a genuine spare whose argv looked like an ordinary session. Sniffing the
 * command line gets both of them backwards.
 *
 * The signal used instead is the job directory Claude Code writes per background
 * job: `~/.claude/jobs/<jobId>/` gains `timeline.jsonl` and `state.json` once the
 * job owns work, and a spare's gains neither. Checked against the supported
 * lookup on this machine: the jobs with those files are exactly the ones
 * `claude agents --json` reports, and the one without is exactly the one it omits.
 *
 * Every clause has to agree before anything is dropped, because a missing session
 * is invisible while a spurious one is merely annoying. A job that has been named,
 * or is doing anything at all, is kept whatever is on disk. That leaves one gap,
 * deliberately: for the few seconds between a job being spawned and its timeline
 * appearing (measured at 9s here) a brand-new job is indistinguishable from a
 * spare by any signal that exists, so it stays hidden until it writes something.
 * It then appears and never disappears again.
 */
function isSpare(d: Registry, jobsDir: string): boolean {
	if (d.kind !== 'bg' || !d.jobId) return false
	if (startedJobs.has(d.jobId)) return false
	const known = () => {
		startedJobs.add(d.jobId as string)
		return false
	}
	// a job is auto-named within a turn or two; a spare answers to its own id forever
	if (d.name && d.name !== d.jobId) return known()
	// and a spare has nothing to be busy about
	if (d.status && d.status !== 'idle') return known()
	const dir = path.join(jobsDir, d.jobId)
	if (fs.existsSync(path.join(dir, 'timeline.jsonl')) || fs.existsSync(path.join(dir, 'state.json'))) return known()
	return true
}

/** EPERM means the process exists but belongs to someone else — still alive. */
const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/**
 * Process start times, so a recycled PID can't masquerade as a live session.
 *
 * Cached per PID for the life of the run: a process's start time is fixed, and
 * `ps -o lstart` costs 161ms for ten PIDs — by far the most expensive thing in a
 * poll that runs every two seconds. Only genuinely new PIDs are ever looked up,
 * so a steady set of sessions costs nothing. Liveness is separate and free
 * (`kill(pid, 0)`), so a process that exits is still noticed immediately.
 */
const startCache = new Map<number, string>()

function procStarts(pids: number[]) {
	const found = new Map<number, string>()
	if (!pids.length) return found
	for (const p of pids) {
		const hit = startCache.get(p)
		if (hit !== undefined) found.set(p, hit)
	}
	const missing = pids.filter((p) => !startCache.has(p))
	if (!missing.length) return found
	try {
		const out = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', missing.join(',')], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		for (const line of out.split('\n')) {
			const t = line.trim()
			if (!t) continue
			const sp = t.indexOf(' ')
			const pid = Number(t.slice(0, sp))
			const started = t.slice(sp + 1).trim()
			found.set(pid, started)
			startCache.set(pid, started)
		}
	} catch {}
	// a PID `ps` did not report is gone; remember that too, or every poll re-asks
	for (const p of missing) if (!found.has(p)) startCache.set(p, '')
	return found
}

/**
 * Registry entries whose process is running and is the one that wrote them.
 *
 * Falls back to `claude agents --json` when this comes back with nothing — see
 * agents.ts for why the supported call is the fallback and not the primary. An
 * empty answer is exactly the shape the expected failure takes: the directory
 * moved, or the file schema changed and every entry was discarded as malformed.
 * "Nothing is running" produces the same empty answer and costs only a
 * background lookup to confirm.
 */
export function liveSessions(dir = SESS_DIR): Registry[] {
	const found = fromFiles(dir)
	if (found.length) return found
	refreshAgents()
	return agentSessions() ?? []
}

/** `dir` is a parameter purely so a test can point it at nothing and watch the
 *  fallback take over, without an environment variable or a real registry. */
function fromFiles(dir: string): Registry[] {
	let files: string[] = []
	try {
		files = fs.readdirSync(dir)
	} catch {
		return []
	}
	const found: Registry[] = []
	// jobs sit beside sessions in the same tree, so a test can point both at a fixture
	const jobsDir = path.join(dir, '..', 'jobs')
	for (const f of files) {
		if (!/^\d+\.json$/.test(f)) continue
		try {
			const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Registry
			// the supported lookup already omits spares, so this is the file path's job alone
			if (d.pid && !isSpare(d, jobsDir) && isAlive(d.pid)) found.push(d)
		} catch {}
	}
	const starts = procStarts(found.map((d) => d.pid))
	return found.filter((d) => {
		const lstart = starts.get(d.pid)
		if (!lstart) return true // ps said nothing; do not drop a session over it
		const psEpoch = Date.parse(lstart) // ps prints local time
		// procStart is stamped in UTC, so never string-compare the two. startedAt
		// is a plain epoch and needs no timezone reasoning at all.
		const fileEpoch = d.startedAt || Date.parse(`${d.procStart} UTC`)
		if (!psEpoch || !fileEpoch || Number.isNaN(psEpoch) || Number.isNaN(fileEpoch)) return true
		return Math.abs(psEpoch - fileEpoch) < 5 * 60_000
	})
}

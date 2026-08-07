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
	for (const f of files) {
		if (!/^\d+\.json$/.test(f)) continue
		try {
			const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Registry
			if (d.pid && isAlive(d.pid)) found.push(d)
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

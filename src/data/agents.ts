/**
 * The supported way to ask which sessions exist: `claude agents --json`.
 *
 * This is a fallback rather than the primary source, and the reason is measured
 * on this machine: the CLI takes ~730ms per call, while reading the registry
 * directory takes ~0.6ms. The room polls every two seconds, so making the
 * supported call the primary one would spend a third of every poll waiting on a
 * subprocess. Being documented does not make it affordable at that rate.
 *
 * So the fast, undocumented path stays primary, and this is the safety net for
 * exactly the failure that path is expected to have one day: if the registry
 * moves, changes schema, or stops being written, `liveSessions()` comes back
 * empty and this answers instead. It also covers a Claude Code that has stopped
 * writing `~/.claude/sessions` altogether.
 *
 * Never blocks a frame. The lookup is spawned in the background and the last
 * good answer is served meanwhile, so the worst case is that sessions appear one
 * poll late rather than that a frame stalls for three quarters of a second.
 */
import { execFile } from 'node:child_process'
import type { Registry } from './types.ts'

/** Long enough that a room with genuinely nothing running is not respawning a
 *  700ms subprocess constantly; short enough to notice a session within a poll
 *  or two of the registry going away. */
const EVERY = 15_000

let cache: Registry[] | null = null
let at = 0
let inFlight = false

/** The last good answer, or null if the CLI has never successfully replied. */
export const agentSessions = () => cache

/** Visible for testing: the shape conversion, with no process involved. */
export function parseAgents(stdout: string): Registry[] | null {
	let raw: unknown
	try {
		raw = JSON.parse(stdout)
	} catch {
		return null
	}
	if (!Array.isArray(raw)) return null
	const out: Registry[] = []
	for (const r of raw as Record<string, unknown>[]) {
		// A background agent has no pid of its own and is not a session you can
		// look at, so it is not a room occupant either — the registry never
		// contained one and neither should this.
		if (!r || typeof r.pid !== 'number' || typeof r.sessionId !== 'string' || typeof r.cwd !== 'string') continue
		out.push({
			pid: r.pid,
			sessionId: r.sessionId,
			cwd: r.cwd,
			name: typeof r.name === 'string' ? r.name : undefined,
			// same vocabulary as the registry's own field — busy | shell | idle |
			// waiting — which is what stateOf() already knows how to read
			status: typeof r.status === 'string' ? r.status : undefined,
			startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
			kind: typeof r.kind === 'string' ? r.kind : undefined,
			// deliberately absent: `procStart` exists only to catch a recycled PID in
			// a file that outlived its process, and the CLI reports live sessions, so
			// there is nothing stale to catch. `waitingFor` the CLI does not report.
		})
	}
	return out
}

/**
 * Start a refresh if the cached answer has aged out. Returns immediately; the
 * answer lands later or not at all.
 */
export function refreshAgents(now = Date.now()) {
	if (inFlight || now - at < EVERY) return
	inFlight = true
	const child = execFile(
		'claude',
		['agents', '--json'],
		{ timeout: 10_000, maxBuffer: 8 << 20, windowsHide: true },
		(err, stdout) => {
			inFlight = false
			at = Date.now()
			// no claude on PATH, a timeout, or a version without the subcommand — all
			// the same answer, and none of them worth surfacing over a missing room
			if (err) return
			const parsed = parseAgents(stdout)
			if (parsed) cache = parsed
		},
	)
	// never hold the process open for this
	child.unref?.()
}

/** Visible for testing. */
export function reset() {
	cache = null
	at = 0
	inFlight = false
}

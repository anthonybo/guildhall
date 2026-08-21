/**
 * Which guildhalls are serving the browser view right now.
 *
 * This exists because two were serving at once — the launchd service on the configured
 * port and a `tools/serve.mjs --port 4319` dev watcher — and **nothing anywhere said
 * so**. Both were bound to every interface, so both were reachable over the tailnet,
 * and the only way to find out was to run `lsof` by hand. "I have no indication of that
 * and how would I know" is the whole reason this file is here.
 *
 * It matters for three separate reasons, none of them cosmetic:
 *
 *  - Two doors. The passcode guards each, but a door you have forgotten about is not
 *    something you can decide to close.
 *  - **Measured cost: each server burns about 1% of a core continuously** (13.6 cpu-s
 *    over 24 minutes, and 13.1 over 17). Doubling that for nothing is exactly the kind
 *    of unmeasured expense this project keeps a budget to prevent.
 *  - They can be different builds. `dist/main.mjs` is loaded at process start, so an
 *    older server keeps answering with older behaviour while `web/app.js`, which is read
 *    from disk per request, is current on both. That combination is genuinely confusing
 *    to debug — one half fresh, one half stale.
 *
 * A REGISTRY, NOT A SCAN. The obvious implementation is to enumerate listeners and
 * check which are guildhall, and it was measured before being rejected: `lsof -nP -iTCP
 * -sTCP:LISTEN` costs **90 cpu-ms** and `ps -axo pid=,command=` costs **80**. The
 * `collect()` poll budget for a whole tick is 12. Something that cannot be afforded
 * every tick ends up behind a cache with a TTL nobody measured, which is precisely the
 * shape of the 30-second refresh that once cost a third of a core here.
 *
 * So each server announces itself in a file and removes it on the way out. Reading the
 * directory and checking a handful of pids is microseconds, which means the answer can
 * be recomputed whenever it is drawn and never goes stale.
 *
 * The same shape as Codex's `thread-writer-locks`, which this codebase already reads
 * for exactly this purpose — a live-process registry as files, with the pid as the
 * liveness check.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Resolved per call so tests can redirect it; the same rule as auth.ts and config.ts. */
const dir = () => path.join(process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall'), 'servers')

export type Serving = { pid: number; port: number; host: string; at: number }

const file = (pid: number) => path.join(dir(), `${pid}.json`)

/**
 * Say that this process is serving.
 *
 * Best-effort throughout: a server that cannot write its own announcement must still
 * serve. Nothing here is load-bearing for the browser view, and a thrown error would
 * take down the thing it is describing.
 */
export function announce(port: number, host: string, pid = process.pid): void {
	try {
		fs.mkdirSync(dir(), { recursive: true })
		fs.writeFileSync(file(pid), JSON.stringify({ pid, port, host, at: Date.now() }))
	} catch {}
}

/** Say that this process has stopped serving. */
export function withdraw(pid = process.pid): void {
	try {
		fs.unlinkSync(file(pid))
	} catch {}
}

/**
 * Is that process still alive?
 *
 * `kill(pid, 0)` sends no signal and just asks the kernel — free, unlike `ps`. EPERM
 * means it exists and belongs to somebody else, which still counts as alive; only ESRCH
 * means gone.
 */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/**
 * Every guildhall serving right now, except this one.
 *
 * Stale entries are deleted as they are found rather than merely skipped: a process
 * killed with SIGKILL never runs its own cleanup, so without this the directory would
 * fill with the pid of every server that ever crashed, and the warning would cry wolf
 * until somebody cleared it by hand.
 */
export function others(selfPid = process.pid): Serving[] {
	let names: string[]
	try {
		names = fs.readdirSync(dir())
	} catch {
		return []
	}
	const out: Serving[] = []
	for (const name of names) {
		if (!name.endsWith('.json')) continue
		const pid = Number(name.slice(0, -5))
		if (!Number.isInteger(pid) || pid <= 0) continue
		if (pid === selfPid) continue
		if (!alive(pid)) {
			try {
				fs.unlinkSync(path.join(dir(), name))
			} catch {}
			continue
		}
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')) as Serving
			if (Number.isInteger(raw.port)) out.push({ pid, port: raw.port, host: String(raw.host ?? ''), at: Number(raw.at) || 0 })
		} catch {}
	}
	// oldest first, so the one that has been running longest — most likely the one you
	// forgot about — is named first
	return out.sort((a, b) => a.at - b.at)
}

/** One line naming them, or null when this is the only server. */
export function othersNote(selfPid = process.pid): string | null {
	const list = others(selfPid)
	if (!list.length) return null
	const which = list.map((s) => `:${s.port} (pid ${s.pid})`).join(', ')
	return `another guildhall is also serving on ${which}`
}

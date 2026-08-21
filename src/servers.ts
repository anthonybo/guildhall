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
import { execFileSync } from 'node:child_process'
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

/**
 * Who supervises that server, when anything does.
 *
 * This is the difference between a stop button that works and one that appears to do
 * nothing. `tools/serve.mjs` is guildhall's own dev watcher: it spawns
 * `dist/main.mjs --headless`, and it restarts the child on ANY exit — not only on a file
 * change. Sending SIGTERM to the child there is futile.
 *
 * **Measured, because the first version of this note guessed and got it wrong.** It said
 * the port comes back "within a second". It does not: the watcher waits 2s, logs
 * `server exited (0) — restarting in 2s`, then rebuilds, and the new child bound about
 * **9 seconds** after the kill. That is worse than instant, not better — a check at +8s
 * reported the port free and the kill successful, which is exactly how this would have
 * shipped as "works on my machine".
 *
 * Read at call time rather than recorded at announce time. A `ps` costs about 10ms,
 * which is nothing on a button press and would be far too much on a poll — and a
 * recorded ppid can go stale, since a supervisor can exit and leave its child reparented
 * to launchd.
 */
export function supervisor(pid: number): { pid: number; what: string } | null {
	try {
		const ppid = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
		if (!Number.isInteger(ppid) || ppid <= 1) return null
		const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8' }).trim()
		// Only guildhall's own watcher counts. Anything else supervising this — a shell, a
		// terminal, launchd — is not ours to signal, and launchd (ppid 1) is excluded
		// above because stopping the service is a different button that already exists.
		if (/tools\/serve\.mjs/.test(cmd)) return { pid: ppid, what: 'the dev watcher (tools/serve.mjs)' }
		return null
	} catch {
		return null
	}
}

export type StopResult = { ok: true; note: string } | { ok: false; why: string }

/**
 * Stop one of the servers in the registry.
 *
 * **Only a pid this registry announced.** That is the whole guard: a stop button in a
 * menu bar app that can signal an arbitrary pid is a much larger thing than a stop
 * button, and refusing anything we did not write ourselves keeps it small.
 *
 * SIGTERM, never SIGKILL. The node side handles SIGTERM by withdrawing its registry
 * entry and exiting cleanly; SIGKILL would skip that and leave a file naming a dead
 * process, which is the stale entry the reader then has to prune.
 */
export function stop(pid: number): StopResult {
	/**
	 * A POSITIVE pid, checked before anything else and independently of the registry.
	 *
	 * `kill(0, sig)` signals THIS PROCESS GROUP and `kill(-1, sig)` signals every process
	 * the caller is permitted to signal. Those are not edge cases to tidy up later; they
	 * are the two worst things this function could be talked into doing, and they are one
	 * bad argument away.
	 *
	 * The registry check below already excludes them, because `others()` only yields pids
	 * it parsed as greater than zero. This is deliberately a SECOND, independent gate:
	 * the cost is one comparison, and the failure it prevents is unbounded. It was added
	 * after removing the registry check in a test — to prove the check was load-bearing —
	 * and realising that with it gone the test itself would have SIGTERMed its own
	 * process group.
	 */
	if (!Number.isInteger(pid) || pid <= 0) return { ok: false, why: `${pid} is not a process id` }
	if (!others(process.pid).some((s) => s.pid === pid)) {
		return { ok: false, why: `pid ${pid} is not a guildhall server this machine announced` }
	}
	// Kill the supervisor instead when there is one, or it simply restarts the child.
	const boss = supervisor(pid)
	const target = boss?.pid ?? pid
	try {
		process.kill(target, 'SIGTERM')
	} catch (e) {
		return { ok: false, why: `could not stop pid ${target}: ${(e as Error).message}` }
	}
	return {
		ok: true,
		note: boss ? `stopped ${boss.what}, which was restarting it` : `stopped pid ${pid}`,
	}
}

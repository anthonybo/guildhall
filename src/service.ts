import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT } from './port.ts'

/**
 * Install or remove the login service that serves the browser view.
 *
 * One implementation, because there are three callers and a plist is exactly the
 * kind of thing that grows a second copy: the installer's `--serve`, the menu bar
 * panel's toggle, and `guildhall --set-serve` typed by hand. The menu bar version
 * was originally going to be Swift writing its own plist, which would have been a
 * fourth idea of what the service looks like in a codebase that had just been
 * cleaned of four different ideas of what the settings are.
 *
 * The panel showing "go run a script in the terminal" was the thing this replaces.
 * A control panel does not get to answer that way — the same objection the control
 * password already records, for the same reason.
 */

const LABEL = 'dev.guildhall.headless'
const root = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const agentDir = () => path.join(os.homedir(), 'Library', 'LaunchAgents')
const agentFile = () => path.join(agentDir(), `${LABEL}.plist`)
const domain = () => `gui/${process.getuid?.() ?? 0}`
/** The port the service will use, from the one place that owns it. */
function port(): number {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'guildhall', 'config.json'), 'utf8'))
		return Number.isInteger(raw.port) ? raw.port : DEFAULT_PORT
	} catch {
		return DEFAULT_PORT
	}
}

/** `&`, `<` and `>` are the three that make a plist unparseable rather than wrong. */
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type ServiceResult = { ok: true; note: string } | { ok: false; why: string }

/**
 * Who is listening on a port, if anyone.
 *
 * Because the failure this exists to catch is invisible otherwise: the service
 * starts, cannot bind, exits 1, and launchd retries it forever — while the thing
 * that asked for it reported success. That is what "I turned it on and the browser
 * shows nothing" is, every time.
 *
 * A port probe alone cannot tell them apart: an interactive room answering on the
 * same port looks exactly like a working service. So the holder is identified by
 * pid, not by whether something replies.
 */
/** Is this pid another guildhall? Then the port is not a conflict, it is a handover. */
function isGuildhall(pid: string): boolean {
	try {
		const out = execFileSync('/bin/ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' })
		return /main\.mjs|guildhall/.test(out)
	} catch {
		return false
	}
}

export function portHolder(port: number): { pid: string; cmd: string } | null {
	try {
		const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		// -F pc emits `p<pid>` then `c<command>` on separate lines.
		const pid = /^p(\d+)/m.exec(out)?.[1]
		const cmd = /^c(.+)/m.exec(out)?.[1]
		return pid ? { pid, cmd: cmd ?? 'something' } : null
	} catch {
		// lsof missing, or nothing listening — both mean "no known holder".
		return null
	}
}

/** The job's last exit code, or null when launchd has no opinion yet. */
function lastExit(): number | null {
	const r = spawnSync('/bin/launchctl', ['print', `${domain()}/${LABEL}`], { encoding: 'utf8' })
	const m = /last exit code = (\d+)/.exec(r.stdout ?? '')
	return m ? Number(m[1]) : null
}

/** Is the job loaded right now? The only honest answer to "is it serving". */
export function serviceLoaded(): boolean {
	if (process.platform !== 'darwin') return false
	const r = spawnSync('/bin/launchctl', ['print', `${domain()}/${LABEL}`], { stdio: 'ignore' })
	return r.status === 0
}

export function serviceInstalled(): boolean {
	return fs.existsSync(agentFile())
}

/**
 * Wait for a bootout to actually take effect.
 *
 * `bootout` returns when the request is accepted, not when the job is gone. A
 * bootstrap into that window fails with `Bootstrap failed: 5: Input/output error`,
 * which is launchd's way of saying the label is already loaded — the failure that
 * broke `--upgrade` on a machine whose app was slower to quit than mine.
 */
function settle(): void {
	for (let i = 0; i < 40 && serviceLoaded(); i++) {
		// 250ms, matching the installer's loop. Ten seconds total is far longer than a
		// node process needs and still finite.
		spawnSync('/bin/sleep', ['0.25'])
	}
}

/** Write the LaunchAgent, substituting this machine's paths into the template. */
function writeAgent(): ServiceResult {
	const template = path.join(root(), 'contrib', `${LABEL}.plist`)
	let body: string
	try {
		body = fs.readFileSync(template, 'utf8')
	} catch {
		return { ok: false, why: `cannot read ${template} — is this a git checkout?` }
	}
	// `process.execPath` rather than a PATH lookup: launchd starts the job with almost
	// no environment, so the node that runs it has to be named absolutely. This is the
	// node running right now, which is the one the caller meant.
	body = body
		.replaceAll('/CHANGEME-NODE', xml(process.execPath))
		.replaceAll('/Users/CHANGEME/projects/guildhall', xml(root()))
		.replaceAll('/Users/CHANGEME', xml(os.homedir()))
	if (body.includes('CHANGEME')) {
		return { ok: false, why: 'a placeholder survived substitution; refusing to hand launchd a broken job' }
	}
	try {
		fs.mkdirSync(agentDir(), { recursive: true })
		fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs'), { recursive: true })
		fs.writeFileSync(agentFile(), body)
	} catch (e) {
		return { ok: false, why: `cannot write ${agentFile()}: ${(e as Error).message}` }
	}
	// plutil is the difference between a clear failure here and a job that silently
	// never starts.
	try {
		execFileSync('/usr/bin/plutil', ['-lint', agentFile()], { stdio: 'ignore' })
	} catch {
		return { ok: false, why: `${agentFile()} is not valid plist` }
	}
	return { ok: true, note: 'written' }
}

/** Turn the browser-view service on: install the agent if needed, then load it. */
export function serviceOn(): ServiceResult {
	if (process.platform !== 'darwin') return { ok: false, why: 'launchd is macOS only' }
	// A port held by ANOTHER GUILDHALL is not a conflict and must not be reported as
	// one. The room already treats this arrangement as normal in the other order —
	// "a room opened after the service cannot have the port and does not need it" —
	// and the same is true reversed: the browser view is being served, by the room.
	//
	// The first version refused here and told the person to quit their own room. That
	// is not an answer; it is handing the user a collision between two halves of one
	// program. The agent is installed either way, and launchd's retry is what makes it
	// take over the moment the room lets go.
	const before = portHolder(port())
	const handover = before !== null && isGuildhall(before.pid)
	if (before && !handover && !serviceLoaded()) {
		return {
			ok: false,
			why: `port ${port()} is held by ${before.cmd} (pid ${before.pid}), which is not guildhall. Choose another port.`,
		}
	}
	const written = writeAgent()
	if (!written.ok) return written
	// Always bootout first: launchd caches the job definition, so writing the plist
	// changes nothing about a job it is already holding.
	spawnSync('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' })
	settle()
	const r = spawnSync('/bin/launchctl', ['bootstrap', domain(), agentFile()], { encoding: 'utf8' })
	if (r.status !== 0 && !serviceLoaded()) {
		const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
		return { ok: false, why: said || `launchctl bootstrap exited ${r.status}` }
	}
	// Wait until OUR job is the thing listening, and say so only then.
	//
	// Three weaker versions of this check were wrong in a way that mattered. Returning
	// as soon as bootstrap succeeded reported success over a process that had not
	// started. Checking that something answers the port cannot tell our service from
	// an interactive room on the same port — which is how a real conflict looked like
	// a working service. Checking only the exit code misses the case where the job is
	// alive but has not bound yet: measured, node takes over two seconds from launch
	// to listening, so a two-second check reported failure over a service that was
	// about to work perfectly.
	//
	// The port holder's pid MATCHING the job's pid is the one unambiguous answer, and
	// it is the last step of the chain — what a browser would actually reach.
	if (handover) {
		// Installed and loaded; it simply cannot bind yet. Waiting for our pid to become
		// the listener would time out and report a failure over an arrangement that is
		// working — the browser view IS reachable, served by the room.
		return {
			ok: true,
			note: `installed. A guildhall room (pid ${before.pid}) is serving port ${port()} right now, so the browser view already works; the service takes over when that room stops.`,
		}
	}
	for (let i = 0; i < 40; i++) {
		const code = lastExit()
		if (code !== null && code !== 0) {
			const tail = logTail()
			return { ok: false, why: `it starts and immediately exits (code ${code})${tail ? `: ${tail}` : ''}` }
		}
		const holder = portHolder(port())
		if (holder && holder.pid === servicePid()) return { ok: true, note: 'serving' }
		spawnSync('/bin/sleep', ['0.25'])
	}
	const tail = logTail()
	return { ok: false, why: `it loaded but is not listening on port ${port()} after ten seconds${tail ? `: ${tail}` : ''}` }
}

/** The pid launchd currently has for the job, as a string to compare with lsof's. */
function servicePid(): string | null {
	const r = spawnSync('/bin/launchctl', ['print', `${domain()}/${LABEL}`], { encoding: 'utf8' })
	return /pid = (\d+)/.exec(r.stdout ?? '')?.[1] ?? null
}

/** The last line of the service's own log, which usually says exactly what failed. */
function logTail(): string {
	try {
		const f = path.join(os.homedir(), 'Library', 'Logs', 'guildhall-headless.log')
		const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
		return lines[lines.length - 1]?.replace(/^\S+ \S+\s+/, '') ?? ''
	} catch {
		return ''
	}
}

/**
 * Turn it off: unload AND remove the agent.
 *
 * Removing it is the point. `bootout` alone stops it until the next login, and
 * `RunAtLoad` then brings back a service the person switched off — which is the
 * same shape of surprise as the default that made this setting necessary.
 */
export function serviceOff(): ServiceResult {
	if (process.platform !== 'darwin') return { ok: false, why: 'launchd is macOS only' }
	spawnSync('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' })
	settle()
	try {
		if (fs.existsSync(agentFile())) fs.unlinkSync(agentFile())
	} catch (e) {
		return { ok: false, why: `stopped it, but could not remove ${agentFile()}: ${(e as Error).message}` }
	}
	if (serviceLoaded()) return { ok: false, why: 'launchd still reports the job as loaded' }
	return { ok: true, note: 'stopped' }
}

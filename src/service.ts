import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** `&`, `<` and `>` are the three that make a plist unparseable rather than wrong. */
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type ServiceResult = { ok: true; note: string } | { ok: false; why: string }

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
	const written = writeAgent()
	if (!written.ok) return written
	// Always bootout first: launchd caches the job definition, so writing the plist
	// changes nothing about a job it is already holding.
	spawnSync('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' })
	settle()
	const r = spawnSync('/bin/launchctl', ['bootstrap', domain(), agentFile()], { encoding: 'utf8' })
	if (r.status !== 0) {
		// Refused, but loaded, is success — reporting a failure here sends somebody to
		// debug a service that is running.
		if (serviceLoaded()) return { ok: true, note: 'already running' }
		const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
		return { ok: false, why: said || `launchctl bootstrap exited ${r.status}` }
	}
	return { ok: true, note: 'serving' }
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

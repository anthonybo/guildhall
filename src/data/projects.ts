/**
 * Where a new session may be started.
 *
 * Two sources, both evidence rather than configuration: the directories live
 * sessions are already running in, and the git repositories under the projects
 * root. A directory that has a session in it right now is proof a session can run
 * there; a git repository beside those is what "start something new" means in
 * practice.
 *
 * This list is also the ALLOWLIST for spawning. The browser sends a directory
 * back and the server checks it against this rather than trusting the path it was
 * handed — a client-supplied cwd is arbitrary code execution wearing a text field.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is predict whether Claude Code will show its
 * trust prompt. `~/.claude.json` records `hasTrustDialogAccepted` per directory
 * and it looked authoritative; it is not. Measured on this machine: `tidepool`
 * says `false` and runs fine, `guildhall` is absent from the file entirely and
 * runs fine, and `kestrelbay` says `false` and does prompt. An allowlist built on
 * that flag offered seven directories and excluded every project actually in use.
 * So the prompt is DETECTED after starting instead — see `control.ts` — which is
 * a fact rather than a guess.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { liveSessions } from './registry.ts'

/** Where projects live. One directory, because a filesystem walk from home is a
 *  cost this app has no business paying every time a picker opens. */
const ROOT = () => process.env.GUILDHALL_PROJECTS || path.join(os.homedir(), 'projects')

export type Project = { dir: string; label: string; live: boolean }

/** A directory worth offering: it exists, and it is a repository or already busy. */
function repo(dir: string) {
	try {
		return fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile()
	} catch {
		return false
	}
}

export function spawnable(): Project[] {
	const home = os.homedir()
	const busy = new Set<string>()
	try {
		for (const s of liveSessions()) busy.add(s.cwd)
	} catch {}

	const found = new Map<string, Project>()
	const add = (dir: string) => {
		if (found.has(dir)) return
		try {
			if (!fs.statSync(dir).isDirectory()) return
		} catch {
			return
		}
		found.set(dir, { dir, label: dir.startsWith(home) ? '~' + dir.slice(home.length) : dir, live: busy.has(dir) })
	}

	// Anything already running is offered whether or not it looks like a repository:
	// it is running, which is the only proof that matters.
	for (const d of busy) add(d)
	try {
		for (const name of fs.readdirSync(ROOT())) {
			const dir = path.join(ROOT(), name)
			if (repo(dir)) add(dir)
		}
	} catch {}

	// Busy last. Starting a SECOND session somewhere already occupied is the less
	// common intent, and putting those first would bury the empty projects that are
	// usually what "new session" means.
	return [...found.values()].sort((a, b) => Number(a.live) - Number(b.live) || a.label.localeCompare(b.label))
}

/** Whether this exact directory is one we offered. The allowlist test. */
export const spawnAllowed = (dir: string) => spawnable().some((p) => p.dir === dir)

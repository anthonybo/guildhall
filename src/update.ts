/**
 * Noticing that a newer version exists.
 *
 * Deliberately quiet: it asks once, in the background, and never blocks a frame
 * or delays startup. If there is no network, no remote, or no git at all, the
 * answer is simply "nothing to report" — a dashboard that nags about its own
 * version, or stalls because a lookup timed out, is worse than one that never
 * mentions it.
 *
 * The check is against the repository's own tags rather than a registry, because
 * that is where this is published and it needs no account, no telemetry and no
 * service to keep running.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VERSION } from './version.ts'

const CACHE = path.join(os.homedir(), '.config', 'guildhall', 'update.json')
/** Once a day is plenty for a tool you rebuild by hand. */
const EVERY = 24 * 60 * 60 * 1000

let newest: string | null = null

/** The version available, if it is newer than this one. Null until known. */
export const available = () => newest

/** -1, 0 or 1, comparing dotted numeric versions. Missing parts count as zero. */
export function compare(a: string, b: string) {
	const pa = a.split('.').map(Number)
	const pb = b.split('.').map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0
		const y = pb[i] ?? 0
		if (x !== y) return x < y ? -1 : 1
	}
	return 0
}

/** The highest `vX.Y.Z` in `git ls-remote` output. */
export function newestTag(lsRemote: string) {
	let best = ''
	for (const line of lsRemote.split('\n')) {
		const m = /refs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/.exec(line.trim())
		if (!m) continue
		if (!best || compare(best, m[1]) < 0) best = m[1]
	}
	return best
}

type Cache = { at: number; latest: string }

function readCache(): Cache | null {
	try {
		const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Cache
		if (typeof c.at === 'number' && typeof c.latest === 'string') return c
	} catch {}
	return null
}

function writeCache(latest: string) {
	try {
		fs.mkdirSync(path.dirname(CACHE), { recursive: true, mode: 0o700 })
		fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), latest }), { mode: 0o600 })
	} catch {}
}

function note(latest: string) {
	if (latest && compare(VERSION, latest) < 0) newest = latest
}

/**
 * Start the check. Returns immediately; the answer arrives later or never.
 *
 * `onFound` fires only when something newer exists, so the caller can redraw once
 * rather than poll a getter.
 */
export function check(onFound?: (latest: string) => void, cwd = process.cwd()) {
	const cached = readCache()
	if (cached) {
		note(cached.latest)
		// a fresh cache is the whole answer; no reason to touch the network
		if (Date.now() - cached.at < EVERY) {
			if (newest && onFound) onFound(newest)
			return
		}
	}

	const child = execFile(
		'git',
		['ls-remote', '--tags', '--refs', 'origin', 'v*'],
		{ cwd, timeout: 5000, windowsHide: true },
		(err, stdout) => {
			if (err) return // offline, no remote, not a checkout — all the same answer
			const latest = newestTag(stdout)
			if (!latest) return
			writeCache(latest)
			const before = newest
			note(latest)
			if (newest && newest !== before && onFound) onFound(newest)
		},
	)
	// never hold the process open for this
	child.unref?.()
}

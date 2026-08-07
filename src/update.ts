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

/** Resolved per call so tests can redirect it; see the note in auth.ts. */
const cacheFile = () => path.join(process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall'), 'update.json')
/**
 * How long a cached answer suppresses the network.
 *
 * This was a day, on the reasoning that a hand-rebuilt tool changes slowly. It
 * does not: this repo ships several versions in an afternoon, and a day-long
 * cache meant every one of them after the first was invisible until tomorrow —
 * the indicator simply never appeared. Ten minutes still collapses a burst of
 * restarts into one lookup, which is all the cache was ever for.
 */
const EVERY = 10 * 60 * 1000

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
		const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Cache
		if (typeof c.at === 'number' && typeof c.latest === 'string') return c
	} catch {}
	return null
}

function writeCache(latest: string) {
	try {
		fs.mkdirSync(path.dirname(cacheFile()), { recursive: true, mode: 0o700 })
		fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), latest }), { mode: 0o600 })
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
		// Report what the cache knows straight away, whether or not it is still
		// fresh — a stale cache that already says "newer exists" is right about
		// that, and waiting for the network to confirm it just delays the badge.
		note(cached.latest)
		if (newest && onFound) onFound(newest)
		// only a FRESH cache excuses skipping the lookup
		if (Date.now() - cached.at < EVERY) return
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

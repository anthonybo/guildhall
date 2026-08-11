/**
 * The one place the version comes from.
 *
 * Read out of package.json rather than duplicated as a literal, so bumping the
 * package is the only edit — a hand-maintained copy drifts, and a version that
 * lies is worse than no version at all. The bundle runs from dist/, so both that
 * and a from-source run have to resolve it; hence the walk upward.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function read(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 4; i++) {
		const file = path.join(dir, 'package.json')
		try {
			const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
			if (pkg.name === 'guildhall' && pkg.version) return pkg.version
		} catch {}
		dir = path.dirname(dir)
	}
	return '0.0.0'
}

/**
 * The commit this build came from, read straight out of .git rather than by
 * shelling out to git — a subprocess on a two-second poll is what already cost
 * 161ms elsewhere, and this is needed at startup.
 *
 * Shown beside the version because the version alone cannot answer the question
 * that actually matters: "is the thing I am looking at the thing I just built?"
 * A stale instance is invisible otherwise, which is how a keep-awake feature can
 * appear to be running while the process predates it entirely.
 */
function readCommit(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 4; i++) {
		const git = path.join(dir, '.git')
		try {
			const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim()
			const ref = head.startsWith('ref:') ? head.slice(5).trim() : null
			if (!ref) return head.slice(0, 7)
			try {
				return fs.readFileSync(path.join(git, ref), 'utf8').trim().slice(0, 7)
			} catch {
				// a packed ref: the loose file does not exist
				const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8')
				const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`))
				if (line) return line.slice(0, 7)
			}
		} catch {}
		dir = path.dirname(dir)
	}
	return ''
}

export const VERSION = read()
export const COMMIT = readCommit()
/** What to show a person: `0.2.0 · a1b2c3d`, or just the version outside a checkout. */
export const BUILD = COMMIT ? `${VERSION} · ${COMMIT}` : VERSION

/**
 * The build string, re-read when the files it comes from change.
 *
 * `BUILD` above is frozen at import, which was wrong for anything long-lived. A
 * release bumps package.json and moves the git ref but touches no source, so the
 * headless service kept serving `0.2.39 · 1abe86a` to every browser after v0.3.0
 * had shipped — the code was current and only the label was stale, which is the
 * worst version of that bug because the label is the thing you check.
 *
 * Restarting the service to refresh a label would be silly, and the watcher
 * deliberately ignores generated files so it would not have caught it anyway. So
 * the label re-reads itself instead.
 *
 * Guarded by mtime so the common case is two stats and nothing else. Called from
 * the stream tick, twice a second at most; measured too small to appear next to
 * the 3.4ms that `collect()` costs on the same tick.
 */
let cached = BUILD
let stamp = ''

export function build(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url))
	let now = ''
	for (let i = 0; i < 4; i++) {
		try {
			const pkg = path.join(dir, 'package.json')
			const p = fs.statSync(pkg)
			// the git ref moves on every commit; HEAD itself only on a branch switch
			let g = 0
			try {
				const head = path.join(dir, '.git', 'HEAD')
				const h = fs.readFileSync(head, 'utf8').trim()
				const ref = h.startsWith('ref:') ? path.join(dir, '.git', h.slice(5).trim()) : head
				g = fs.statSync(ref).mtimeMs
			} catch {}
			now = `${p.mtimeMs}:${g}`
			break
		} catch {}
		dir = path.dirname(dir)
	}
	if (now && now !== stamp) {
		stamp = now
		const v = read()
		const c = readCommit()
		cached = c ? `${v} · ${c}` : v
	}
	return cached
}

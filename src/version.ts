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

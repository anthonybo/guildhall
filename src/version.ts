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

export const VERSION = read()

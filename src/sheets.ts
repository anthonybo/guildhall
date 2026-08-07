/**
 * Loading the sprite sheets from disk.
 *
 * Split from characters.ts so that module stays free of `fs` and can be bundled
 * for the browser, which fetches the same PNGs and decodes them with the
 * platform's own decoder instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePNG, type Image } from './png.ts'
import { setSheets } from './characters.ts'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/characters')

export function loadSheets() {
	const imgs: Image[] = []
	for (const f of fs
		.readdirSync(DIR)
		.filter((f) => /^char_\d+\.png$/.test(f))
		.sort()) {
		imgs.push(decodePNG(path.join(DIR, f)))
	}
	setSheets(imgs)
	return imgs.length
}

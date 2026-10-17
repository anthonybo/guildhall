/**
 * The picture a session's terminal is showing, as a file this server may hand out.
 *
 * Claude Code can draw images in the terminal (the kitty graphics protocol, which
 * Ghostty and so cmux speak), and a plugin uses that to preview every image the Read
 * tool opens. cmux's grid carries only the cells the picture covers — U+10EEEE
 * placeholders — never its pixels, and no cmux method returns them. So the browser
 * showed a blank hole where the terminal on the Mac showed the picture.
 *
 * The terminal does print the file's NAME on the line above the picture, and the
 * session's transcript has the full path the Read was given. This joins the two.
 *
 * It is a file server, so it is narrow on purpose: only an image type, only a file this
 * session itself read (as recorded in its own transcript), only a regular file, and only
 * up to a size a phone should be sent. A name is a bare file name; anything with a slash
 * in it is refused before the transcript is even opened.
 */
import fs from 'node:fs'
import path from 'node:path'
import { historyPage } from './history.ts'

export const IMAGE_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.heic': 'image/heic',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.bmp': 'image/bmp',
}

/** A picture on screen was read recently; this many pages back is far more than a
 *  screen's worth of conversation, and stops a miss from reading a 500MB transcript. */
const MAX_PAGES = 40
/** Bigger than any screenshot here, smaller than anything a phone should download for
 *  a preview. */
export const MAX_IMAGE = 20 * 1024 * 1024

const found = new Map<string, string>()
const missed = new Map<string, number>()
const MISS_MS = 60_000

export function shownImage(sessionId: string, name: string): { file: string; type: string } | null {
	if (!name || name !== path.basename(name) || name.startsWith('.')) return null
	const type = IMAGE_TYPES[path.extname(name).toLowerCase()]
	if (!type) return null
	const key = `${sessionId}\0${name}`
	const usable = (file: string) => {
		try {
			const st = fs.statSync(file)
			return st.isFile() && st.size <= MAX_IMAGE
		} catch {
			return false
		}
	}
	const known = found.get(key)
	if (known && usable(known)) return { file: known, type }
	// A miss reads up to MAX_PAGES of transcript — measured 0.77s on a 538MB one — so it
	// is remembered briefly rather than paid again by every phone that asks.
	if (Date.now() - (missed.get(key) ?? 0) < MISS_MS) return null
	missed.set(key, Date.now())
	let before: number | undefined
	for (let i = 0; i < MAX_PAGES; i++) {
		const page = historyPage(sessionId, before)
		if (!page) return null
		// Newest first: the same name read twice means the later file is the one on screen.
		for (let j = page.entries.length - 1; j >= 0; j--) {
			const e = page.entries[j]!
			if (e.kind !== 'tool' || e.tool !== 'Read' || !path.isAbsolute(e.text) || path.basename(e.text) !== name) continue
			if (!usable(e.text)) continue
			found.set(key, e.text)
			missed.delete(key)
			return { file: e.text, type }
		}
		if (page.cursor === null) return null
		before = page.cursor
	}
	return null
}

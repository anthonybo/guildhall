/**
 * Writing frames to the terminal: only the lines that changed, and the image layer.
 */
import { SYNC_END, SYNC_START, clearPlacements, cursorTo } from '../kitty.ts'
import { sent } from './images.ts'

/* ── screen ── */
export const OUT = process.stdout
export let prev: string[] = []
let hadImages = false
export let alt = false
let quiet = false // --bench exercises the frame path without writing to the screen

/** Forget what is on screen, so the next frame repaints every line. */
export function resetPrev() {
	prev = []
}
export function setAlt(on: boolean) {
	alt = on
}
export function setQuiet(on: boolean) {
	quiet = on
}

export function paint(lines: string[], images: string) {
	if (quiet) {
		prev = lines
		return
	}
	let buf = SYNC_START
	// Also clear on the frame that stops drawing images — switching to the
	// full-screen table used to leave every sprite pinned above the text, since
	// nothing emitted a delete once `images` went empty.
	if (images || hadImages) buf += clearPlacements()
	hadImages = !!images
	for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) buf += `${cursorTo(i + 1, 1)}\x1b[2K${lines[i]}`
	prev = lines
	buf += images + SYNC_END
	OUT.write(buf)
}

/** Erase the display — and remember that it took the images with it.
 *
 *  Ghostty's ED handler calls kitty_images.delete(.{ .all = true }), which frees
 *  the pixel data and not merely the placements. (kitty itself does not.) So every
 *  clear has to re-arm the transmit set or the next frame places dangling ids. */
export function eraseDisplay() {
	OUT.write('\x1b[2J')
	sent.clear()
}

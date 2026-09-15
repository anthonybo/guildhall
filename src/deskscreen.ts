/**
 * A desk screen drawn as an IMAGE, so its text is not bound to the terminal's cell.
 *
 * THE WHOLE POINT IS THE SIZE. `cv.text` draws one character per canvas column at whatever
 * size the terminal's font is, so a six-tile screen holds eighteen characters and no
 * arrangement of the room changes that — the limit is the cell, not the layout. An image
 * is measured in pixels, so the same box can carry three times as much.
 *
 * SCALE is the dial between the two. At 1 the 6x13 font gives about sixty columns, which
 * was measured as too small to be worth reading; at 2 it gives about thirty, which is
 * roughly twice the terminal's own text and was what "slightly bigger" asked for. Integer
 * factors only: kitty and Ghostty bilinear-filter graphics-protocol images, so a
 * fractional scale averages one-pixel stems into grey — nameplate.ts documents that.
 *
 * The glyphs come from font.ts, not straight from nameplate.ts: those tables are lowercase
 * only, and rendering a terminal through them dropped every capital.
 *
 * The canvas drawing in board.ts stays, and is what a terminal without image support gets.
 */
import { FULL6x13, glyphRows } from './font.ts'
import type { Grid } from './characters.ts'
import type { Session } from './data/types.ts'
import { needsAttention } from './data/select.ts'
import { C, LOOK, type RGB } from './theme.ts'

/** How many image pixels to one font pixel. See the note above on why it is an integer. */
export const SCALE = 2
/** Pixels of frame around the glass — real pixels, so the frame is a hairline rather than
 *  the thirty-pixel band it was when the screen was drawn in canvas units. */
const BEZEL = 2
const PAD = 2
const CW = FULL6x13.w * SCALE
const CH = FULL6x13.h * SCALE

/** How much text a screen of this pixel size holds. Exported so the caller can cut lines
 *  to width without knowing anything about the font. */
export function screenFits(wPx: number, hPx: number) {
	const edge = (BEZEL + PAD) * 2
	return { cols: Math.max(0, Math.floor((wPx - edge) / CW)), rows: Math.max(0, Math.floor((hPx - edge) / CH)) }
}

/**
 * Draw one desk screen. `lines` is already cleaned and newest-last.
 *
 * `frame` advances every 0.45s and only drives the caret. The classic room's liveness came
 * from the monitor sprite's flickering code lines, and this layout replaces that sprite —
 * so with a session mid-answer and its screen unchanged for a few seconds, the desk looked
 * switched off. A caret is the honest version of the same signal: it blinks only while the
 * session is actually working, and it sits where the next character would land.
 */
export function screenImage(wPx: number, hPx: number, pick: Session | undefined, lines: string[], reading: boolean, error?: string, frame = 0): Grid {
	const grid: (RGB | null)[][] = Array.from({ length: hPx }, () => new Array<RGB | null>(wPx).fill(null))
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (x + i >= 0 && y + j >= 0 && x + i < wPx && y + j < hPx) grid[y + j]![x + i] = c
	}

	// The frame carries the state — see board.ts for why it is the frame and not a strip
	// inside the glass, which the header text painted over.
	const live = !!pick && (pick.state === 'working' || pick.state === 'shell' || needsAttention(pick))
	box(0, 0, wPx, hPx, live && pick ? LOOK[pick.state].color : C.deskCase)
	box(BEZEL, BEZEL, wPx - BEZEL * 2, hPx - BEZEL * 2, C.night)

	const fit = screenFits(wPx, hPx)
	if (!fit.cols || !fit.rows) return { w: wPx, h: hPx, grid }
	const x0 = BEZEL + PAD
	const y0 = BEZEL + PAD

	const write = (row: number, text: string, colour: RGB) => {
		let x = x0
		for (const ch of text.slice(0, fit.cols)) {
			const g = glyphRows(ch)
			if (g) {
				for (let r = 0; r < FULL6x13.h; r++) {
					const bits = g[r]!
					if (!bits) continue
					for (let i = 0; i < FULL6x13.w; i++) if (bits & (1 << (FULL6x13.w - 1 - i))) box(x + i * SCALE, y0 + row * CH + r * SCALE, SCALE, SCALE, colour)
				}
			}
			x += CW
		}
	}

	if (!pick) {
		write(0, 'no session here', C.faint)
		return { w: wPx, h: hPx, grid }
	}
	write(0, `${pick.proj} - ${LOOK[pick.state].label}`, live ? C.gold : C.faint)
	// A session doing nothing gets dark glass: its last output is hours old and says nothing
	// about now, and seven screens of stale text is a wall you have to read to find there is
	// nothing to read. See board.ts.
	if (!live) return { w: wPx, h: hPx, grid }

	const body = fit.rows - 1
	if (body < 1) return { w: wPx, h: hPx, grid }
	const shown = lines.length ? lines.slice(-body) : [error ? `! ${error}` : reading ? 'reading the screen...' : 'nothing on screen yet']
	// Bottom-aligned, so the newest line of every screen in the room sits at the same height
	// and the eye finds them all in one pass.
	const pad = body - shown.length
	for (const [i, line] of shown.entries()) write(1 + pad + i, line, lines.length ? C.label : C.faint)
	// The caret, after the last character of the newest line, on alternate frames.
	if (frame % 2 === 0) {
		const last = shown[shown.length - 1] ?? ''
		const col = Math.min(fit.cols - 1, last.length)
		box(x0 + col * CW, y0 + (1 + pad + shown.length - 1) * CH + 4 * SCALE, FULL6x13.w * SCALE - SCALE, 7 * SCALE, C.label)
	}
	return { w: wPx, h: hPx, grid }
}

/**
 * The workstation layout: one desk per session, each with a screen showing its terminal.
 *
 * SEPARATE FROM plan.ts ON PURPOSE. This is an alternative view — the classic room, with
 * its project pods and pixel-art monitors, stays the default and is untouched by anything
 * in here. Keeping the two layouts in one function meant every change to either was a
 * change to both, and the pod layout is what the browser and the committed images draw.
 *
 * The difference that matters is PITCH. Pods sit desks two tiles apart, which is eight
 * canvas columns; both renderers draw one character per column, so a screen over a pod desk
 * holds eight characters. Here a desk is a whole screen wide, and that is the entire reason
 * the layout exists.
 */
import { SCREEN } from './model.ts'
import type { Room } from './plan.ts'

/** Rows a workstation needs: the screen, the worktop it stands on, and the seat. */
export const BAND = SCREEN.h + 2

/**
 * How wide each workstation gets.
 *
 * Widest-first, and the first width that seats everybody wins. That ordering is the whole
 * policy: a wide window spends its space making each terminal readable, a narrow one spends
 * it fitting everybody in.
 *
 * Returns the narrowest allowed width when nothing fits, so the overflow is counted by the
 * hidden-seat path rather than silently dropped.
 */
export function slotWidth(cols: number, bands: number, seats: number): number {
	const usable = cols - 4 // a wall and a corridor on each side
	for (const w of SCREEN.widths) {
		if (Math.floor(usable / w) * bands >= seats) return w
	}
	return SCREEN.widths[SCREEN.widths.length - 1]!
}

/**
 * Lay out one workstation per seat, left to right and top to bottom.
 *
 * Returns the first free band, the same contract the pod layout has, so the caller can put
 * facilities below the work area either way.
 */
export function seatWorkstations(room: Room, wishlist: { proj: string; seats: number }[], bandRows: number[]): number {
	let band = 0
	let n = 0
	const seats = wishlist.reduce((a, w) => a + w.seats, 0)
	const slotW = slotWidth(room.cols, bandRows.length, seats)
	const perBand = Math.max(1, Math.floor((room.cols - 4) / slotW))

	let slot = 0
	for (const want of wishlist) {
		for (let k = 0; k < want.seats; k++) {
			if (band >= bandRows.length) break
			const screenTop = bandRows[band]!
			// The old `monitorRow` is the BOTTOM row of the screen — the one directly above the
			// worktop — so everything downstream that reasons about a monitor still holds.
			const monitorRow = screenTop + SCREEN.h - 1
			const deskRow = monitorRow + 1
			const seatRow = monitorRow + 2
			/**
			 * Each workstation centred in an equal share of the width.
			 *
			 * The previous version handed the leftover out as a whole-tile gap between slots,
			 * and `floor(spare / (perBand + 1))` is ZERO whenever the leftover is smaller than
			 * the number of gaps — so every spare tile piled up on the right. Measured on a
			 * 17-tile room: one tile of margin on the left and three on the right.
			 *
			 * Dividing the width first and centring inside the share keeps the arithmetic in
			 * fractions until the last step, so a leftover of one tile is split rather than
			 * dropped.
			 *
			 * A SHORT LAST ROW IS CENTRED TOO. Seven sessions two to a row leaves one on its
			 * own, and left-aligning it made the room look like it had lost a desk.
			 */
			const inBand = Math.max(1, Math.min(perBand, seats - band * perBand))
			const share = (room.cols - 4) / inBand
			const c0 = 2 + Math.round(slot * share + (share - slotW) / 2)
			const w = Math.min(slotW, room.cols - 2 - c0)
			// The desk sits under the MIDDLE of its own screen, so the two read as one
			// workstation rather than as a slab floating over a small table.
			const c = c0 + ((w - 1) >> 1)
			if (w >= 3 && room.grid[deskRow]?.[c] !== undefined) {
				room.grid[deskRow][c] = 'desk'
				const id = `d${n++}`
				room.spots.set(id, {
					id,
					kind: 'desk',
					group: want.proj,
					col: c,
					row: seatRow,
					facing: 'up',
					posture: 'sit',
					zone: want.proj,
					taken: null,
				})
				room.seatTiles.add(`${c},${seatRow}`)
				// A WORKTOP AS WIDE AS THE SCREEN. With a single desk tile under a four-tile
				// screen the screen read as a slab hanging over a side table; the run of
				// worktop is what makes it a workstation. `desk` is a drawing instruction, so
				// office.ts paints the surface across it, and only the centre tile is a spot.
				for (let x = c0; x < c0 + w; x++) if (room.grid[deskRow]?.[x] === 'floor') room.grid[deskRow][x] = 'desk'
				// The carpet covers the whole workstation, which is what groups it visually
				// now that the nameplate beside it is gone.
				for (let r = screenTop; r <= seatRow; r++) for (let x = c0; x < c0 + w; x++) room.zoneOf[r]?.[x] === null && (room.zoneOf[r]![x] = want.proj)
				room.pods.push({ proj: want.proj, c0: c, c1: c, seatRow, deskRow, monitorRow })
				// The screen itself, which is what the room is for. Its footprint is solid so
				// nobody walks through the one thing being read, and `id` names the desk so a
				// renderer can put the right session's terminal on it.
				room.screens.push({ col: c0, row: screenTop, w, h: SCREEN.h, desk: id })
				for (let r = screenTop; r < screenTop + SCREEN.h; r++) {
					for (let x = c0; x < c0 + w; x++) {
						if (room.grid[r]?.[x] === 'floor') room.grid[r][x] = 'solid'
					}
				}
			}
			slot++
			if (slot >= perBand) {
				slot = 0
				band++
			}
		}
	}
	if (slot > 0) band++
	return band
}

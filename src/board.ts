/**
 * The wall display: one session's real terminal, drawn in the room.
 *
 * ONE board rather than a screen per desk, and the reason is arithmetic. A desk is 8
 * canvas columns and both renderers draw one character per column, so a desk monitor
 * holds EIGHT characters — measured, in the terminal and the browser alike. Reaching a
 * readable width per desk would mean drawing at half the size of every other word in the
 * room, which a terminal cannot do at all. This board is 12 tiles across: 48 columns and
 * 6 rows, wider than some of the panes it shows.
 *
 * Drawn with `rect` and `text` rather than as an image, so it is the same mechanism in
 * both renderers and cannot drift the way the harness mark did — and because kitty draws
 * images OVER text, so a prop here would cover the thing being read.
 *
 * Its own file, not part of main.ts, because a drawing nobody can call is a drawing
 * nobody can look at: this one is rendered into a plain canvas by a test and by the
 * scratch harness that produced the screenshots.
 */
import { cut } from './data/describe.ts'
import { needsAttention } from './data/select.ts'
import type { Session } from './data/types.ts'
import type { RGB } from './png.ts'
import { C, LOOK } from './theme.ts'

/** Only what this needs of a Canvas, so a test can pass a stub and read it back. */
export type Surface = {
	rect: (x: number, y: number, w: number, h: number, c: RGB) => void
	text: (col: number, row: number, s: string, f: RGB | null, b: RGB | null, bold?: boolean) => void
}

export type Placement = { col: number; row: number; w: number; h: number }
/** What `peek.glance()` returns, named here so this file does not import it — the browser
 *  bundle draws the room too and must not pull `node:child_process` in behind it. */
export type Screen = { lines: string[]; at: number; reading: boolean; error?: string }

/**
 * The session worth watching.
 *
 * Whatever needs you, else whatever is working, else the first with a tab at all. A
 * session with no cmux workspace has no screen to show, so it is not a candidate however
 * urgent it is.
 */
export function focused(list: Session[]): Session | undefined {
	const withTab = list.filter((s) => s.workspace)
	return withTab.find((s) => needsAttention(s)) ?? withTab.find((s) => s.state === 'working') ?? withTab[0]
}

/**
 * Draw the board.
 *
 * `screen` is passed in rather than fetched: this file has no business deciding when to
 * spend a cmux process, and keeping it out means the drawing can be tested with no cmux
 * on the machine at all.
 */
export function drawBoard(cv: Surface, at: Placement, tile: number, pick: Session | undefined, screen: Screen | null) {
	const x = at.col * tile
	const y = at.row * tile
	const w = at.w * tile
	const h = at.h * tile
	// A bezel, then the glass. Framing it is what keeps text at a different sharpness
	// from reading as a fault in the pixel art around it.
	cv.rect(x, y, w, h, C.wallStone)
	cv.rect(x + 1, y + 1, w - 2, h - 2, C.night)

	const col0 = x + 2
	const row0 = Math.ceil((y + 1) / 2)
	const room = w - 4
	const rows = Math.max(1, Math.floor((h - 2) / 2))
	if (room < 8) return

	if (!pick) {
		cv.text(col0, row0, cut('no session has a terminal', room), C.faint, C.night)
		return
	}
	cv.text(col0, row0, cut(`${pick.proj} — ${LOOK[pick.state].label}`, room), C.gold, C.night)

	const lines = screen?.lines ?? []
	// The NEWEST lines, filling upward from the bottom of the glass. A screen grows
	// downward, so the last line is the one you actually want and the top of the board is
	// what gets sacrificed when there is not enough room.
	const shown = lines.slice(-(rows - 1))
	for (const [i, line] of shown.entries()) cv.text(col0, row0 + 1 + i, cut(line, room), C.label, C.night)
	if (shown.length) return
	// Say why it is blank rather than looking broken — a dark rectangle in a room is
	// indistinguishable from a bug.
	const why = screen?.error ? cut(screen.error, room) : screen?.reading ? 'reading the screen…' : 'nothing on screen yet'
	cv.text(col0, row0 + 1, why, C.faint, C.night)
}

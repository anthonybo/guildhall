/**
 * A screen showing one session's real terminal, drawn in the room.
 *
 * ONE PER DESK. The first version was a single wall display showing whichever session
 * seemed most urgent, and it was reported three times as a random big screen in the middle
 * of the room — the ask was always that each desk show its own session.
 *
 * What made that hard was arithmetic, and the arithmetic was about the ROOM, not about
 * this file. Desks sat two tiles apart: eight canvas columns, and both renderers draw one
 * character per column, so a screen over a desk held eight characters. The fix was the
 * room's pitch (see `seatProjects`), after which the same drawing serves either job — a
 * screen is as wide as its slot, and `4w - 6` characters fit across it.
 *
 * Drawn with `rect` and `text` rather than as an image, so it is the same mechanism in
 * both renderers and cannot drift the way the harness mark did — and because kitty draws
 * images OVER text, so a prop here would cover the thing being read. That is not
 * theoretical: the nameplates did exactly that, and had to stop being drawn.
 *
 * Its own file, not part of main.ts, because a drawing nobody can call is a drawing
 * nobody can look at: this one is rendered into a plain canvas by a test and by the
 * scratch harness that produced the screenshots.
 */
import { cut } from './data/describe.ts'
import { needsAttention } from './data/select.ts'
import type { Session } from './data/types.ts'
import type { Glance } from './peek.ts'
import type { RGB } from './png.ts'
import { C, LOOK } from './theme.ts'

/** Only what this needs of a Canvas, so a test can pass a stub and read it back. */
export type Surface = {
	rect: (x: number, y: number, w: number, h: number, c: RGB) => void
	text: (col: number, row: number, s: string, f: RGB | null, b: RGB | null, bold?: boolean) => void
}

export type Placement = { col: number; row: number; w: number; h: number }
/**
 * What `peek.glance()` returns.
 *
 * A `type` import, so nothing of peek.ts survives into a bundle: it was copied out by hand
 * to keep `node:child_process` away from the browser, and that reasoning was wrong —
 * measured, a build importing the type alone is 193 bytes with zero occurrences of
 * `child_process`, because esbuild erases a type import entirely. A copy that has to be
 * kept in step by hand is the more likely failure.
 */
export type Screen = Glance

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

/** The warning line, when there is text on the glass that a failed read has left behind. */
function staleWarning(screen: Screen | null): string | null {
	return screen?.error && screen.lines.length ? `⚠ ${screen.error}` : null
}

/**
 * Draw the board.
 *
 * `screen` is passed in rather than fetched: this file has no business deciding when to
 * spend a cmux process, and keeping it out means the drawing can be tested with no cmux
 * on the machine at all.
 */
export function drawBoard(cv: Surface, at: Placement, tile: number, pick: Session | undefined, screen: Screen | null, onDesk = false) {
	const x = at.col * tile
	const y = at.row * tile
	const w = at.w * tile
	const h = at.h * tile
	// A screen standing on a desk needs no stand — the worktop is directly beneath it, and
	// the stand was drawn INTO it, which is what put an apparent gap between the two and
	// made the screen look like it was hovering.
	const wantStand = !onDesk
	// A bezel, then the glass, then a stand.
	//
	// TWO pixels of bezel, not one, and the stand is not decoration. Rendered at docs scale
	// and looked at: a 1px frame is a single pixel of wallStone [96,92,118] against
	// floorDark [40,38,52], which is invisible, so the board read as a rectangular HOLE in
	// the floor rather than as an object standing in the room — the "dark rectangle is
	// indistinguishable from a bug" failure this file's header names, arrived at from the
	// other direction.
	/**
	 * The frame carries the state, and it is the FRAME rather than a strip inside the glass.
	 *
	 * A one-pixel lit strip along the top of the glass was tried and rendered as two small
	 * squares at the corners: it shares its pixel rows with the header text, and a text cell
	 * paints its own background, so the words erased everything between them.
	 *
	 * The case colour otherwise. Two others were rendered and rejected: `wallStone`
	 * [96,92,118] against a floor of [72,68,88] disappears, so the screens read as holes cut
	 * in the floor; `deskEdge` matches the worktop directly beneath, so screen and desk
	 * merged into one brown slab.
	 */
	const live = !!pick && (pick.state === 'working' || pick.state === 'shell' || needsAttention(pick))
	cv.rect(x, y, w, h, live && pick ? LOOK[pick.state].color : C.deskCase)
	cv.rect(x + 2, y + 2, w - 4, h - 4, C.night)
	if (wantStand) {
		// The stand goes in the tile row below the glass, which the planner keeps clear of
		// walkers so a passing character cannot cover the text.
		const stand = Math.max(4, w >> 2)
		const legX = x + ((w - stand) >> 1)
		cv.rect(legX, y + h, stand, 2, C.deskEdge)
		cv.rect(legX - 2, y + h + 2, stand + 4, 1, C.deskEdge)
	}

	const col0 = x + 3
	const room = w - 6
	// Character rows fully inside the glass, which runs pixel rows y+2 to y+h-3.
	//
	// A canvas row is TWO pixel rows, and the old `floor((h - 2) / 2)` ignored that the last
	// row it allowed straddled the final glass row and the frame below it. Measured at every
	// size tried — h of 2, 3 and 4, w of 8 and 12, three positions — 44 of 48 bottom-bezel
	// cells were replaced by a text cell and the frame's bottom edge vanished under the
	// words. Cosmetic, but the frame is the whole reason the text does not read as a fault
	// in the pixel art around it.
	const row0 = Math.ceil((y + 2) / 2)
	const rows = Math.max(1, Math.floor((h - 4) / 2))
	if (room < 8) return

	if (!pick) {
		cv.text(col0, row0, cut('no session has a terminal', room), C.faint, C.night)
		return
	}
	cv.text(col0, row0, cut(`${pick.proj} — ${LOOK[pick.state].label}`, room), live ? C.gold : C.faint, C.night)

	// A SESSION THAT IS NOT DOING ANYTHING GETS DARK GLASS.
	//
	// Its last output is hours old and says nothing about now, and seven screens of stale
	// text is a wall of noise you have to read to discover there is nothing to read. The
	// name stays, dimmed, because the nameplates are gone in this layout and a screen with
	// nothing on it at all would be a desk belonging to nobody.
	if (!live) return

	const lines = screen?.lines ?? []
	// The NEWEST lines, filling upward from the bottom of the glass. A screen grows
	// downward, so the last line is the one you actually want and the top of the board is
	// what gets sacrificed when there is not enough room.
	// A failing read costs one line of terminal, so what is left is still the newest. This
	// used to return before ever reaching the error, so an error arriving AFTER a good read
	// was never shown: with a 30s backoff the board could sit on minutes-old text that
	// reads as a quiet session rather than as a display nobody is updating.
	const warn = staleWarning(screen)
	const budget = rows - 1 - (warn ? 1 : 0)
	const shown = budget > 0 ? lines.slice(-budget) : []
	for (const [i, line] of shown.entries()) cv.text(col0, row0 + 1 + i, cut(line, room), C.label, C.night)
	if (shown.length) {
		if (warn) cv.text(col0, row0 + 1 + shown.length, cut(warn, room), C.faint, C.night)
		return
	}
	// Say why it is blank rather than looking broken — a dark rectangle in a room is
	// indistinguishable from a bug.
	const why = screen?.error ? cut(screen.error, room) : screen?.reading ? 'reading the screen…' : 'nothing on screen yet'
	cv.text(col0, row0 + 1, why, C.faint, C.night)
}

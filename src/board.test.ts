/**
 * The wall display.
 *
 * The failure worth guarding is a dark rectangle in the room that says nothing — a board
 * with no text is indistinguishable from a bug, and this one has four reasons to be
 * empty (no session, nothing read yet, a read in flight, a read that failed). Each has to
 * say which.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { type Screen, type Surface, drawBoard, focused } from './board.ts'
import type { Session } from './data/types.ts'

const AT = { col: 4, row: 5, w: 12, h: 3 }
const TILE = 4

/** A canvas that only remembers what was written to it. */
function surface() {
	const written: { col: number; row: number; s: string }[] = []
	const rects: { x: number; y: number; w: number; h: number }[] = []
	const cv: Surface = {
		rect: (x, y, w, h) => void rects.push({ x, y, w, h }),
		text: (col, row, s) => void written.push({ col, row, s }),
	}
	return { cv, written, rects, lines: () => written.map((w) => w.s) }
}

const session = (over: Partial<Session> = {}): Session =>
	({
		id: 's1',
		proj: 'orchard',
		state: 'working',
		workspace: 'aaaaaaaa-1111-2222-3333-444444444444',
		turns: 10,
		ctxUsed: 1000,
		doing: 'editing',
		stale: 0,
		...over,
	}) as Session

const screen = (over: Partial<Screen> = {}): Screen => ({ lines: [], at: 0, reading: false, ...over })

test('it draws a bezel and glass, so text does not float on the floor', () => {
	const { cv, rects } = surface()
	drawBoard(cv, AT, TILE, session(), screen({ lines: ['hello'], at: 1 }))
	const [bezel, glass] = rects
	assert.ok(glass!.w < bezel!.w && glass!.h < bezel!.h, 'the glass is not inset in the bezel')
	assert.equal(bezel!.x, AT.col * TILE)
	assert.equal(bezel!.w, AT.w * TILE)
	// Two pixels of frame, not one. At one pixel the bezel is a single pixel against a floor
	// eight values away from it, which is invisible at any real scale — a row of screens read
	// as rectangular holes cut in the floor. Verified by rendering and looking.
	assert.ok(glass!.x - bezel!.x >= 2, `the bezel is only ${glass!.x - bezel!.x}px thick and will not be seen`)
	// Free-standing, it stands on something, in the row below the glass the planner keeps clear.
	const below = rects.filter((r) => r.y >= bezel!.y + bezel!.h)
	assert.ok(below.length > 0, 'a free-standing board has no stand, so it floats')
})

test('a screen sitting on a desk is not given a stand', () => {
	// The worktop is directly beneath it. The stand was drawn INTO the desk, which read as a
	// gap between the two and made every screen look like it was hovering over its desk.
	const { cv, rects } = surface()
	drawBoard(cv, AT, TILE, session(), screen({ lines: ['hello'], at: 1 }), true)
	const bezel = rects[0]!
	const below = rects.filter((r) => r.y >= bezel.y + bezel.h)
	assert.deepEqual(below, [], `a desk screen drew ${below.length} rects below itself`)
})

test('the newest lines are the ones kept', () => {
	// A screen grows downward, so the last line is the one you want. When the glass is
	// short it is the TOP that must be sacrificed.
	//
	// MORE LINES THAN SLOTS, deliberately. The fixture used to be three lines into four
	// slots, so keeping the OLDEST end passed this test just as well — a review caught it
	// by mutation, not by the suite.
	const { cv, lines } = surface()
	const many = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']
	drawBoard(cv, AT, TILE, session(), screen({ lines: many, at: 1 }))
	const drawn = lines()
	assert.ok(
		drawn.some((l) => l.includes('l9')),
		`the newest line was dropped: ${JSON.stringify(drawn)}`,
	)
	assert.ok(
		!drawn.some((l) => l.includes('l0')),
		`the oldest line was kept, so it filled from the wrong end: ${JSON.stringify(drawn)}`,
	)
})

test('every line lands inside the glass, not on the bezel or the floor', () => {
	// Vertical geometry had NO coverage: the stub records writes and nothing asserted where
	// they went, so putting text on the top bezel passed, and so did three rows of it below
	// the board on the floor. The real defect it hid was subtler — the last row `rows`
	// allowed spanned the final glass row and the bezel under it, so the frame's bottom
	// edge vanished under the words.
	for (const at of [AT, { col: 2, row: 1, w: 8, h: 3 }, { col: 6, row: 9, w: 12, h: 4 }]) {
		const { cv, written } = surface()
		drawBoard(cv, at, TILE, session(), screen({ lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], at: 1 }))
		const x = at.col * TILE
		const y = at.row * TILE
		// The glass is the bezel inset by two pixels on every side.
		const top = y + 2
		const bottom = y + at.h * TILE - 3
		for (const w of written) {
			assert.ok(2 * w.row >= top, `a row was drawn on the top bezel at ${at.w}x${at.h}: canvas row ${w.row}`)
			assert.ok(2 * w.row + 1 <= bottom, `a row overran the bottom bezel at ${at.w}x${at.h}: canvas row ${w.row} reaches pixel ${2 * w.row + 1}, glass ends at ${bottom}`)
			assert.ok(w.col >= x + 2, `a line started on the left bezel: col ${w.col}`)
			assert.ok(w.col + w.s.length <= x + at.w * TILE - 2, `a line ran into the right bezel: col ${w.col} + ${w.s.length}`)
		}
	}
})

test('every empty reason says which one it is', () => {
	// A dark rectangle is indistinguishable from a bug, so none of these may be silent.
	for (const [what, pick, scr, expect] of [
		['no session at all', undefined, null, /no session/i],
		['nothing read yet', session(), screen(), /nothing on screen/i],
		['a read in flight', session(), screen({ reading: true }), /reading/i],
		['a read that failed', session(), screen({ error: 'cmux would not answer' }), /cmux would not answer/i],
	] as const) {
		const { cv, lines } = surface()
		drawBoard(cv, AT, TILE, pick, scr)
		assert.ok(
			lines().some((l) => expect.test(l)),
			`${what}: drew nothing explaining itself — ${JSON.stringify(lines())}`,
		)
	}
})

test('it names the session it is showing', () => {
	// Otherwise the board is a screen with no indication of whose it is, in a room full
	// of desks.
	const { cv, lines } = surface()
	drawBoard(cv, AT, TILE, session({ proj: 'orchard' }), screen({ lines: ['x'], at: 1 }))
	assert.ok(lines()[0]?.includes('orchard'), `no session name: ${JSON.stringify(lines())}`)
})

test('nothing is drawn wider than the glass', () => {
	// The room is a fixed grid: a line that overruns writes over the wall beside it.
	//
	// The bound is the GLASS, `w * TILE - 4`, not the board's full width. Checking against
	// the full width let a truncation four columns too generous pass — which is an overrun
	// through the bezel into the wall.
	const { cv, written } = surface()
	const long = 'x'.repeat(300)
	drawBoard(cv, AT, TILE, session({ proj: long }), screen({ lines: [long, long], at: 1 }))
	const room = AT.w * TILE - 6
	for (const w of written) assert.ok(w.s.length <= room, `a line was ${w.s.length} wide in ${room} columns of glass`)
})

test('a failed read says so instead of passing off old text as current', () => {
	// The error branch used to be unreachable once anything had been read: with a 30s
	// backoff the board could sit on minutes-old text and read as a quiet session.
	const { cv, lines } = surface()
	drawBoard(cv, AT, TILE, session(), screen({ lines: ['the last good line'], at: 1, error: 'cmux would not answer' }))
	const drawn = lines()
	assert.ok(
		drawn.some((l) => l.includes('the last good line')),
		'it blanked the glass rather than keeping the last good text',
	)
	assert.ok(
		drawn.some((l) => /cmux would not answer/.test(l)),
		`it showed stale text with no warning: ${JSON.stringify(drawn)}`,
	)
})

test('focused prefers what needs you, then what is working', () => {
	const needs = session({ id: 'n', state: 'needs', waitingFor: 'answer a question' } as Partial<Session>)
	const working = session({ id: 'w', state: 'working' })
	const parked = session({ id: 'p', state: 'parked' })
	assert.equal(focused([parked, working, needs])?.id, 'n')
	assert.equal(focused([parked, working])?.id, 'w')
	assert.equal(focused([parked])?.id, 'p')
})

test('a session with no cmux tab is never focused, however urgent', () => {
	// It has no screen to show, so choosing it would draw an empty board and explain
	// nothing — the room already marks who needs you.
	const noTab = session({ id: 'x', state: 'needs', workspace: undefined })
	const working = session({ id: 'w', state: 'working' })
	assert.equal(focused([noTab, working])?.id, 'w')
	assert.equal(focused([noTab]), undefined)
})

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
	assert.equal(rects.length, 2, 'expected a frame and a screen')
	const [bezel, glass] = rects
	assert.ok(glass!.w < bezel!.w && glass!.h < bezel!.h, 'the glass is not inset in the bezel')
	assert.equal(bezel!.x, AT.col * TILE)
	assert.equal(bezel!.w, AT.w * TILE)
})

test('the newest lines are the ones kept', () => {
	// A screen grows downward, so the last line is the one you want. When the glass is
	// short it is the TOP that must be sacrificed.
	const { cv, lines } = surface()
	drawBoard(cv, AT, TILE, session(), screen({ lines: ['oldest', 'middle', 'newest'], at: 1 }))
	const drawn = lines()
	assert.ok(drawn.some((l) => l.includes('newest')), `the newest line was dropped: ${JSON.stringify(drawn)}`)
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
	const { cv, written } = surface()
	const long = 'x'.repeat(300)
	drawBoard(cv, AT, TILE, session({ proj: long }), screen({ lines: [long, long], at: 1 }))
	const room = AT.w * TILE
	for (const w of written) assert.ok(w.s.length <= room, `a line was ${w.s.length} wide in ${room} columns`)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { Canvas } from './canvas.ts'
import { Office, TILE } from './office.ts'
import type { Session, State } from './data.ts'

function session(id: string, proj: string, state: State): Session {
	return {
		id,
		pid: 1,
		name: id,
		proj,
		cwd: `/x/${proj}`,
		state,
		stale: 60_000,
		title: `work on ${proj}`,
		doing: 'editing a file',
		last: 'said a thing',
		ctxUsed: 50_000,
		ctxLimit: 200_000,
		tab: 1,
		unread: false,
		palette: 0,
		hueShift: 0,
	}
}

const room = (w = 120, h = 80) => {
	const cv = new Canvas(w, h)
	const office = new Office()
	office.fit(cv.w, cv.h)
	return { cv, office }
}

const posOf = (office: Office, id: string) => {
	const ch = office.chars.get(id)!
	return `${ch.col},${ch.row},${ch.state}`
}

test('everybody gets a seat when there are enough desks', () => {
	const { office } = room()
	const list = Array.from({ length: 9 }, (_, i) => session(`s${i}`, i < 5 ? 'alpha' : 'beta', 'done'))
	office.assign(list)
	assert.equal(office.hiddenCount, 0, 'someone was left without a desk')
	const seated = [...office.chars.values()].filter((c) => c.seatId)
	assert.equal(seated.length, 9)
	// one seat cannot hold two people
	const taken = [...office.seats.values()].filter((s) => s.taken).map((s) => s.taken)
	assert.equal(new Set(taken).size, taken.length)
})

test('sessions from the same project sit together', () => {
	const { office } = room()
	office.assign([
		session('a', 'alpha', 'done'),
		session('b', 'beta', 'done'),
		session('c', 'alpha', 'done'),
		session('d', 'alpha', 'done'),
	])
	const seatOf = (id: string) => office.seats.get(office.chars.get(id)!.seatId!)!
	const alpha = ['a', 'c', 'd'].map(seatOf)
	// contiguous in the seat ordering means adjacent columns on the same row
	const rows = new Set(alpha.map((s) => s.row))
	assert.equal(rows.size, 1, 'a project got split across rows')
	const cols = alpha.map((s) => s.col).sort((x, y) => x - y)
	for (let i = 1; i < cols.length; i++) assert.ok(cols[i] - cols[i - 1] <= 2, 'seats were not adjacent')
})

test('a working session walks to its desk and sits down', () => {
	const { office } = room()
	const s = session('a', 'alpha', 'working')
	office.assign([s])
	assert.equal(office.chars.get('a')!.state, 'idle', 'should start at the door, not in the chair')
	// give it time to path across the room
	for (let i = 0; i < 200; i++) office.update(0.1, [s])
	const ch = office.chars.get('a')!
	const seat = office.seats.get(ch.seatId!)!
	assert.equal(ch.state, 'type', 'never sat down')
	assert.equal(ch.col, seat.col)
	assert.equal(ch.row, seat.row)
	assert.equal(ch.dir, seat.facing, 'sat down facing the wrong way')
})

test('a working session stays put — no wandering mid-turn', () => {
	const { office } = room()
	const s = session('a', 'alpha', 'working')
	office.assign([s])
	for (let i = 0; i < 200; i++) office.update(0.1, [s])
	const settled = posOf(office, 'a')
	for (let i = 0; i < 600; i++) office.update(0.1, [s]) // a full minute of work
	assert.equal(posOf(office, 'a'), settled, 'it left its desk while still working')
})

test('drawing never moves anybody — only update() does', () => {
	const { cv, office } = room()
	const list = [session('a', 'alpha', 'working'), session('b', 'beta', 'done')]
	office.assign(list)
	for (let i = 0; i < 50; i++) office.update(0.1, list)
	const before = list.map((s) => posOf(office, s.id)).join('|')
	for (let i = 0; i < 20; i++) office.draw(cv, list)
	assert.equal(list.map((s) => posOf(office, s.id)).join('|'), before)
})

test('a data refresh does not teleport anyone', () => {
	const { office } = room()
	const list = [session('a', 'alpha', 'working')]
	office.assign(list)
	for (let i = 0; i < 200; i++) office.update(0.1, list)
	const settled = posOf(office, 'a')
	office.assign(list) // what the 2s poll does
	assert.equal(posOf(office, 'a'), settled)
})

test('a blocked session keeps its bubble; a finished one lets it go', () => {
	const { office } = room()
	const blocked = session('a', 'alpha', 'needs')
	office.assign([blocked])
	for (let i = 0; i < 30; i++) office.update(0.1, [blocked])
	assert.equal(office.chars.get('a')!.bubble, 'permission')
	// the same session, now finished long ago: no bubble should linger
	const finished = { ...blocked, state: 'done' as State, stale: 600_000 }
	for (let i = 0; i < 100; i++) office.update(0.1, [finished])
	assert.equal(office.chars.get('a')!.bubble, null)
})

test('characters stay inside the walls', () => {
	const { office } = room()
	const list = Array.from({ length: 6 }, (_, i) => session(`s${i}`, 'alpha', 'done'))
	office.assign(list)
	for (let i = 0; i < 2000; i++) {
		office.update(0.1, list)
		for (const ch of office.chars.values()) {
			assert.ok(ch.col > 0 && ch.col < office.cols - 1, `col ${ch.col} out of bounds`)
			assert.ok(ch.row > 0 && ch.row < office.rows - 1, `row ${ch.row} out of bounds`)
		}
	}
})

test('every rendered row is exactly the canvas width', () => {
	const { cv, office } = room()
	const list = [session('a', 'alpha', 'needs'), session('b', 'beta', 'working')]
	office.assign(list)
	office.overlay(cv, office.draw(cv, list), 'a')
	for (const line of cv.render()) {
		const bare = [...line.replace(/\x1b\[[0-9;]*m/g, '')].length
		assert.equal(bare, cv.w, `row was ${bare} columns, expected ${cv.w}`)
	}
})

test('the room has walls and at least one desk row', () => {
	const { office } = room()
	assert.ok(office.seats.size >= 4, `only ${office.seats.size} seats`)
	assert.ok(TILE >= 4)
})

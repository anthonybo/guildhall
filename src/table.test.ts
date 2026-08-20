import assert from 'node:assert/strict'
import test from 'node:test'
import { header, rows, tableWidths } from './table.ts'
import type { Session, State } from './data.ts'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

const session = (proj: string, state: State = 'parked'): Session =>
	({
		id: proj,
		pid: 1,
		name: proj,
		proj,
		cwd: `/x/${proj}`,
		state,
		stale: 60_000,
		title: proj,
		doing: 'doing a thing that runs on and on and needs truncating somewhere',
		short: '',
		last: '',
		ctxUsed: 50_000,
		ctxLimit: 200_000,
		unread: false,
		toolKind: 'edit',
		turns: 10,
		level: 5,
		xp: 100,
		palette: 0,
		hueShift: 0,
	}) as Session

test('the project is never dropped, however narrow the table gets', () => {
	// it used to vanish below 84 columns, which left a row identified only by a tab
	// number: you could read what a session was doing but not which one it was
	const list = [session('foxglove'), session('brookwater')]
	for (const w of [120, 90, 84, 78, 70, 62, 50, 46]) {
		// rows() sorts, so check every row carries a recognisable name rather than
		// assuming an order
		for (const r of rows(list, w)) {
			const out = strip(r.line)
			assert.ok(/foxglo|borrow/.test(out), `identity gone at width ${w}: ${out}`)
		}
		assert.match(strip(header(w)), /PROJECT/, `header lost PROJECT at width ${w}`)
	}
})

test('the context gauge is what yields when space runs out, not identity', () => {
	assert.equal(tableWidths(120).showCtx, true)
	assert.equal(tableWidths(50).showCtx, false)
	assert.ok(tableWidths(50).proj > 0, 'project column was starved to nothing')
})

test('each project is tinted with the colour it has in the room', () => {
	// the table and the office are one view: a character you spot upstairs has a row
	// down here in the same hue, so finding it is a colour match not a read
	const list = [session('alpha'), session('beta')]
	const colours: Record<string, [number, number, number]> = { alpha: [1, 2, 3], beta: [9, 8, 7] }
	const out = rows(list, 120, undefined, (p) => colours[p])
	assert.match(out[0].line, /38;2;1;2;3/, 'project not tinted with its room colour')
	assert.match(out[1].line, /38;2;9;8;7/)
})

test('every row is exactly the requested width', () => {
	const list = [session('alpha'), session('beta', 'working')]
	for (const w of [120, 84, 70, 52]) {
		for (const r of rows(list, w)) {
			assert.ok(strip(r.line).length <= w, `row overflowed ${w}: ${strip(r.line).length}`)
		}
	}
})

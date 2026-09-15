/**
 * The wall of terminals.
 *
 * What these protect is the thing the feature is FOR: that every active session gets a
 * pane, that the panes hold real lines, and that nothing is dropped without saying so. The
 * two attempts before this one both failed by being invisible rather than by being wrong,
 * so several of these assert that something is actually on screen.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from './data/types.ts'
import { paneFor, wall } from './wall.ts'

const session = (over: Partial<Session> = {}): Session =>
	({
		id: 's1',
		proj: 'orchard',
		state: 'working',
		workspace: 'aaaaaaaa-1111-2222-3333-444444444444',
		turns: 3,
		ctxUsed: 100,
		doing: 'editing',
		stale: 0,
		level: 1,
		title: 'a task',
		...over,
	}) as Session

const plain = (out: string[]) => out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
const screens = (byId: Record<string, string[]>) => (s: Session) => ({ lines: byId[s.id] ?? [], reading: false })

test('every session with a tab gets a pane', () => {
	// The whole ask, in one assertion: all of them at once, not one at a time.
	const list = Array.from({ length: 7 }, (_, i) => session({ id: `s${i}`, proj: `p${i}`, state: i < 2 ? 'working' : 'parked' }))
	const out = plain(wall(list, 67, 56, screens(Object.fromEntries(list.map((s) => [s.id, [`line for ${s.proj}`]]))), true))
	for (const s of list) assert.ok(out.some((l) => l.includes(s.proj)), `${s.proj} got no pane`)
	for (const s of list) assert.ok(out.some((l) => l.includes(`line for ${s.proj}`)), `${s.proj}'s pane showed no terminal`)
})

test('a pane shows the NEWEST lines, bottom aligned', () => {
	// A screen grows downward. Showing the top of it would mean watching a session's
	// opening line forever while it worked.
	const list = [session()]
	const many = Array.from({ length: 40 }, (_, i) => `line ${i}`)
	const out = plain(wall(list, 40, 10, screens({ s1: many }), true))
	assert.ok(out.some((l) => l.includes('line 39')), `the newest line is missing: ${JSON.stringify(out)}`)
	assert.ok(!out.some((l) => l.includes('line 0')), 'it filled from the oldest end')
	// bottom aligned: the last line sits immediately above the pane's rule
	const last = out.findIndex((l) => l.includes('line 39'))
	assert.match(out[last + 1] ?? '', /^─+$/, 'the newest line is not against the bottom of the pane')
})

test('nothing is wider than the terminal', () => {
	// The room is a grid and so is this: a line that overruns wraps and shifts every pane
	// below it by a row, which is the layout coming apart while it looks like a bug.
	const list = [session({ proj: 'x'.repeat(90) }), session({ id: 's2', proj: 'orchard' })]
	const out = plain(wall(list, 40, 20, screens({ s1: ['y'.repeat(200)], s2: ['short'] }), true))
	for (const l of out) assert.ok(l.length <= 40, `a line was ${l.length} wide in 40 columns: ${JSON.stringify(l.slice(0, 60))}`)
})

test('panes are dropped rather than squeezed to nothing, and it says how many', () => {
	// Eight panes of one line each is worse than four with something in them. The count is
	// the important half: silently showing a subset is how this project has been bitten
	// repeatedly, most recently by a board that was dropped and said nothing.
	const list = Array.from({ length: 12 }, (_, i) => session({ id: `s${i}`, proj: `p${i}` }))
	const out = plain(wall(list, 60, 16, screens({}), true))
	assert.ok(out.length <= 16, `wrote ${out.length} lines into 16 rows`)
	assert.ok(
		out.some((l) => /more sessions? did not fit/.test(l)),
		`dropped panes without saying so: ${JSON.stringify(out.slice(-3))}`,
	)
})

test('a session with no screen yet says which kind of nothing it is', () => {
	// A blank pane is indistinguishable from a broken one.
	const list = [session()]
	const reading = plain(wall(list, 40, 8, () => ({ lines: [], reading: true }), true))
	assert.ok(reading.some((l) => /reading the screen/.test(l)), 'a read in flight said nothing')
	const failed = plain(wall(list, 40, 8, () => ({ lines: [], reading: false, error: 'cmux would not answer' }), true))
	assert.ok(failed.some((l) => /cmux would not answer/.test(l)), 'a failed read said nothing')
	const empty = plain(wall(list, 40, 8, () => ({ lines: [], reading: false }), true))
	assert.ok(empty.some((l) => /nothing on screen/.test(l)), 'an empty screen said nothing')
})

test('a session with no cmux tab is not given a pane it cannot fill', () => {
	const withTab = session({ id: 'a' })
	const without = session({ id: 'b', proj: 'nowhere', workspace: undefined })
	assert.deepEqual(
		paneFor([withTab, without], true).map((s) => s.id),
		['a'],
	)
	// and a room where NOBODY has a tab explains itself rather than drawing an empty wall
	const out = plain(wall([without], 40, 10, screens({}), true))
	assert.ok(out.some((l) => /no session has a terminal/.test(l)), `drew a blank wall: ${JSON.stringify(out)}`)
})

test('busy sessions come first, so the ones that fit are the ones that matter', () => {
	const list = [session({ id: 'p1', proj: 'parked1', state: 'parked' }), session({ id: 'w1', proj: 'busy1', state: 'working' }), session({ id: 'p2', proj: 'parked2', state: 'parked' })]
	const out = plain(wall(list, 50, 30, screens({}), true))
	const busyAt = out.findIndex((l) => l.includes('busy1'))
	const parkedAt = out.findIndex((l) => l.includes('parked1'))
	assert.ok(busyAt >= 0 && busyAt < parkedAt, `a parked session was placed above a working one: busy ${busyAt}, parked ${parkedAt}`)
})

test('the pane header names the tab you would press to get there', () => {
	const out = plain(wall([session({ tab: 3 })], 40, 8, screens({}), true))
	assert.ok(out.some((l) => l.includes('⌘3')), `no tab hint in the header: ${JSON.stringify(out[0])}`)
})

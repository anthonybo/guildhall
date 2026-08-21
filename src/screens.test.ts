import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, badge, badgeFor, harnessMark, monitor, monitorFor, monitorKey, type Desk, type LevelLook } from './screens.ts'
import { width } from './theme.ts'

const ink = (g: { grid: (number[] | null)[][] }) =>
	g.grid.map((r) => r.map((c) => (c && c[0] === 40 ? '#' : '.')).join('')).join('\n')

test('a two-digit level renders both digits, not a fallback glyph', () => {
	// levels are open-ended now, so most sessions sit above 9; the old star
	// fallback rendered as an unreadable X on nearly every badge
	const one = ink(badge(9, [255, 200, 90]))
	const two = ink(badge(19, [255, 200, 90]))
	assert.notEqual(one, two)
	const ninteen = ink(badge(19, [255, 200, 90]))
	const ninteenAgain = ink(badge(19, [255, 200, 90]))
	assert.equal(ninteen, ninteenAgain, 'the badge is not stable for one level')
	// 19 must differ from both 1 and 9 alone
	assert.notEqual(two, ink(badge(1, [255, 200, 90])))
})

test('every level from 1 to 30 renders a distinct badge', () => {
	const seen = new Set<string>()
	for (let n = 1; n <= 30; n++) seen.add(ink(badge(n, [255, 200, 90])))
	assert.equal(seen.size, 30, 'two levels render identically')
})

test('the harness marks the BADGE, which is the only part of a desk never covered', () => {
	// This is the whole finding, and it took two wrong attempts to get to. Anything drawn
	// on the WORKTOP is hidden while somebody is working there: the occupant is one tile
	// wide, sits at the desk and is drawn over it. office.ts already records the same
	// thing about the working-light, where roughly 24 pixels across five lit desks
	// survived to the screen. So a mug and a cable went invisible exactly when the
	// session was active — reported as "when an agent is working that is not visible".
	//
	// The badge sits in the aisle beside the desk and is never occluded by anyone.
	const look: LevelLook = { needs: [255, 120, 120], tierOf: () => [200, 160, 240] }
	const claude = badgeFor({ level: 12, asking: false, agent: 'claude' }, look)
	const codex = badgeFor({ level: 12, asking: false, agent: 'codex' }, look)
	const plain = badgeFor({ level: 12, asking: false }, look)

	// The frame carries it, so it reads whichever side the eye arrives from.
	assert.notDeepEqual(claude.grid[2]![2], codex.grid[2]![2], 'the badge frame does not distinguish the harnesses')
	assert.deepEqual(plain.grid[2]![2], [90, 92, 102], 'an unmarked badge has a tinted frame')
	// Plus a full-strength bar on the white card under the number, because one sprite
	// pixel of frame is only about three screen pixels at a real terminal cell.
	assert.deepEqual(claude.grid[13]![5], HARNESS.claude, 'no harness bar on the card')
	assert.deepEqual(codex.grid[13]![5], HARNESS.codex)
	assert.deepEqual(plain.grid[13]![5], [238, 236, 228], 'an unmarked badge grew a bar')
	// The number is untouched — it is the level, and the level is not the harness.
	// the card interior only: the frame is at x=2 and x=13 and is meant to differ
	for (let y = 8; y <= 12; y++) assert.deepEqual(claude.grid[y]!.slice(3, 13), codex.grid[y]!.slice(3, 13), `the number changed with the harness on row ${y}`)
	// And so is the tier strip: a session waiting on you must still look like one.
	for (let y = 3; y <= 5; y++) assert.deepEqual(claude.grid[y]!.slice(3, 13), codex.grid[y]!.slice(3, 13), 'the tier strip changed with the harness')
})

test('the desk sprite changes by exactly the mug, and never the screen or the bezel', () => {
	// The mug stays as a close-range detail but is no longer the mechanism, and nothing
	// else on the sprite may move. A bezel tint was tried and reverted: every pod carpet
	// shows through around this sprite, so the monitor already wears a ring in its
	// project colour and a tint inside that ring reads as noise rather than as a fact.
	const claude = monitor(true, 0, 0, 'edit', 'claude')
	const codex = monitor(true, 0, 0, 'edit', 'codex')
	let differing = 0
	for (let y = 0; y < claude.grid.length; y++)
		for (let x = 0; x < claude.grid[y]!.length; x++)
			if (JSON.stringify(claude.grid[y]![x]) !== JSON.stringify(codex.grid[y]![x])) differing++
	// 3x3 mug plus one handle pixel. More than that means it leaked back onto the worktop
	// or into the bezel, both of which have been measured and shown not to work.
	assert.equal(differing, 10, `${differing} pixels changed; the mug is 10`)
	for (let y = 1; y <= 11; y++) assert.deepEqual(claude.grid[y], codex.grid[y], `screen or bezel row ${y} changed with the harness`)
})

test('a room with one harness is drawn exactly as it was before there were two', () => {
	// office.ts only sets `agent` when the room actually holds more than one harness, so
	// `undefined` is the everyday case: everybody running Claude Code alone. It must be
	// pixel-identical to the old drawing, or every doc image and every existing room
	// changes for a distinction that has nothing to distinguish.
	const plain = monitor(true, 0, 0, 'edit')
	assert.deepEqual(plain.grid[1]![1], [72, 76, 96], 'an unmarked desk has a tinted bezel')
	assert.deepEqual(plain.grid[22]![13], [138, 96, 62], 'something was drawn on an unmarked worktop')
	// the mug is still there and still the ordinary one
	assert.deepEqual(plain.grid[19]![14], HARNESS.claude)
})

test('an unknown harness falls back to the ordinary mug', () => {
	// A third harness arriving must not produce an invisible mug.
	const odd = monitor(true, 0, 0, 'edit', 'something-else')
	const claude = monitor(true, 0, 0, 'edit')
	assert.deepEqual(odd.grid[19]![13], claude.grid[19]![13])
})

test('every surface draws the same harness mark, and both harnesses get one', () => {
	// The bug this pins: the mark was defined three times — a map in table.ts, an
	// inline ternary in web/list.ts, and the mug here — for one decision. Nothing was
	// wrong with any copy; they just had nothing keeping them equal, which is how the
	// nameplates ended up tripled in the terminal and 1:1 in the shipped browser.
	const claude = harnessMark('claude')
	const codex = harnessMark('codex')
	// Claude Code arrives with NO agent field at all — that is what the server sends
	// for it — so the default has to be the Claude mark rather than the fallback.
	assert.deepEqual(harnessMark(undefined), claude, 'a session with no agent field is not marked as Claude Code')
	// Both marked, and distinguishably. Marking only Codex left Claude identified by
	// absence, which is not a distinction that can be read off a row.
	for (const [what, m] of [
		['claude', claude],
		['codex', codex],
	] as const) {
		assert.ok(m.glyph.length > 0, `${what} has no glyph`)
		assert.ok(m.name.length > 0, `${what} has no accessible name`)
	}
	assert.notEqual(claude.glyph, codex.glyph, 'the two harnesses draw the same glyph')
	assert.notDeepEqual(claude.color, codex.color, 'the two harnesses draw the same colour')
	// One cell wide in the table, so a glyph that measures two would shift the column.
	for (const m of [claude, codex]) assert.equal(width(m.glyph), 1, `${m.name} is not one cell wide`)
	// The colour is the room's, not a second opinion about it — the mug and the row
	// have to be the same teal or the two views stop reading as one program.
	assert.deepEqual(codex.color, HARNESS.codex, 'the row colour drifted from the room colour')
	assert.deepEqual(claude.color, HARNESS.claude)
})

test('an unrecognized harness is marked as unknown rather than as Claude Code', () => {
	// Guessing is worse than admitting: a third harness silently drawn as Claude Code
	// is a wrong answer that looks like a right one.
	const odd = harnessMark('gemini-cli')
	assert.notEqual(odd.glyph, harnessMark('claude').glyph)
	assert.notEqual(odd.glyph, harnessMark('codex').glyph)
	assert.equal(width(odd.glyph), 1)
	assert.match(odd.name, /gemini-cli/, 'the unknown harness is not named in its own label')
})

test('a desk descriptor reaches both the picture and its cache key', () => {
	// The shipped bug this prevents: `monitor()` had three call sites and `agent` was
	// added to only one, so the harness mark drew in the browser and never in the
	// terminal — "there is no logo at the desks anywhere", which was accurate. The
	// image path's hand-assembled cache key omitted it too, so even a fixed draw call
	// would have served the first desk's cached picture to the second.
	const claude: Desk = { lit: true, seed: 0, kind: 'edit', agent: 'claude' }
	const codex: Desk = { ...claude, agent: 'codex' }

	// Different desks must not share a cached image.
	assert.notEqual(monitorKey(claude, 0), monitorKey(codex, 0), 'two harnesses hash to the same cached image')
	// And the descriptor's agent must actually reach the drawing.
	assert.notDeepEqual(monitorFor(claude, 0).grid[19]![14], monitorFor(codex, 0).grid[19]![14], 'the descriptor agent never reached the mug')
	assert.deepEqual(monitorFor(codex, 0).grid, monitor(true, 0, 0, 'edit', 'codex').grid, 'monitorFor and monitor disagree about the same desk')

	// The key still collapses the frame for a dark screen, or an unoccupied desk would
	// transmit a new identical image every tick forever.
	assert.equal(monitorKey({ lit: false, seed: 0, kind: 'edit' }, 3), monitorKey({ lit: false, seed: 0, kind: 'edit' }, 7))
	assert.notEqual(monitorKey({ lit: true, seed: 0, kind: 'edit' }, 3), monitorKey({ lit: true, seed: 0, kind: 'edit' }, 0))
})

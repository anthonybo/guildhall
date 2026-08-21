import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, TINT, badge, harnessMark, monitor, monitorFor, monitorKey, type Desk } from './screens.ts'
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

test('a Codex desk is a different MACHINE, not a different colour', () => {
	// Three colour attempts failed here and all three were reported invisible: a coloured
	// mug, then a cable beside it, then a tinted badge frame ("looks the exact same").
	// The reason is that colour is a saturated channel in this room — a carpet hue per
	// project, a tier strip on every badge, a tool tint on every lit screen — so a
	// twelfth colour meaning has nowhere to land. The table's harness column works
	// because it is SHAPE, and this is the same idea at desk scale.
	//
	// It also has to live in the monitor area rather than on the worktop: the occupant
	// is drawn over the worktop while they work, which is what killed the mug.
	const desktop = monitor(false, 0, 0, 'think')
	const laptop = monitor(false, 0, 0, 'think', 'codex')

	// A monitor is broad at the top and thin at the bottom: a wide bezel on a neck.
	assert.notEqual(desktop.grid[6]![1], null, 'the monitor bezel is not full width')
	// [38,40,52] is the stand colour; named here rather than exported, since one test
	// is not a reason to widen a module's surface
	assert.deepEqual(desktop.grid[13]![7], [38, 40, 52], 'the monitor has no neck')
	assert.equal(desktop.grid[14]![0], null, 'the monitor grew a full-width base')

	// A laptop is the reverse — a narrower lid on a deck wider than itself — which is
	// what makes the outline read as another machine rather than the same one moved.
	assert.equal(laptop.grid[6]![1], null, 'the laptop lid is as wide as a monitor bezel')
	assert.notEqual(laptop.grid[14]![0], null, 'the laptop has no full-width deck')

	// The screen still says what it always said. The tool tint is the tool, on both
	// machines, or this would have taken a meaning that was already spoken for.
	const tint = (g: typeof desktop) => g.grid.flat().some((c) => c && c[0] === TINT.run[0] && c[1] === TINT.run[1] && c[2] === TINT.run[2])
	assert.ok(tint(monitor(true, 0, 0, 'run')), 'a lit monitor lost its tool tint')
	assert.ok(tint(monitor(true, 0, 0, 'run', 'codex')), 'a lit laptop never got its tool tint — the code lines are painted on the lid')
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

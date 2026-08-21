import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, badge, harnessMark, monitor, monitorFor, monitorKey, type Desk } from './screens.ts'
import { width } from './theme.ts'
import type { Grid } from './characters.ts'

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

test('the harness marks the desk, and never the screen', () => {
	// Two Claude sessions and a Codex session in one project sit as three identical
	// workers in the same pod, and at rest nothing told them apart — the label prefix
	// only appears when a session is urgent or selected.
	//
	// The mug alone was tried first and was NOT findable: ten pixels at the edge of the
	// worktop, with a bright level badge beside it. The report was "there is no logo at
	// the desks anywhere", from somebody looking for one. So the mark is now three things
	// on different axes — mug, cable, and the bezel, which is the largest thing on a desk
	// and the only one that reads across a room.
	const claude = monitor(true, 0, 0, 'edit', 'claude')
	const codex = monitor(true, 0, 0, 'edit', 'codex')

	const diff = (a: Grid, b: Grid) => {
		let n = 0
		for (let y = 0; y < a.grid.length; y++)
			for (let x = 0; x < a.grid[y]!.length; x++) if (JSON.stringify(a.grid[y]![x]) !== JSON.stringify(b.grid[y]![x])) n++
		return n
	}
	// mug 3x3 + one handle pixel = 10, cable 4x1 = 4, and the bezel ring is
	// box(1,1,14,11) minus the dark screen box(2,2,12,9) drawn over it = 154 - 108 = 46.
	assert.equal(diff(claude, codex), 10 + 4 + 46, 'the harness changed a different number of pixels than mug + cable + bezel')

	// The screen is untouched, which is what keeps the tool tint meaning the tool and
	// nothing else. Checked across every screen row, not one sample: the first version
	// of this test checked row 4 alone and would have missed a leak anywhere else.
	for (let y = 2; y <= 10; y++) assert.deepEqual(claude.grid[y]!.slice(2, 14), codex.grid[y]!.slice(2, 14), `screen row ${y} changed with the harness`)
})

test('a room with one harness is drawn exactly as it was before there were two', () => {
	// office.ts only sets `agent` when the room actually holds more than one harness, so
	// `undefined` is the everyday case: everybody running Claude Code alone. It must be
	// pixel-identical to the old drawing, or every doc image and every existing room
	// changes for a distinction that has nothing to distinguish.
	const plain = monitor(true, 0, 0, 'edit')
	// no cable — row 22 is still bare desk wood — and the bezel is the unmodified case
	assert.deepEqual(plain.grid[22]![13], [138, 96, 62], 'an unmarked desk grew a cable')
	// and the marked one does have it, or the assertion above proves nothing
	assert.deepEqual(monitor(true, 0, 0, 'edit', 'codex').grid[22]![13], HARNESS.codex, 'a marked desk has no cable')
	assert.deepEqual(plain.grid[1]![1], [72, 76, 96], 'an unmarked desk has a tinted bezel')
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

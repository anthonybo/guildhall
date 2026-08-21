import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, badge, harnessMark, monitor } from './screens.ts'
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

test('the mug says which harness the desk belongs to, and nothing else moves', () => {
	// Two Claude sessions and a Codex session in one project sit as three identical
	// workers in the same pod. The label prefix only appears when a session is urgent or
	// selected, so at rest nothing told them apart. Both obvious channels were taken —
	// the sprite badge IS the level tier and the screen tint IS the tool class — so this
	// uses the one thing on a desk that carried no meaning.
	const claude = monitor(true, 0, 0, 'edit')
	const codex = monitor(true, 0, 0, 'edit', 'codex')

	let differing = 0
	for (let y = 0; y < claude.grid.length; y++) {
		for (let x = 0; x < claude.grid[y]!.length; x++) {
			if (JSON.stringify(claude.grid[y]![x]) !== JSON.stringify(codex.grid[y]![x])) differing++
		}
	}
	// The mug is 3x3 with one handle pixel. Anything more means the change leaked into
	// the screen or the bezel, which carry other meanings.
	assert.equal(differing, 10, `${differing} pixels changed; the mug is 10`)

	// And the screen itself is untouched, which is what keeps the tool tint honest.
	assert.deepEqual(claude.grid[4], codex.grid[4], 'the screen changed with the harness')
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { badge, monitor } from './screens.ts'

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

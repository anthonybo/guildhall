import assert from 'node:assert/strict'
import test from 'node:test'
import { badge } from './screens.ts'

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

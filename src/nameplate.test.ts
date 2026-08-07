import assert from 'node:assert/strict'
import test from 'node:test'
import { F6x13, LADDER, choose, plate } from './nameplate.ts'
import { PLATE_COLS, PLATE_ROWS } from './office/model.ts'

/** The real box: two columns by six rows, at a typical 8x17 cell. */
const W = PLATE_COLS * 8
const H = PLATE_ROWS * 17

test('every real project name fits at the largest font', () => {
	// 6x13 was chosen because it is the biggest that still fits the longest name
	// in use — 16 characters at 6px advance is 96px against 102 available
	for (const n of ['guildhall', 'draftingroom', 'iptv-epg-matcher', 'ouncewise', 'borrowyard', 'marina']) {
		const pick = choose(n, W, H)
		assert.ok(pick, `${n} did not fit at all`)
		assert.equal(pick.font, F6x13, `${n} fell back below 6x13`)
		assert.equal(pick.text, n, `${n} was truncated`)
	}
})

test('a name too long for the box is cut, never overflowed', () => {
	const pick = choose('a'.repeat(60), W, H)
	assert.ok(pick)
	assert.ok(pick.text.length * pick.font.w <= H, 'the chosen text does not fit the strip')
})

test('one column is refused rather than drawn illegibly', () => {
	// at 8px across, no font's ink band fits with a keyline — and a plate too small
	// to read is worse than no plate, which is the rule RimWorld's labels use
	assert.equal(choose('guildhall', 8, H), null)
})

test('the plate is exactly the box it was asked for', () => {
	// authored 1:1 on purpose: kitty and Ghostty bilinear-filter images, so a
	// supersampled plate gets averaged on the way down and 1px stems turn grey
	const g = plate(F6x13, 'guildhall', W, H, [228, 96, 92], [32, 34, 46], [26, 28, 40])
	assert.equal(g.w, W)
	assert.equal(g.h, H)
})

test('the word reads bottom-to-top, not top-to-bottom', () => {
	const ink: [number, number, number] = [32, 34, 46]
	const g = plate(F6x13, 'il', W, H, [200, 200, 200], ink, undefined)
	const rows = g.grid.map((r, y) => [y, r.filter((p) => p && p[0] === ink[0]).length] as const).filter(([, n]) => n > 0)
	// 'l' is a tall bare stem and 'i' is a dot plus a short stem, so whichever
	// letter sits lower in the image is the one that reads first
	const mid = (rows[0][0] + rows[rows.length - 1][0]) / 2
	const upper = rows.filter(([y]) => y < mid).reduce((a, [, n]) => a + n, 0)
	const lower = rows.filter(([y]) => y >= mid).reduce((a, [, n]) => a + n, 0)
	assert.ok(lower < upper, `expected 'i' (lighter) at the bottom: upper ${upper} lower ${lower}`)
})

test('the font ladder is ordered largest first', () => {
	for (let i = 1; i < LADDER.length; i++) {
		assert.ok(LADDER[i].h <= LADDER[i - 1].h, 'ladder is out of order, so `choose` cannot pick the biggest')
	}
})

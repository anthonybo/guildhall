import assert from 'node:assert/strict'
import test from 'node:test'
import { F6x13, LADDER, choose, plate } from './nameplate.ts'
import { PLATE_COLS, PLATE_ROWS } from './office/model.ts'

/** The real box: two columns by six rows, at a typical 8x17 cell. */
const W = PLATE_COLS * 8
const H = PLATE_ROWS * 17

test('no plate is ever drawn at 1:1, at any terminal font size', () => {
	// The one rule the whole module exists to keep. A 1px stem is averaged into the
	// background by kitty's and Ghostty's bilinear filter, so an unscaled plate is a
	// grey smudge no matter how good the letterforms are. Fitting a longer name is
	// never worth dropping to 1:1 — the name that needs reading most is the long one.
	for (const cell of [5, 6, 7, 8, 10, 12, 14, 16]) {
		const pick = choose('draftingroom', PLATE_COLS * cell, PLATE_ROWS * (cell * 2 + 1))
		assert.ok(pick, `nothing drawn at a ${cell}px cell`)
		assert.ok(pick.scale >= 2, `${cell}px cell fell back to a ${pick.scale}x hairline`)
	}
})

test('the shortest names stay whole everywhere; long ones are cut, not shrunk', () => {
	// `headroom` is the floor: eight characters is the bar the room was judged
	// against, so it survives at every size a plate is drawn at all. A name past
	// that is truncated with a '.', because a word you can read beats one you cannot.
	for (const cell of [5, 6, 7, 8, 10, 12, 14, 16]) {
		const box = [PLATE_COLS * cell, PLATE_ROWS * (cell * 2 + 1)] as const
		for (const n of ['marina', 'headroom']) assert.equal(choose(n, ...box)?.text, n, `${n} was cut at a ${cell}px cell`)
		// either it fits whole or it is visibly marked as cut — never silently clipped
		const long = choose('iptv-epg-matcher', ...box)
		assert.ok(long, `nothing drawn at a ${cell}px cell`)
		assert.ok(long.text === 'iptv-epg-matcher' || long.text.endsWith('.'), `a long name was clipped without a marker at a ${cell}px cell: ${long.text}`)
		assert.ok(long.text.length * long.font.w * long.scale <= box[1], `the chosen text overflows the strip at a ${cell}px cell`)
	}
})

test('a large cell spends its room on the best letterforms, not the most letters', () => {
	// At 12x26 every font doubles, so the tie-break decides: 6x13 has the thickest
	// ink band of the four and wins, even though 4x6 would hold six more characters.
	const pick = choose('draftingroom', PLATE_COLS * 12, PLATE_ROWS * 26)
	assert.equal(pick?.font, F6x13)
	assert.equal(pick?.text, 'draftingroom')
})

test('a wide strip triples rather than leaving the word floating in it', () => {
	// The bug this pins: a doubled 6x13 band paints 22px, which on a 15x33 cell is
	// a thin word in a wide bar — "could be bigger", every time. Tripled it paints
	// 33px and still holds the ten letters every plate is guaranteed.
	const pick = choose('borrowyard', PLATE_COLS * 15, PLATE_ROWS * 33)
	assert.equal(pick?.font, F6x13)
	assert.equal(pick?.scale, 3)
	assert.equal(pick?.text, 'borrowyard', 'a ten-letter name should survive tripling')
})

test('a short name grows into the room a long one needs, but only one step', () => {
	const box = [PLATE_COLS * 15, PLATE_ROWS * 33] as const
	const floor = choose('borrowyard', ...box)!
	// `marina` is six letters in a strip sized for ten, so most of its plate was
	// empty — a small word in a big bar however thick the strokes were.
	const short = choose('marina', ...box)!
	assert.equal(short.scale, floor.scale + 1)
	assert.equal(short.text, 'marina', 'growing must never cost letters')
	// One step, not as many as fit: the strip's width would allow 5x here, and that
	// much variation beside a 3x neighbour reads as emphasis the room does not mean.
	assert.ok(short.scale <= floor.scale + 1)
	// Same typeface as its neighbours — three fonts in a row looked like a fault.
	assert.equal(short.font, floor.font)
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

test('a name never runs into the plate keyline', () => {
	// `quillfeather` measured 144px of ink in a 144px plate, so it overwrote the
	// border at both ends and the q's descender was clipped off — which is what
	// "cut off in the README" turned out to mean. The length axis reserves a
	// keyline and a pixel of air at each end, exactly as the width axis does.
	for (const cell of [6, 8, 10, 12, 15, 16]) {
		const w = PLATE_COLS * cell
		const h = PLATE_ROWS * cell * 2
		for (const n of ['quillfeather', 'draftingroom', 'brightwater', 'iptv-epg-matcher', 'marina']) {
			const pick = choose(n, w, h)
			assert.ok(pick, `nothing drawn for ${n} at a ${cell}px cell`)
			const ink = pick.text.length * pick.font.w * pick.scale
			assert.ok(ink <= h - 2, `${n} paints ${ink}px into a ${h}px plate at a ${cell}px cell`)
			// and the drawn plate must have a clear border row top and bottom
			const g = plate(pick.font, pick.text, w, h, [200, 100, 100], [32, 34, 46], [26, 28, 40], pick.scale)
			const border = g.grid[0][Math.floor(w / 2)]
			assert.deepEqual(border, [26, 28, 40], `${n} overwrote the top keyline at a ${cell}px cell`)
		}
	}
})

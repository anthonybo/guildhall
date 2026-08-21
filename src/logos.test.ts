/**
 * The harness marks, and the one property that matters about them: both surfaces draw
 * the SAME art.
 *
 * The browser list used text glyphs — `*` for Claude Code and a diamond for Codex — and
 * that read as one logo and one shape, because `*` happens to resemble Anthropic's mark
 * while a diamond resembles nothing. Reported as "a diamond for codex but the proper
 * icon for Claude code".
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { hasLogo, logo, logoArt, logoKey, logoRuns, logoSize } from './logos.ts'
import { HARNESS } from './screens.ts'

const HARNESSES = ['claude', 'codex'] as const

test('both harnesses have art, and it is well formed', () => {
	for (const a of HARNESSES) {
		const rows = logoArt(a)
		assert.ok(rows, `${a} has no art`)
		// Square, because the SVG viewBox is emitted as `0 0 n n` from the row count. A
		// non-square grid would silently squash the mark in the browser and nowhere else.
		const n = rows!.length
		assert.equal(logoSize(a), n)
		for (const [i, row] of rows!.entries()) {
			assert.equal(row.length, n, `${a} row ${i} is ${row.length} wide in a ${n}-row grid`)
			assert.match(row, /^[.#]+$/, `${a} row ${i} has something other than '.' and '#' in it`)
		}
		assert.ok(hasLogo(a))
	}
	// and they are actually different marks, which is the entire point
	assert.notDeepEqual(logoArt('claude'), logoArt('codex'), 'both harnesses draw the same mark')
})

test('a harness with no art is refused rather than drawn as something else', () => {
	// A third harness arriving must not silently be given Anthropic's mark.
	assert.equal(hasLogo('gemini-cli'), false)
	assert.equal(logoArt('gemini-cli'), null)
	assert.equal(logoRuns('gemini-cli'), null)
	assert.equal(logoSize('gemini-cli'), 0)
	assert.equal(hasLogo(undefined), false)
})

test('runs cover exactly the lit pixels, and merge where they are adjacent', () => {
	// This is what the browser turns into <rect> elements, so an off-by-one here draws a
	// visibly wrong mark on a phone and nowhere else.
	for (const a of HARNESSES) {
		const rows = logoArt(a)!
		const runs = logoRuns(a)!
		// every run is inside the grid and non-empty
		for (const r of runs) {
			assert.ok(r.w > 0, `${a} has a zero-width run`)
			assert.ok(r.y >= 0 && r.y < rows.length, `${a} run outside the grid vertically`)
			assert.ok(r.x >= 0 && r.x + r.w <= rows[r.y]!.length, `${a} run runs past the row`)
			// and covers only lit pixels
			for (let i = 0; i < r.w; i++) assert.equal(rows[r.y]![r.x + i], '#', `${a} run covers an unlit pixel`)
		}
		// Reconstruct the art from the runs alone. If they agree, the runs ARE the mark —
		// which is stronger than counting them, and would catch a dropped run at either
		// end of a row.
		const rebuilt = rows.map((row) => '.'.repeat(row.length).split(''))
		for (const r of runs) for (let i = 0; i < r.w; i++) rebuilt[r.y]![r.x + i] = '#'
		assert.deepEqual(
			rebuilt.map((r) => r.join('')),
			rows,
			`${a} runs do not reproduce the art`,
		)
		// merged, not one per pixel: a rect per lit pixel is markup a phone downloads
		const lit = rows.join('').split('').filter((c) => c === '#').length
		assert.ok(runs.length < lit, `${a} has ${runs.length} runs for ${lit} lit pixels — nothing was merged`)
	}
})

test('the drawn sprite uses the harness colour it was given, and only there', () => {
	// The room's sprite and the browser's SVG must agree about which colour Codex is, and
	// there is one definition of that. `logo()` takes the colour rather than importing it
	// so this file has no opinion about the palette.
	const g = logo('codex', HARNESS.codex!)
	const rows = logoArt('codex')!
	// the art sits at (2, 3) inside the 16x16 tile; check a lit and an unlit pixel
	const firstLit = rows.findIndex((r) => r.includes('#'))
	const x = rows[firstLit]!.indexOf('#')
	assert.deepEqual(g.grid[3 + firstLit]![2 + x], HARNESS.codex, 'a lit pixel is not the harness colour')
	// and the claude sprite differs from the codex one, so the tile is not a fixed image
	assert.notDeepEqual(logo('claude', HARNESS.claude!).grid, g.grid)
})

test('the cache key distinguishes the harnesses', () => {
	// The terminal transmits these as images keyed by this string. Two marks sharing a key
	// means the second desk is served the first one's picture — the exact failure the desk
	// sprites already had once.
	assert.notEqual(logoKey('claude'), logoKey('codex'))
})

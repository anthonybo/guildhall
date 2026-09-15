/**
 * The authored half of the font.
 *
 * The bug this exists for: every bitmap font in nameplate.ts holds 39 glyphs — lowercase,
 * digits and `-_.` — because it was converted for project names. Drawing a terminal with it
 * dropped every capital and almost every mark, and the failure was SILENT: the advance
 * still happened, so the text came out spaced correctly with letters simply missing.
 * `Refresh` rendered as `efresh`. Nothing threw, and the layout looked right.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FULL6x13, glyphRows } from './font.ts'
import { F6x13 } from './nameplate.ts'

/** Every character a terminal realistically prints. */
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))

test('every printable ASCII character has a glyph', () => {
	const missing = PRINTABLE.filter((ch) => !FULL6x13.g[ch])
	assert.deepEqual(missing, [], `no picture for ${JSON.stringify(missing.join(''))}`)
})

test('no glyph is blank except the space', () => {
	// A blank picture is the same silent failure as a missing one: correct spacing, no
	// letter. Only the space is allowed to draw nothing.
	const blank = PRINTABLE.filter((ch) => ch !== ' ' && (glyphRows(ch) ?? []).every((b) => b === 0))
	assert.deepEqual(blank, [], `blank glyphs: ${JSON.stringify(blank.join(''))}`)
})

test('a space draws nothing but still takes its place', () => {
	// Indentation is what makes terminal output readable as output, so the space has to
	// advance. It is a real entry with an empty picture, not a missing one.
	assert.ok(FULL6x13.g[' '], 'the space has no entry, so it would fall through as unknown')
	assert.deepEqual(glyphRows(' '), new Array(FULL6x13.h).fill(0))
})

test('no two characters draw the same picture', () => {
	// Catches a copy-paste in the authored table — two letters that look plausible on their
	// own and are indistinguishable in a word.
	const seen = new Map<string, string>()
	for (const ch of PRINTABLE) {
		if (ch === ' ') continue
		const key = (glyphRows(ch) ?? []).join(',')
		const other = seen.get(key)
		assert.equal(other, undefined, `${JSON.stringify(ch)} and ${JSON.stringify(other)} draw the same glyph`)
		seen.set(key, ch)
	}
})

test('capitals sit on the same baseline as lowercase and never descend', () => {
	// Measured off `b`, whose ascender starts at row 2 and whose baseline is row 10. A
	// capital hanging below that would collide with the line under it.
	for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
		const rows = glyphRows(ch)!
		const ink = rows.map((b, i) => (b ? i : -1)).filter((i) => i >= 0)
		assert.ok(ink.length > 0, `${ch} is blank`)
		assert.ok(ink[ink.length - 1]! <= 10, `${ch} descends to row ${ink[ink.length - 1]}, below the baseline`)
		assert.ok(ink[0]! >= 2, `${ch} rises to row ${ink[0]}, above the ascender line`)
	}
})

test('nothing draws outside the six-pixel cell', () => {
	// A glyph wider than the advance would smear into its neighbour.
	for (const ch of PRINTABLE) {
		for (const b of glyphRows(ch) ?? []) assert.ok(b >>> 0 < 1 << FULL6x13.w, `${JSON.stringify(ch)} has ink outside ${FULL6x13.w} pixels`)
	}
})

test('the converted lowercase is not disturbed by the authored half', () => {
	// The authored table is merged OVER the converted one, so a stray key — an `a` typed
	// where an `A` was meant — would silently replace a real X11 glyph with a hand-drawn
	// guess. Compared against the ORIGINAL table, which is the only thing that can catch it.
	const original = F6x13.g as Record<string, string>
	for (const ch of Object.keys(original)) {
		assert.equal(FULL6x13.g[ch], original[ch], `${JSON.stringify(ch)} was overwritten by an authored glyph`)
	}
	// `b` is what the cap metrics were measured from: ascender at row 2, baseline at row 10.
	const b = glyphRows('b')!.map((x, i) => (x ? i : -1)).filter((i) => i >= 0)
	assert.equal(b[0], 2, 'the b that defines the ascender line moved')
	assert.equal(b[b.length - 1], 10, 'the b that defines the baseline moved')
})

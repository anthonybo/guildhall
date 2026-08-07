import assert from 'node:assert/strict'
import test from 'node:test'
import { panel } from './help.ts'
import { footer } from './table.ts'
import { LOOK } from './theme.ts'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const flat = (cols = 100, rows = 46) => strip(panel(cols, rows).join(' '))

test('the panel answers what the glyphs cannot say for themselves', () => {
	const t = flat()
	// the questions this app has actually been asked
	assert.match(t, /do not sleep while something/, 'does not say the sleep hold is conditional')
	assert.match(t, /display still|closing the lid/, 'does not state the sleep limits')
	assert.match(t, /work done, not time spent/, 'does not explain what a level counts')
	assert.match(t, /waiting on an answer/, 'does not explain the ? placard')
})

test('every status has a line, so the legend is never partial', () => {
	const t = flat()
	for (const [state, look] of Object.entries(LOOK)) {
		assert.ok(t.includes(look.label), `no help line for ${state}`)
	}
})

test('the panel fits the box it is given', () => {
	for (const [cols, rows] of [
		[120, 50],
		[100, 46],
		[80, 40],
		[60, 30],
	]) {
		const lines = panel(cols, rows)
		assert.equal(lines.length, rows, `wrong height at ${cols}x${rows}`)
		for (const l of lines) assert.ok(strip(l).length <= cols, `overflowed ${cols}: ${strip(l).length}`)
	}
})

test('the footer advertises the help key', () => {
	// a help key nobody can find is not a help key
	assert.match(strip(footer(120, 0, false, 'split')), /\? help/)
})

test('the help hint is the last thing a narrow terminal loses', () => {
	// the footer is clipped from the right, so a hint at the tail vanishes exactly
	// when someone on a small screen most needs to know how to ask what this means
	for (const w of [130, 100, 80, 60, 46, 30]) {
		assert.match(strip(footer(w, 0, false, 'split')), /\? help/, `lost the help hint at ${w} columns`)
	}
})

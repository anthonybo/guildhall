import assert from 'node:assert/strict'
import test from 'node:test'
import * as H from './help.ts'
import { panel } from './help.ts'
import { footer } from './table.ts'
import { LOOK } from './theme.ts'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const flat = (cols = 100, rows = 46) => strip(panel(cols, rows).join(' '))

test('the panel answers what the glyphs cannot say for themselves', () => {
	const t = flat()
	// the questions this app has actually been asked
	assert.match(t, /do not sleep while something/, 'does not say the sleep hold is conditional')
	assert.match(t, /[Cc]losing the lid/, 'does not state the sleep limits')
	// the screen blanking and locking while "awake" was on read as the feature not
	// working at all, so the panel has to say the display is covered now
	assert.match(t, /screen is held on/, 'does not say the display is held too')
	assert.match(t, /awakeDisplay/, 'does not say how to let the screen sleep')
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

test('a help panel taller than the window scrolls instead of losing its bottom', () => {
	// It needs about 90 rows and a real terminal has far fewer, so everything past
	// the fold — the address to open, the passcode keys — used to be silently cut
	// off. Reported from a second machine as not being able to reach the port.
	const share = { on: true, port: 4318, token: 'x', lan: ['192.168.1.24'], vpn: [], pin: null, pinNote: '' }
	const rows = 30
	const hidden = H.overflow(120, rows, share)
	assert.ok(hidden > 0, 'this size was expected to overflow, so the rest of the test proves nothing')
	// the port is NOT on the first screen, and IS reachable by scrolling
	assert.ok(!H.panel(120, rows, share, undefined, 0).join('\n').includes('4318'), 'nothing to scroll to')
	const reached = Array.from({ length: hidden + 2 }, (_, s) => H.panel(120, rows, share, undefined, s).join('\n')).some((t) => t.includes('4318'))
	assert.ok(reached, 'the port section cannot be reached by scrolling')
	// every screen says there is more, and scrolling past the end still renders
	assert.match(H.panel(120, rows, share, undefined, 0).join('\n'), /more line/)
	assert.ok(H.panel(120, rows, share, undefined, 9999).filter((l) => l.trim()).length > 5, 'over-scrolling blanks the panel')
	// and a window tall enough is left exactly as it was, with no hint
	assert.doesNotMatch(H.panel(120, 200, share).join('\n'), /more line/)
})

test('the port can be changed from the panel, not just read off it', () => {
	// The panel showed the port and offered no way to change it, so the only routes
	// were a --port flag or hand-editing the config — neither reachable from the
	// screen that tells you the port exists.
	const share = { on: true, port: 4318, token: 'x', lan: ['192.168.1.24'], vpn: [], pin: null, pinNote: '' }
	assert.match(strip(panel(100, 200, share).join(' ')), /o to change the port/)
	// mid-entry the port line BECOMES the field, so there are never two ports on
	// screen at once for the reader to pick the wrong one from
	const typing = strip(panel(100, 200, { ...share, portEntry: '446' }).join(' '))
	assert.match(typing, /new port\s+446/)
	assert.doesNotMatch(typing, /sharing on port 4318/)
	// and a rejected change explains itself rather than silently reverting
	assert.match(strip(panel(100, 200, { ...share, portNote: '4472 is in use — kept 4318' }).join(' ')), /in use/)
})

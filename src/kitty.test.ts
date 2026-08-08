import assert from 'node:assert/strict'
import test from 'node:test'
import { demux } from './kitty.ts'

const E = '\x1b'

test('keystrokes pass through untouched', () => {
	for (const k of ['q', '\r', '\n', '\t', 'r', 'f', '\x03']) {
		assert.deepEqual(demux(k), { keys: k, rest: '', lost: false }, `swallowed ${JSON.stringify(k)}`)
	}
})

test('arrow keys survive the reply filter', () => {
	// these are complete CSI sequences and must not be held back as partial ones,
	// or every keypress would arrive one keypress late
	for (const k of [`${E}[A`, `${E}[B`, `${E}[C`, `${E}[D`]) {
		assert.deepEqual(demux(k), { keys: k, rest: '', lost: false })
	}
})

test('an image-gone reply is consumed and reported', () => {
	const r = demux(`${E}_Gi=1001,p=1;ENOENT: image not found${E}\\`)
	assert.equal(r.lost, true)
	assert.equal(r.keys, '')
})

test('a visibility report means the surface came back', () => {
	assert.equal(demux(`${E}[?999;1n`).lost, true)
	// and a size report means it moved or resized
	assert.equal(demux(`${E}[48;24;80;432;720t`).lost, true)
})

test('a reply mixed with typing keeps only the typing', () => {
	const r = demux(`q${E}[?999;1nr`)
	assert.equal(r.lost, true)
	assert.equal(r.keys, 'qr')
})

test('a reply split across two reads is not delivered as keystrokes', () => {
	const whole = `${E}[?999;1n`
	const a = demux(whole.slice(0, 4))
	assert.equal(a.keys, '', 'delivered half an escape as typing')
	assert.equal(a.lost, false)
	const b = demux(a.rest + whole.slice(4))
	assert.equal(b.lost, true, 'the rejoined reply was not recognised')
	assert.equal(b.keys, '')
})

test('an unrecognised escape is eventually released, not held forever', () => {
	// a sequence we do not know must still reach onKey rather than wedging the
	// buffer and silently eating every later keystroke
	const r = demux(`${E}[200~`)
	assert.equal(r.rest, '', 'held a complete sequence')
})

test('a chunk ending on a bare introducer is held, not released', () => {
	// `ESC [` alone is the start of a CSI, not a complete escape; releasing it
	// would deliver a stray ESC and then misread the rest of the sequence as keys
	assert.equal(demux(`${E}[`).keys, '')
	assert.equal(demux(`${E}[`).rest, `${E}[`)
	assert.equal(demux(`${E}O`).rest, `${E}O`)
})

test('focus-in triggers a re-send and focus-out does not', () => {
	// cmux does not implement mode 2033, so focus-in is the only byte a workspace
	// switch-back produces there. Focus-out is unreliable — switching away from an
	// already-unfocused surface emits nothing — so it is consumed but never acted on.
	const inn = demux(`${E}[I`)
	assert.equal(inn.lost, true)
	assert.equal(inn.keys, '', 'focus-in leaked into the key handler')
	const out = demux(`${E}[O`)
	assert.equal(out.lost, false, 'focus-out should not force a re-send')
	assert.equal(out.keys, '', 'focus-out leaked into the key handler')
})

test('a lone Escape is delivered at once, not held for the next key', () => {
	// Holding it meant Escape never arrived until something else was pressed, and
	// the held byte then prefixed that key: ESC followed by `?` reached the handler
	// as one unrecognised two-byte string, so both were swallowed. That is why the
	// help panel appeared to need two presses to open and two to close.
	const a = demux(E)
	assert.equal(a.keys, E, 'Escape was swallowed')
	assert.equal(a.rest, '', 'Escape was held back')

	const b = demux(a.rest + '?')
	assert.equal(b.keys, '?', 'the following key was corrupted by a held Escape')
})

test('holding a genuine partial sequence still works', () => {
	// the fix must not cost us the thing the buffer is for
	assert.equal(demux(`${E}[`).rest, `${E}[`)
	assert.equal(demux(`${E}[1`).rest, `${E}[1`)
	assert.equal(demux(`${E}[A`).keys, `${E}[A`, 'a complete arrow was held')
})

test('a burst of typing arrives as one read, and must be split into keys', () => {
	// The bug this pins: typing a password and pressing return reaches the app as
	// the single string "my pass\r", not eight reads. Code comparing that whole
	// chunk against '\r' never matched, so the return was appended to the password
	// as a character and there was no way to save it. The passcode had it too.
	const { keys } = demux('my pass\r')
	assert.equal(keys, 'my pass\r', 'demux should hand the whole burst through')
	// whatever splits it must end with the return as its own key
	const split = [...keys]
	assert.equal(split.at(-1), '\r')
	assert.equal(split.length, 8)
})

test('an escape sequence survives being split into keys', () => {
	// An arrow key is ESC [ A. If splitting a burst breaks it into three, the ESC
	// reads as "cancel" and the entry is thrown away mid-word.
	const { keys } = demux('\x1b[A')
	assert.equal(keys, '\x1b[A')
	assert.ok(keys.startsWith('\x1b['), 'the sequence must arrive whole')
})

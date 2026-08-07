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

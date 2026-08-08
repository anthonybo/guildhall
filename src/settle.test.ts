/**
 * Name stability. Every case here is one a person watching the list would notice.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { HOLD_MS, prune, reset, settle } from './data/settle.ts'

test('a session gets its name immediately, with no hold', () => {
	reset()
	// A fresh session has no identity to protect, and making it wait ten minutes
	// for a name would be a worse bug than the one this file exists to fix.
	assert.deepEqual(settle('a', 'guildhall', 1000), { name: 'guildhall' })
})

test('a detour shows as a journey, not a rename', () => {
	reset()
	settle('a', 'guildhall', 0)
	// This is the reported confusion: an hour spent in a sibling project renamed
	// the row, so the session being talked to appeared to vanish.
	const away = settle('a', 'pressroom', 60_000)
	assert.equal(away.name, 'guildhall', 'the name moved on a detour')
	assert.equal(away.away, 'pressroom', 'the detour was not shown')
})

test('coming home before the hold elapses leaves no trace', () => {
	reset()
	settle('a', 'guildhall', 0)
	settle('a', 'pressroom', 60_000)
	assert.deepEqual(settle('a', 'guildhall', 120_000), { name: 'guildhall' })
})

test('a move that sticks becomes the name', () => {
	reset()
	settle('a', 'guildhall', 0)
	settle('a', 'pressroom', 1000)
	// Still a detour a minute in...
	assert.equal(settle('a', 'pressroom', 61_000).name, 'guildhall')
	// ...and a real move once it has held. Otherwise a session that genuinely
	// changed project would carry the wrong name for the rest of its life.
	assert.deepEqual(settle('a', 'pressroom', 1000 + HOLD_MS), { name: 'pressroom' })
})

test('the hold restarts when the wandering wanders again', () => {
	reset()
	settle('a', 'guildhall', 0)
	settle('a', 'pressroom', 1000)
	// Nine minutes in pressroom, then somewhere else entirely: that is not nine
	// minutes of evidence for willow, and it must not inherit the head start.
	settle('a', 'willow', 540_000)
	assert.equal(settle('a', 'willow', 540_000 + HOLD_MS - 1).name, 'guildhall')
	assert.equal(settle('a', 'willow', 540_000 + HOLD_MS).name, 'willow')
})

test('sessions that end are forgotten', () => {
	reset()
	settle('a', 'guildhall', 0)
	settle('b', 'willow', 0)
	prune(['b'])
	// `a` is gone, so its next appearance is a first sight and takes the new name
	// outright. Without pruning this map grows for the life of the process.
	assert.deepEqual(settle('a', 'pressroom', 1000), { name: 'pressroom' })
})

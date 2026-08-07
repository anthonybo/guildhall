import assert from 'node:assert/strict'
import test from 'node:test'
import { holders, shouldHold } from './awake.ts'
import { awakeBadge, footer } from './table.ts'
import type { Session, State } from './data.ts'

const s = (proj: string, state: State) => ({ proj, state }) as Session

test('the machine is held only while something is actually working', () => {
	assert.equal(shouldHold([s('a', 'working')]), true)
	assert.equal(shouldHold([s('a', 'shell')]), true, 'a running command still counts')
	assert.equal(shouldHold([]), false)
})

test('waiting on you is not a reason to stay awake', () => {
	// these are all states where the session has stopped and is waiting; holding
	// the machine open for them would mean never sleeping again
	for (const state of ['needs', 'review', 'done', 'parked', 'error'] as State[]) {
		assert.equal(shouldHold([s('a', state)]), false, `${state} kept the machine awake`)
	}
})

test('one worker among idlers is enough', () => {
	const room = [s('a', 'parked'), s('b', 'needs'), s('c', 'working'), s('d', 'done')]
	assert.equal(shouldHold(room), true)
	assert.deepEqual(holders(room), ['c'], 'the reason shown must be the session responsible')
})

test('the three awake states are told apart by more than colour', () => {
	// a colour-blind reader, or a terminal that drops SGR, must still be able to
	// tell "switched off" from "on but nobody working"
	const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
	const held = strip(awakeBadge({ armed: true, holding: true }))
	const idle = strip(awakeBadge({ armed: true, holding: false }))
	const off = strip(awakeBadge({ armed: false, holding: false }))

	assert.equal(new Set([held, idle, off]).size, 3, 'two states read identically without colour')
	// each must name the CONDITION, not just a switch position: "awake ON" invited
	// the reading that the machine would never sleep at all
	assert.match(held, /holding awake/)
	assert.match(idle, /when working/, 'armed state must say sleep is conditional')
	assert.match(idle, /may sleep/, 'armed state must admit the machine can sleep now')
	assert.match(off, /sleeps normally/)
	// and each carries a distinct glyph
	assert.equal(new Set([held[0], idle[0], off[0]]).size, 3, 'glyphs collide')
})

test('every awake colour is a measured-contrast palette value', () => {
	// no dim greys here: the OFF state in particular has to be noticeable, since
	// that is when an overnight build can be lost
	for (const state of [
		{ armed: true, holding: true },
		{ armed: true, holding: false },
		{ armed: false, holding: false },
	]) {
		const badge = awakeBadge(state)
		assert.doesNotMatch(badge, /38;2;110;118;129/, 'used the faint chrome colour for a status')
		assert.match(badge, /\x1b\[38;2;\d+;\d+;\d+m/, 'no colour at all')
	}
})

test('the footer names the action, never the current state', () => {
	// `a awake on` read as a claim that awake was already on, when it meant "press
	// this to turn it on" — so the hint said the opposite of the truth
	const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
	const whenOn = strip(footer(120, 0, false, 'split', { armed: true, holding: false }))
	const whenOff = strip(footer(120, 0, false, 'split', { armed: false, holding: false }))

	assert.match(whenOn, /a ◐ allow sleep/, 'armed should offer to allow sleep')
	assert.match(whenOff, /a ○ keep awake/, 'disarmed should offer to keep awake')
	// the hint must never assert a state, which is what caused the confusion
	assert.doesNotMatch(whenOn, /awake on|awake off/)
	assert.doesNotMatch(whenOff, /awake on|awake off/)
})

test('the footer carries the state colour, since that is where the key is', () => {
	const holding = footer(120, 0, false, 'split', { armed: true, holding: true })
	const off = footer(120, 0, false, 'split', { armed: false, holding: false })
	assert.match(holding, /38;2;95;175;95/, 'holding is not green in the footer')
	assert.match(off, /38;2;215;175;95/, 'off is not amber in the footer')
})

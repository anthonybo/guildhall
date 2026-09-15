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
	const whenAlways = strip(footer(120, 0, false, 'split', { armed: true, holding: true, always: true }))

	// `a` cycles three states, so each hint names the NEXT one round: off offers to hold
	// while sessions work, armed offers to hold regardless, always offers to stop.
	assert.match(whenOff, /a ○ keep awake/, 'disarmed should offer to keep awake')
	assert.match(whenOn, /a ◐ never sleep/, 'armed should offer to hold the machine regardless')
	assert.match(whenAlways, /a ◉ allow sleep/, 'forced should offer to let it sleep')
	// the hint must never assert a state, which is what caused the confusion
	for (const line of [whenOn, whenOff, whenAlways]) assert.doesNotMatch(line, /awake on|awake off/)
})

test('a machine that will never sleep says so in its own glyph', () => {
	// The state worth seeing: `always` outlives a restart, so if it looked the same as an
	// ordinary hold it would be a laptop quietly never sleeping with nothing on screen
	// saying why. It has to be distinguishable from `holding`, which is the same pixel
	// count and a different fact.
	const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
	const holding = strip(footer(120, 0, false, 'split', { armed: true, holding: true }))
	const always = strip(footer(120, 0, false, 'split', { armed: true, holding: true, always: true }))
	assert.notEqual(holding, always, 'forced awake is indistinguishable from an ordinary hold')
	assert.match(holding, /a ● /)
	assert.match(always, /a ◉ /)
})

test('the footer carries the state colour, since that is where the key is', () => {
	const holding = footer(120, 0, false, 'split', { armed: true, holding: true })
	const off = footer(120, 0, false, 'split', { armed: false, holding: false })
	assert.match(holding, /38;2;95;175;95/, 'holding is not green in the footer')
	assert.match(off, /38;2;215;175;95/, 'off is not amber in the footer')
})

test('forced awake holds with nobody working, and an empty room', async () => {
	// The whole point. `shouldHold` is false here — no session is working — and the
	// ordinary armed state would release. Forced must not.
	const { configure, isAlways, wants } = await import('./awake.ts')
	try {
		// `wants`, not the flags: the first version of this test asserted `isAlways()` and
		// passed with the force taken out of the condition altogether. Mutation caught it.
		configure(true, false, true)
		assert.equal(shouldHold([]), false, 'the room is idle, which is the case that matters')
		assert.equal(wants([]), true, 'forced awake did not hold an idle room')
		assert.equal(wants([s('a', 'parked')]), true, 'forced awake did not hold a room of parked sessions')
		// and disarming must not release it: with `always` set, armed is irrelevant
		configure(false, false, true)
		assert.equal(isAlways(), true, 'disarming cancelled a setting that says never sleep')
		assert.equal(wants([]), true, 'disarming let an idle machine sleep despite the force')
	} finally {
		configure(true, true, false)
	}
})

test('turning forced awake off leaves the ordinary hold alone', async () => {
	const { configure, isAlways, isArmed } = await import('./awake.ts')
	try {
		configure(true, true, true)
		configure(true, true, false)
		assert.equal(isAlways(), false)
		assert.equal(isArmed(), true, 'dropping the force also disarmed the conditional hold')
	} finally {
		configure(true, true, false)
	}
})

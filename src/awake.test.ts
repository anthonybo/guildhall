import assert from 'node:assert/strict'
import test from 'node:test'
import { holders, shouldHold } from './awake.ts'
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

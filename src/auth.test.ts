import assert from 'node:assert/strict'
import test from 'node:test'
import { attempt, issue, lockedFor, passcode, resetThrottle, triesLeft, valid } from './auth.ts'
import { loginPage } from './login.ts'

test('the passcode is four digits and stable across reads', () => {
	const a = passcode()
	assert.match(a, /^\d{4}$/)
	assert.equal(a, passcode(), 'a new code every read would mean re-pairing constantly')
})

test('the page never contains the passcode', () => {
	// reading the source must tell an attacker nothing they did not already have
	const code = passcode()
	for (const state of [{}, { wrong: true, triesLeft: 3 }, { waitSeconds: 30 }]) {
		assert.doesNotMatch(loginPage(state), new RegExp(code), 'leaked the code into the page')
	}
})

test('a wrong code is refused and a right one issues a session', () => {
	resetThrottle()
	const addr = '10.0.0.1'
	const wrong = String((Number(passcode()) + 1) % 10000).padStart(4, '0')
	assert.equal(attempt(addr, wrong).ok, false)
	assert.equal(attempt(addr, passcode()).ok, true)
})

test('a short code cannot be brute-forced: the throttle bites', () => {
	// four digits is 10,000 combinations, which is seconds of scripting — so the
	// code is not the security, the throttle is
	resetThrottle()
	const addr = '10.0.0.99'
	for (let i = 0; i < 5; i++) attempt(addr, '0000', 1000)
	assert.ok(lockedFor(addr, 1000) > 0, 'unlimited guessing allowed')
	assert.equal(attempt(addr, passcode(), 1000).ok, false, 'a locked address got in with the right code')

	// and the wait doubles, so a patient attacker gets slower, not steadier
	const first = lockedFor(addr, 1000)
	attempt(addr, '0000', 1000 + first + 1)
	const second = lockedFor(addr, 1000 + first + 1)
	assert.ok(second > first, `lockout did not grow: ${first} then ${second}`)
})

test('a correct code clears the record, so a typo is not remembered forever', () => {
	resetThrottle()
	const addr = '10.0.0.7'
	attempt(addr, '0000')
	attempt(addr, '0000')
	assert.equal(triesLeft(addr), 3)
	attempt(addr, passcode())
	assert.equal(triesLeft(addr), 5, 'a good code should reset the counter')
})

test('throttling is per address, so one device cannot lock out another', () => {
	resetThrottle()
	for (let i = 0; i < 6; i++) attempt('10.0.0.2', '0000', 1000)
	assert.ok(lockedFor('10.0.0.2', 1000) > 0)
	assert.equal(lockedFor('10.0.0.3', 1000), 0, 'one bad device locked out the rest of the house')
})

test('a session id is long and random, never the code', () => {
	const id = issue()
	assert.ok(id.length >= 30, 'session id is too short to be unguessable')
	assert.notEqual(id, passcode())
	assert.equal(valid(id), true)
	assert.equal(valid('not-a-session'), false)
})

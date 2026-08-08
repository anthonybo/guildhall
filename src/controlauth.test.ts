import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// never touch the real credential; set before the imports that read it
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-control-'))

import { MIN_LENGTH, controlAllowed, controlAttempt, controlLockedFor, controlReachable, hasControlPass, resetControlThrottle, setControlPass } from './controlauth.ts'
import { refuses } from './control.ts'

const GOOD = 'correct horse battery'

test('a passphrase is stored hashed, never in plain text', () => {
	// The file lives in a config directory that gets backed up and sometimes
	// synced. It must not contain anything anyone could type.
	assert.deepEqual(setControlPass(GOOD), { ok: true })
	const raw = fs.readFileSync(path.join(process.env.GUILDHALL_CONFIG_DIR!, 'control-pass'), 'utf8')
	assert.ok(!raw.includes(GOOD), 'the passphrase itself is on disk')
	assert.match(raw, /^scrypt\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/m)
	assert.equal(fs.statSync(path.join(process.env.GUILDHALL_CONFIG_DIR!, 'control-pass')).mode & 0o777, 0o600)
})

test('the right passphrase is accepted and a wrong one is not', () => {
	setControlPass(GOOD)
	assert.ok(hasControlPass())
	assert.ok(controlAllowed(GOOD))
	assert.ok(!controlAllowed(GOOD + ' '))
	assert.ok(!controlAllowed('correct horse batter'))
	assert.ok(!controlAllowed(undefined))
	assert.ok(!controlAllowed(''))
})

test('a phrase too short or too repetitive is refused', () => {
	// It has to be typed on a phone, so it is chosen rather than random — which
	// means length is the only thing carrying its entropy.
	assert.equal(setControlPass('short').ok, false)
	assert.equal(setControlPass('a'.repeat(MIN_LENGTH + 5)).ok, false, 'one repeated character is long but not hard')
	assert.equal(setControlPass('abcdefabcdefab').ok, true, 'a long phrase with enough variety should pass')
})

test('changing it invalidates the old one', () => {
	setControlPass(GOOD)
	assert.ok(controlAllowed(GOOD))
	setControlPass('a different phrase entirely')
	assert.ok(!controlAllowed(GOOD), 'the replaced phrase still works')
	assert.ok(controlAllowed('a different phrase entirely'))
})

test('guessing is throttled, which is what makes a chosen phrase safe', () => {
	// A random 128-bit token needs no throttle. A phrase you can remember does:
	// this is what turns an online dictionary attack into something impractical.
	resetControlThrottle()
	setControlPass(GOOD)
	const who = '100.64.0.9' // allow-personal: synthetic CGNAT literals, which are what this test exercises
	for (let i = 0; i < 5; i++) assert.ok(!controlAttempt(who, 'wrong guess here'), 'a wrong guess was accepted')
	assert.ok(controlLockedFor(who) > 0, 'five wrong tries did not lock the address')
	// and the lock holds even against the CORRECT phrase, or it would be no lock
	assert.ok(!controlAttempt(who, GOOD), 'the lock let the right answer through')
	resetControlThrottle()
	assert.ok(controlAttempt(who, GOOD), 'a cleared throttle should accept the right phrase')
})

test('a correct answer clears the count', () => {
	resetControlThrottle()
	setControlPass(GOOD)
	const who = '100.64.0.10' // allow-personal: synthetic CGNAT literals, which are what this test exercises
	controlAttempt(who, 'nope nope nope')
	controlAttempt(who, 'nope nope nope')
	assert.ok(controlAttempt(who, GOOD))
	for (let i = 0; i < 4; i++) controlAttempt(who, 'nope nope nope')
	assert.equal(controlLockedFor(who), 0, 'the earlier failures were not forgiven')
})

test('only loopback and a tailnet may control; a LAN address may not', () => {
	for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.100.100.100', '100.127.255.254']) { // allow-personal: synthetic CGNAT literals, which are what this test exercises
		assert.ok(controlReachable(ok), `${ok} should be allowed`)
	}
	for (const no of ['192.168.1.20', '10.0.0.5', '172.16.4.4', '100.63.255.255', '100.128.0.1', '8.8.8.8', undefined]) {
		assert.ok(!controlReachable(no), `${no} should be refused`)
	}
})

test('keys that would answer a permission prompt are refused', () => {
	for (const k of ['y', 'n', 'a', 'd', 'Y', 'Escape', 'Tab']) assert.ok(refuses(k), `${k} should be refused`)
})

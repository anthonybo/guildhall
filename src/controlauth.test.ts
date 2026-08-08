import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// never touch the real token; set before the import that reads the directory
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-control-'))

import { controlAllowed, controlReachable, controlToken, forgetControlToken, rotateControlToken } from './controlauth.ts'
import { refuses } from './control.ts'

test('the control token is long enough that a throttle is not doing the work', () => {
	// 128 bits. The view passcode is four digits and leans on an exponential
	// lockout; this credential types into Claude Code sessions, so it cannot.
	const t = controlToken()
	assert.match(t, /^[0-9a-f]{32}$/)
	assert.equal(controlToken(), t, 'the token must be stable across calls')
	forgetControlToken()
	assert.equal(controlToken(), t, 'the token must survive being re-read from disk')
})

test('the token file is not world readable', () => {
	controlToken()
	const mode = fs.statSync(path.join(process.env.GUILDHALL_CONFIG_DIR!, 'control-token')).mode & 0o777
	assert.equal(mode, 0o600, `token file is ${mode.toString(8)}`)
})

test('rotating invalidates the old token', () => {
	const before = controlToken()
	const after = rotateControlToken()
	assert.notEqual(before, after)
	assert.ok(controlAllowed(after))
	assert.ok(!controlAllowed(before), 'the rotated-out token still works')
})

test('a wrong, short, or absent token is refused', () => {
	assert.ok(!controlAllowed(undefined))
	assert.ok(!controlAllowed(''))
	assert.ok(!controlAllowed('nope'))
	assert.ok(!controlAllowed('0'.repeat(32)))
	// the right length but not hex, so the shape check has to catch it before
	// timingSafeEqual is handed buffers of differing length
	assert.ok(!controlAllowed('z'.repeat(32)))
})

test('only loopback and a tailnet may control; a LAN address may not', () => {
	// A shared secret on a plain LAN is one guest network away from arbitrary code
	// execution here. Watching over a LAN is fine; typing is not.
	for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.101.102.103', '100.127.255.254']) {
		assert.ok(controlReachable(ok), `${ok} should be allowed`)
	}
	for (const no of ['192.168.1.20', '10.0.0.5', '172.16.4.4', '100.63.255.255', '100.128.0.1', '8.8.8.8', undefined]) {
		assert.ok(!controlReachable(no), `${no} should be refused`)
	}
})

test('keys that would answer a permission prompt are refused', () => {
	// The whole safety story rests on a person approving tool use. A remote
	// `send-key y` is indistinguishable from consent.
	for (const k of ['y', 'n', 'a', 'd', 'Y', 'Escape', 'Tab']) assert.ok(refuses(k), `${k} should be refused`)
})

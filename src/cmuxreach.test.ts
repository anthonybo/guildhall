/**
 * Whether this process can drive cmux, and whether it says so usefully.
 *
 * The failure: cmux's socket runs in `access_mode: cmuxOnly`, so it accepts control only
 * from processes started inside cmux, which inherit `CMUX_SOCKET_CAPABILITY` from their
 * pane. launchd gives its jobs almost no environment, so the installed service — the
 * default way to serve the browser view — could read every session and type into none.
 * A phone showed cmux's own words, "only processes started inside cmux can connect",
 * under a panel that said control was on.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-cmuxreach-'))

import { cmuxEnv, reach, socketPassword } from './cmuxreach.ts'

const PASS_FILE = path.join(process.env.GUILDHALL_CONFIG_DIR!, 'cmux-password')
// Named so it can never be mistaken for a real credential, the rule this repo adopted
// after a throwaway script overwrote a live password with a plausible-looking string.
const FIXTURE = 'TEST-ONLY-not-a-real-cmux-password' // allow-secret: a test fixture, and it says so

/** Run `fn` with the cmux environment this process really has taken away. */
function withoutCmux<T>(fn: () => T): T {
	const had = process.env.CMUX_SOCKET_CAPABILITY
	delete process.env.CMUX_SOCKET_CAPABILITY
	try {
		return fn()
	} finally {
		if (had !== undefined) process.env.CMUX_SOCKET_CAPABILITY = had
	}
}

test('a process started inside cmux is allowed, on the strength of its capability alone', () => {
	const had = process.env.CMUX_SOCKET_CAPABILITY
	process.env.CMUX_SOCKET_CAPABILITY = 'v1.test-capability'
	try {
		assert.deepEqual(reach(), { ok: true }, 'a pane-started process was refused')
		// and it is NOT handed a password it does not need — one less place a secret goes
		fs.writeFileSync(PASS_FILE, FIXTURE)
		assert.equal(cmuxEnv().CMUX_SOCKET_PASSWORD, undefined, 'a capability-holding process was given the password as well')
		fs.rmSync(PASS_FILE)
	} finally {
		if (had === undefined) delete process.env.CMUX_SOCKET_CAPABILITY
		else process.env.CMUX_SOCKET_CAPABILITY = had
	}
})

test('a stored socket password authorizes a process that cmux did not start', () => {
	// This is the fix for the launchd service, which can never have a capability.
	withoutCmux(() => {
		fs.writeFileSync(PASS_FILE, FIXTURE)
		try {
			assert.equal(socketPassword(), FIXTURE)
			assert.deepEqual(reach(), { ok: true }, 'a stored password did not authorize the process')
			// Passed as an ENVIRONMENT VARIABLE, never as an argument: argv is readable by
			// every process on this machine through `ps`, which is the rule the control
			// password and the passcode already follow.
			assert.equal(cmuxEnv().CMUX_SOCKET_PASSWORD, FIXTURE, 'the password never reached the child environment')
		} finally {
			fs.rmSync(PASS_FILE)
		}
	})
})

test('an empty password file is not a password', () => {
	// A file somebody created and never filled in must not read as authorization, or the
	// verdict says "fine" and every send fails at cmux with its own error again.
	withoutCmux(() => {
		fs.writeFileSync(PASS_FILE, '   \n')
		try {
			assert.equal(socketPassword(), null)
			assert.equal(cmuxEnv().CMUX_SOCKET_PASSWORD, undefined)
		} finally {
			fs.rmSync(PASS_FILE)
		}
	})
})

test('when it cannot work, the refusal says why AND what to do', () => {
	// The whole point. cmux already says "only processes started inside cmux can connect",
	// which names its own rule and leaves the reader nowhere to go. A refusal here has to
	// carry both halves, and both are shown to a phone.
	withoutCmux(() => {
		const r = reach()
		// On a machine with no cmux, or with cmux in cmuxOnly mode, this must be a refusal.
		// If cmux is running in a permissive mode the verdict is legitimately ok — so this
		// asserts the SHAPE of a refusal rather than demanding one.
		if (r.ok) return
		assert.ok(r.why.length > 0, 'a refusal with no reason')
		assert.ok(r.fix.length > 0, 'a refusal with no remedy')
		// Not cmux's sentence. If the reason merely repeats what cmux says, nothing was
		// gained by checking.
		assert.doesNotMatch(r.why, /only processes started inside cmux/, 'the refusal just repeats cmux')
		// The remedy has to name something actionable, not describe the rule again.
		assert.match(r.fix, /cmux pane|cmux-password|cmux is running/, `the remedy is not actionable: ${r.fix}`)
	})
})

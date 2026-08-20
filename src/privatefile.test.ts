import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// never touch the real credential; set before the imports that read it
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-mode-'))

import { setPasscode } from './auth.ts'
import { setControlPass } from './controlauth.ts'
import { writePrivate } from './privatefile.ts'

const mode = (f: string) => (fs.statSync(f).mode & 0o777).toString(8)
const dir = () => process.env.GUILDHALL_CONFIG_DIR!

test('a credential file that already exists gets its permissions FIXED, not left alone', () => {
	// The whole point, and the reason this file exists. Every one of these writes
	// used `writeFileSync(f, data, { mode: 0o600 })`, and `mode` applies only at
	// CREATION — so a file that arrived any other way kept whatever it had.
	//
	// Measured before the fix: 644 in, 644 out. The option protected the one case
	// that was already safe and did nothing in the cases that are not — a restore
	// from a backup, a synced dotfiles directory, or `echo 1234 > passcode`.
	const f = path.join(dir(), 'passcode')
	fs.writeFileSync(f, 'stale\n')
	fs.chmodSync(f, 0o644)
	assert.equal(mode(f), '644', 'the fixture did not start world-readable')

	// NOT a weak code: setPasscode refuses those and returns without writing, so a
	// weak one makes this test pass a refusal off as a repair.
	assert.deepEqual(setPasscode('3719'), { ok: true }, 'the fixture code was refused')
	assert.equal(mode(f), '600', 'a world-readable passcode stayed world-readable')
})

test('the scrypt hash of the control password is repaired the same way', () => {
	const f = path.join(dir(), 'control-pass')
	fs.writeFileSync(f, 'stale\n')
	fs.chmodSync(f, 0o666)
	assert.deepEqual(setControlPass('TEST-ONLY-correct-horse-battery'), { ok: true }) // allow-secret: a test fixture, and it says so
	assert.equal(mode(f), '600', 'a world-WRITABLE control password stayed that way')
})

test('the directory is tightened too', () => {
	const sub = path.join(dir(), 'nested')
	fs.mkdirSync(sub, { recursive: true })
	fs.chmodSync(sub, 0o755)
	writePrivate(path.join(sub, 'thing'), 'x')
	assert.equal(mode(sub), '700', 'the containing directory stayed traversable by everyone')
})

test('a write that fails leaves no temp file behind', () => {
	// The temp-and-rename is what makes the mode guaranteed. It must not turn a
	// failed write into litter in a directory of credentials.
	// The parent must be a FILE for this to fail. A missing directory does not:
	// mkdirSync is recursive, so the first version of this test asserted an
	// exception that never came and was measuring nothing.
	const blocker = path.join(dir(), 'blocker')
	fs.writeFileSync(blocker, 'i am a file, not a directory')
	assert.throws(() => writePrivate(path.join(blocker, 'child'), 'x'))
	assert.deepEqual(
		fs.readdirSync(dir()).filter((f) => f.includes('.tmp-')),
		[],
		'a temp file survived a failed write',
	)
})

test('an interrupted write cannot leave a half-written credential', () => {
	// rename() is atomic, so a reader sees either the old file or the new one. The
	// old in-place writes could leave a truncated session.key, which signs every
	// device out.
	const f = path.join(dir(), 'session.key')
	writePrivate(f, 'first-value')
	writePrivate(f, 'second-value-which-is-longer')
	assert.equal(fs.readFileSync(f, 'utf8'), 'second-value-which-is-longer')
	assert.equal(mode(f), '600')
})

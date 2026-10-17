/**
 * Which keys a phone may press in a session, and how each one reaches it.
 *
 * Asked for from a phone: Claude Code says "ctrl+enter to send now" and "shift+tab to
 * cycle", and a phone has neither key. A fake cmux records every call, so nothing here
 * can reach a real terminal.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-keys-'))
const log = path.join(dir, 'calls')
const fake = path.join(dir, 'cmux')
// Appends its arguments, one call per line, and answers like a successful rpc.
fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho '{}'\n`, { mode: 0o755 })
process.env.GUILDHALL_CMUX = fake
// The fake is a shell script, and starting one in a loaded full suite took over the
// 5s default — measured, the test failed on the clock rather than on the keys.
process.env.GUILDHALL_CMUX_TIMEOUT = '60000'
process.env.GUILDHALL_CONFIG_DIR = dir

const { press } = await import('./control.ts')

const WS = '00000000-0000-4000-8000-000000000000'
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])

test('the shortcuts are sent as named keys, the arrows as the bytes they always were', async () => {
	fs.rmSync(log, { force: true })
	for (const k of ['ctrl+enter', 'shift+tab', 'ctrl+b', 'ctrl+o']) assert.equal((await press(WS, k)).ok, true, `${k} was refused`)
	assert.equal((await press(WS, 'up')).ok, true)
	const c = calls()
	// Named, not raw: a raw ESC [ Z arrived as an Escape and the text "[Z" once Claude
	// Code was running — measured on a scratch session.
	for (const [i, k] of ['ctrl+enter', 'shift+tab', 'ctrl+b', 'ctrl+o'].entries()) {
		assert.match(c[i]!, /^rpc surface\.send_key /)
		assert.equal(JSON.parse(c[i]!.replace(/^rpc surface\.send_key /, '')).key, k)
	}
	assert.match(c[4]!, /^rpc terminal\.input /)
})

test('ctrl+c, ctrl+d and anything that types are refused before cmux is asked', async () => {
	fs.rmSync(log, { force: true })
	// Twice ctrl+c quits Claude Code, and ctrl+d at a shell prompt closes the shell.
	for (const k of ['ctrl+c', 'ctrl+d', 'y', 'ls', 'ctrl+enter; rm', '']) {
		const r = await press(WS, k)
		assert.equal(r.ok, false, `${JSON.stringify(k)} was pressed`)
	}
	assert.deepEqual(calls(), [], 'a refused key still reached cmux')
})

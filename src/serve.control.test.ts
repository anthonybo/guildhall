/**
 * The control surface, which is the only part of this program that can change
 * anything outside itself. Everything here is a refusal test.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// never touch the real passcode or token; set before the imports that read it
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-serve-control-'))

import { createServer } from './serve.ts'
import { controlToken } from './controlauth.ts'
import { issue } from './auth.ts'

/** A server on a random port, with control armed unless the test says otherwise. */
async function boot(control = true) {
	let on = control
	const srv = createServer({ port: 0, host: '127.0.0.1', demo: true, control: () => on, onSend: () => {} })
	await new Promise<void>((r) => {
		srv.listen(0, '127.0.0.1', () => r())
	})
	const port = (srv.address() as { port: number }).port
	const cookie = `gh_sid=${issue()}`
	const hit = async (p: string, init: RequestInit = {}) => {
		const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { cookie, ...(init.headers ?? {}) }, redirect: 'manual' })
		return { status: res.status, text: await res.text() }
	}
	return { hit, srv, set: (v: boolean) => (on = v) }
}

test('the view passcode does not buy the right to type', () => {
	// A device trusted to watch has not thereby been trusted to run commands here.
	// The cookie below is a fully valid VIEW session in every one of these calls.
	return boot().then(async ({ hit, srv }) => {
		for (const [what, r] of [
			['screen', await hit('/api/screen?id=tidepool')],
			['send', await hit('/api/send', { method: 'POST', body: '{"id":"tidepool","text":"hi"}' })],
		] as const) {
			assert.equal(r.status, 401, `${what} allowed a view-only session through: ${r.text}`)
		}
		srv.close()
	})
})

test('a wrong control token is refused', () =>
	boot().then(async ({ hit, srv }) => {
		const r = await hit('/api/screen?id=tidepool', { headers: { 'x-guildhall-control': 'deadbeef'.repeat(4) } })
		assert.equal(r.status, 401)
		srv.close()
	}))

test('switching control off closes it immediately, token or not', () =>
	boot(true).then(async ({ hit, srv, set }) => {
		const token = controlToken()
		set(false)
		// read at call time rather than captured at construction: turning it off in
		// the running app has to take effect now, not at the next restart
		for (const r of [
			await hit('/api/screen?id=tidepool', { headers: { 'x-guildhall-control': token } }),
			await hit('/api/send', { method: 'POST', body: '{"id":"tidepool","text":"hi"}', headers: { 'x-guildhall-control': token } }),
		]) {
			assert.equal(r.status, 403, `still reachable with control off: ${r.text}`)
			assert.match(r.text, /control is off/)
		}
		srv.close()
	}))

test('a session with no cmux workspace cannot be typed into', () =>
	boot().then(async ({ hit, srv }) => {
		// The demo office has no cmux tabs, so this is the real "there is nothing to
		// address" path. Refusing is the point: without a workspace UUID the only
		// alternative is guessing, and a wrong guess types into another project.
		const r = await hit('/api/send', { method: 'POST', body: '{"id":"tidepool","text":"hi"}', headers: { 'x-guildhall-control': controlToken() } })
		assert.equal(r.status, 404)
		assert.match(r.text, /not in a cmux tab/)
		srv.close()
	}))

test('everything else is still read-only', () =>
	boot().then(async ({ hit, srv }) => {
		// the guarantee the rest of the server keeps, and the 405 that states it
		for (const p of ['/api/sessions', '/api/stream', '/']) {
			const r = await hit(p, { method: 'DELETE' })
			assert.equal(r.status, 405, `${p} accepted a DELETE`)
			assert.equal(r.text, 'read-only')
		}
		srv.close()
	}))

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

import { createServer, screenTag } from './serve.ts'
import { resetControlThrottle, setControlPass } from './controlauth.ts'

// Named so it can never be mistaken for a real one, and so nobody has to wonder
// whether a password is in this repository. The old value read like a plausible
// passphrase, and when a stray script wrote it into the live config the question
// "is my password on GitHub" became reasonable to ask. A fixture should be
// obviously a fixture.
const PASS = 'TEST-ONLY-not-a-real-passphrase' // allow-secret: a test fixture, and it says so
setControlPass(PASS)
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
		resetControlThrottle()
		const token = PASS
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
		const r = await hit('/api/send', { method: 'POST', body: '{"id":"tidepool","text":"hi"}', headers: { 'x-guildhall-control': PASS } })
		assert.equal(r.status, 404)
		assert.match(r.text, /not in a cmux tab/)
		srv.close()
	}))

test('a session sitting on a permission prompt cannot be answered from away', () =>
	boot().then(async ({ hit, srv }) => {
		resetControlThrottle()
		// control.ts refuses `y`, `n`, `a` and `d` so no remote caller can approve
		// tool use. But the prompt is a NUMBERED list and a send is text plus Enter,
		// so "1" reached the same outcome with every letter guard still in place —
		// the guard was letter-shaped and the prompt is number-shaped. Refused on
		// what the session is waiting for instead, which no wording can slip past.
		for (const text of ['1', 'yes', 'go ahead']) {
			const r = await hit('/api/send', { method: 'POST', body: JSON.stringify({ id: 'lanternfish', text }), headers: { 'x-guildhall-control': PASS } })
			assert.equal(r.status, 409, `"${text}" was accepted: ${r.text}`)
			assert.match(r.text, /answered at the machine/)
		}
		srv.close()
	}))

test('a plain question is still answerable from away', () =>
	boot().then(async ({ hit, srv }) => {
		resetControlThrottle()
		// The refusal above must not swallow the feature. This session is blocked on
		// a question rather than a permission decision, so it gets as far as the
		// workspace lookup — the demo office has no cmux tabs — rather than a 409.
		const r = await hit('/api/send', { method: 'POST', body: '{"id":"orchard","text":"1"}', headers: { 'x-guildhall-control': PASS } })
		assert.equal(r.status, 404, r.text)
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

test('the screen returned is the session asked for, not whatever is focused', async () => {
	// cmux's rpc ignores an unknown parameter rather than rejecting it, so
	// `workspaceId` (camelCase) silently returned the FOCUSED surface for every
	// session. Reading one project while `send` typed into another is the most
	// dangerous shape this feature can take, and a wrong name is invisible without
	// a check like this one.
	const { readGrid } = await import('./control.ts')
	const fake = '00000000-1111-2222-3333-444444444444'
	const r = await readGrid(fake)
	// no such workspace: it must fail rather than fall back to the focused surface
	if (r.ok) {
		const g = JSON.parse(r.text).render_grid
		assert.ok(!g?.surface_id, `an unknown workspace returned surface ${g?.surface_id} instead of an error`)
	}
})

test('an unchanged screen is fingerprinted the same, and a changed one is not', () => {
	// The trap this is here to hold shut: hashing the reply is the obvious
	// implementation and it would never have matched once. Two reads of a terminal
	// nobody has touched differ in exactly these two counters — measured against a
	// real idle pane, where every field the browser draws from was byte-identical.
	// A conditional request that can never fire looks like a saving and is not one.
	const grid = (extra: Record<string, unknown>, text = 'hello') => JSON.stringify({ render_grid: { rows: 2, columns: 4, styles: [{ id: 1 }], row_spans: [{ row: 0, column: 0, style_id: 1, text }], terminal_foreground: '#fff', terminal_background: '#000', ...extra } })

	const a = grid({ render_revision: 7, terminal_theme_revision: 1204 })
	const b = grid({ render_revision: 8, terminal_theme_revision: 1205 })
	assert.notEqual(a, b, 'the fixture must actually differ, or this proves nothing')
	assert.equal(screenTag(a), screenTag(b), 'cmux bookkeeping counters must not bust the tag')

	// and the part that must never be quietly cached: real output
	assert.notEqual(screenTag(a), screenTag(grid({ render_revision: 7 }, 'goodbye')), 'changed text kept the same tag')
	// a reply that is not the shape we expect is still a reply that must be delivered
	assert.notEqual(screenTag('not json'), screenTag('also not json'))
})

test('a send names the workspace in the one spelling cmux honours', async () => {
	// cmux accepts `workspace_id` and silently IGNORES `workspaceId`, falling back to
	// whatever surface happens to be FOCUSED. That is not theory: driving the rpc by
	// hand with the camelCase key during this investigation typed a test marker into
	// a live session, twice. `readGrid` already carries a test for this; `ask` runs
	// the same rpc and needs the same one, because the blast radius here is larger —
	// this one types, and it presses Enter.
	const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./control.ts', import.meta.url), 'utf8'))
	const rpc = src.slice(src.indexOf('export async function ask'))
	assert.ok(rpc.includes('workspace_id'), 'ask must pass workspace_id')
	assert.ok(!/workspaceId/.test(rpc), 'ask must never use the camelCase spelling, which cmux ignores')
})

test('a send to a workspace that does not exist is reported as a failure', async () => {
	// `cmux rpc` prints `Error: not_found: …` AND exits non-zero, so `run` catches it
	// on the exit code. I claimed it exited 0 and started writing a stdout sniffer for
	// it; the reading came from `$?` after a pipe, which is the exit code of `head`.
	// The check stays because the property matters — a send that did not happen must
	// never come back as ok — but nothing here needs to parse the message.
	const { ask } = await import('./control.ts')
	const r = await ask('00000000-1111-2222-3333-444444444444', 'this must not be reported as sent')
	assert.equal(r.ok, false, 'a send to a workspace that does not exist was reported as ok')
	if (!r.ok) assert.ok(/not.?found|failed|refus/i.test(r.error), `unhelpful error: ${r.error}`)
})

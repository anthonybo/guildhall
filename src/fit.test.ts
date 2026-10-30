/**
 * "Fit to window" holds a session's terminal at the browser's size — and must always let
 * it go, because cmux never drops a viewer by itself and the session is that wide on the
 * Mac too while it is held. A stand-in records what would have been asked of cmux.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-fit-'))

const { STALE_MS, fitOff, fitOn, releaseLeftovers, sweep, useRpc } = await import('./fit.ts')

const PANE = { workspace: '00000000-0000-4000-8000-000000000001', surface: '00000000-0000-4000-8000-000000000002' }

/** A cmux stand-in whose pane starts under `mode`; returns the calls it saw. */
function cmux(mode = 'smallest') {
	const calls: { method: string; extra: Record<string, unknown> }[] = []
	useRpc(async (method, _where, extra = {}) => {
		calls.push({ method, extra })
		if (method === 'terminal.size_state') return { ok: true, text: JSON.stringify({ size_state: { policy: { mode } } }) }
		return { ok: true, text: '{}' }
	})
	return calls
}

test('on registers the browser and asks for the largest; off gives back exactly what was there', async () => {
	const calls = cmux('priority')
	assert.equal((await fitOn(PANE, 180, 50)).ok, true)
	assert.deepEqual(
		calls.map((c) => c.method),
		['terminal.size_state', 'terminal.viewport', 'terminal.size_policy.set'],
	)
	assert.equal(calls[1]!.extra.viewport_columns, 180)
	assert.equal(calls[2]!.extra.mode, 'largest')
	const client = String(calls[1]!.extra.client_id)

	// Checking in, or a resize, only updates the viewer.
	calls.length = 0
	await fitOn(PANE, 200, 50)
	assert.deepEqual(
		calls.map((c) => c.method),
		['terminal.viewport'],
	)
	assert.equal(calls[0]!.extra.viewport_generation, 2)

	calls.length = 0
	await fitOff(PANE.surface)
	assert.deepEqual(calls, [
		{ method: 'terminal.participant.disconnect', extra: { participant_id: `mobile:${client}` } },
		// the policy it had before, not a default
		{ method: 'terminal.size_policy.set', extra: { mode: 'priority' } },
	])
	// Letting go twice does nothing the second time.
	calls.length = 0
	await fitOff(PANE.surface)
	assert.deepEqual(calls, [])
})

test('a fit nobody asks about is let go; a server that stopped is let go of on restart', async () => {
	const calls = cmux()
	await fitOn(PANE, 180, 50)
	calls.length = 0
	await sweep(Date.now() + STALE_MS / 2)
	assert.equal(calls.length, 0, 'let go while still being asked for')
	await sweep(Date.now() + STALE_MS + 1)
	assert.equal(calls[0]?.method, 'terminal.participant.disconnect', 'a stale fit was kept')

	// Held when the "server" stopped: the next one finds it on disk and lets it go.
	cmux()
	await fitOn(PANE, 180, 50)
	const after = cmux() // a fresh process: nothing in memory
	await releaseLeftovers()
	assert.deepEqual(
		after.map((c) => c.method),
		['terminal.participant.disconnect', 'terminal.size_policy.set'],
	)
})

test('a size that is not a terminal size is refused before cmux is asked', async () => {
	const calls = cmux()
	for (const [c, r] of [
		[0, 50],
		[180.5, 50],
		[5000, 50],
		[180, -1],
		[Number.NaN, 50],
	] as const) {
		assert.equal((await fitOn(PANE, c, r)).ok, false, `${c}x${r} was accepted`)
	}
	assert.deepEqual(calls, [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { codexSessions, resetCodexCache } from './codex.ts'

/**
 * Fixtures are written here, not copied from `~/.codex`.
 *
 * A real rollout is a transcript: it contains whatever was typed and whatever the
 * model said back. Committing one to a public repository would put somebody's work in
 * it, which is the leak this project has already spent a day removing. Every record
 * below is invented, and the shapes are what the real files carry.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-codex-'))

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` */
function rollout(name: string, records: unknown[], opts: { day?: string; ageMs?: number } = {}) {
	const day = opts.day ?? '2026/08/20'
	const at = path.join(dir, day)
	fs.mkdirSync(at, { recursive: true })
	const file = path.join(at, `rollout-2026-08-20T10-00-00-${name}.jsonl`)
	fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
	if (opts.ageMs) {
		const when = new Date(Date.now() - opts.ageMs)
		fs.utimesSync(file, when, when)
	}
	return file
}

const meta = (id: string, cwd: string) => ({
	timestamp: '2026-08-20T10:00:00.000Z',
	type: 'session_meta',
	payload: { session_id: id, id, cwd, originator: 'codex_cli', cli_version: '0.149.0', model_provider: 'openai' },
})

const tokens = (live: number, window: number, total = live * 9) => ({
	timestamp: '2026-08-20T10:00:01.000Z',
	type: 'event_msg',
	payload: {
		type: 'token_count',
		info: {
			last_token_usage: { total_tokens: live, input_tokens: live - 100, output_tokens: 100 },
			// Deliberately much larger than the window, which is the real shape: it
			// accumulates across compactions.
			total_token_usage: { total_tokens: total },
			model_context_window: window,
		},
	},
})

const done = { timestamp: '2026-08-20T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } }
const said = (m: string) => ({ timestamp: '2026-08-20T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: m } })
const tool = (name: string) => ({ timestamp: '2026-08-20T10:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name } })

test('a finished session is read as done, with its project from cwd', () => {
	resetCodexCache()
	rollout('aaaa1111', [meta('aaaa1111', '/x/projects/orchard'), tokens(1000, 200_000), said('Renamed the helper.'), done])
	const out = codexSessions(Date.now(), dir)
	assert.equal(out.length, 1)
	const s = out[0]!
	assert.equal(s.id, 'aaaa1111')
	assert.equal(s.proj, 'orchard')
	assert.equal(s.state, 'done')
	assert.equal(s.agent, 'codex')
	assert.equal(s.title, 'Renamed the helper.')
})

test('context comes from the per-turn figure, not the cumulative one', () => {
	// The trap this exists to prevent: `total_token_usage` accumulates across
	// compactions, and using it reported a real session at nine times its window.
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	rollout('bbbb2222', [meta('bbbb2222', '/x/projects/willow'), tokens(175_160, 258_400, 2_524_117), done])
	const s = codexSessions(Date.now(), dir)[0]!
	assert.equal(s.ctxUsed, 175_160, 'took the lifetime total instead of the live context')
	assert.equal(s.ctxLimit, 258_400, 'ignored the window Codex reports')
	assert.ok(s.ctxUsed < s.ctxLimit, 'a context bar over 100% means the wrong field was read')
})

test('a session mid-turn is working; one abandoned mid-turn is parked', () => {
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	rollout('cccc3333', [meta('cccc3333', '/x/projects/kestrel'), tokens(500, 200_000), tool('shell')])
	rollout('dddd4444', [meta('dddd4444', '/x/projects/harbor'), tokens(500, 200_000), tool('shell')], { ageMs: 40 * 60 * 1000 })
	const byId = new Map(codexSessions(Date.now(), dir).map((s) => [s.id, s]))
	assert.equal(byId.get('cccc3333')?.state, 'working')
	assert.equal(byId.get('dddd4444')?.state, 'parked', 'nothing written for 40 minutes is not still working')
})

test('sessions older than the window are not shown at all', () => {
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	rollout('eeee5555', [meta('eeee5555', '/x/projects/orchard'), done], { ageMs: 8 * 60 * 60 * 1000 })
	assert.deepEqual(codexSessions(Date.now(), dir), [], 'a directory of months of history would fill the room')
})

test('no tab and no workspace, so the room cannot offer to focus one', () => {
	// A Codex session is not a cmux pane. Both fields are optional precisely so a
	// terminal button is not drawn for something it cannot reach.
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	rollout('ffff6666', [meta('ffff6666', '/x/projects/orchard'), done])
	const s = codexSessions(Date.now(), dir)[0]!
	assert.equal(s.tab, undefined)
	assert.equal(s.workspace, undefined)
})

test('a truncated or empty rollout is skipped rather than throwing', () => {
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	const at = path.join(dir, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	fs.writeFileSync(path.join(at, 'rollout-2026-08-20T10-00-00-empty.jsonl'), '')
	fs.writeFileSync(path.join(at, 'rollout-2026-08-20T10-00-00-half.jsonl'), '{"type":"session_meta","payl')
	rollout('9999aaaa', [meta('9999aaaa', '/x/projects/orchard'), done])
	const out = codexSessions(Date.now(), dir)
	assert.equal(out.length, 1, 'a broken file must not take the good ones with it')
	assert.equal(out[0]!.id, '9999aaaa')
})

test('a missing codex directory yields nothing, quietly', () => {
	resetCodexCache()
	assert.deepEqual(codexSessions(Date.now(), path.join(dir, 'nope')), [])
})

test('re-reading an unchanged file does not re-parse it', () => {
	// The cache is what makes this affordable: parsing every rollout in full costs
	// 849 cpu-ms, against a 12 cpu-ms budget for the whole poll.
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	const file = rollout('7777bbbb', [meta('7777bbbb', '/x/projects/orchard'), tokens(10, 200_000), done])
	const first = codexSessions(Date.now(), dir)[0]!
	// Make the file unreadable. A re-parse would now fail; a cache hit will not.
	fs.chmodSync(file, 0o000)
	try {
		const second = codexSessions(Date.now(), dir)[0]!
		assert.equal(second.id, first.id, 'the second call re-read a file it had already read')
		assert.equal(second.ctxUsed, first.ctxUsed)
	} finally {
		fs.chmodSync(file, 0o644)
	}
})

test('a grown file IS re-read', () => {
	resetCodexCache()
	fs.rmSync(dir, { recursive: true, force: true })
	const file = rollout('8888cccc', [meta('8888cccc', '/x/projects/orchard'), tokens(10, 200_000), tool('shell')])
	assert.equal(codexSessions(Date.now(), dir)[0]!.state, 'working')
	fs.appendFileSync(file, JSON.stringify(done) + '\n')
	assert.equal(codexSessions(Date.now(), dir)[0]!.state, 'done', 'the cache held a stale answer')
})

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

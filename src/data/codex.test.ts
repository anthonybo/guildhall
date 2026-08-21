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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-codex-'))
const dir = path.join(root, 'sessions')
const locks = path.join(root, 'thread-writer-locks')

/** Thread ids are UUID-shaped, and the id is parsed out of the FILENAME. */
const ID = {
	a: 'aaaaaaaa-1111-2222-3333-444444444444',
	b: 'bbbbbbbb-1111-2222-3333-444444444444',
	c: 'cccccccc-1111-2222-3333-444444444444',
	d: 'dddddddd-1111-2222-3333-444444444444',
}

function reset() {
	resetCodexCache()
	fs.rmSync(root, { recursive: true, force: true })
	fs.mkdirSync(dir, { recursive: true })
	fs.mkdirSync(locks, { recursive: true })
}

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` */
function rollout(id: string, records: unknown[], opts: { ageMs?: number; live?: boolean } = {}) {
	const at = path.join(dir, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	const file = path.join(at, `rollout-2026-08-20T10-00-00-${id}.jsonl`)
	fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
	if (opts.ageMs) {
		const when = new Date(Date.now() - opts.ageMs)
		fs.utimesSync(file, when, when)
	}
	// The lock Codex holds while the process writing that thread is alive.
	if (opts.live) fs.writeFileSync(path.join(locks, `${id}.lock`), '')
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

const read = () => codexSessions(Date.now(), dir, locks)

test('a locked thread is live; an unlocked one is gone, however recent', () => {
	// The whole basis of this: `~/.codex/thread-writer-locks/<id>.lock` exists while
	// the process writing that thread is alive. Observed against a real session — the
	// lock stayed put while it sat idle at a prompt, and the five-hour-old threads
	// beside it had none. Age cannot answer this question and a lock can.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), done], { live: true })
	rollout(ID.b, [meta(ID.b, '/x/projects/willow'), done]) // written seconds ago, no lock
	const out = read()
	assert.deepEqual(
		out.map((s) => s.proj),
		['orchard'],
		'an unlocked thread was shown, or a locked one was dropped',
	)
})

test('a locked thread is shown however long ago it last wrote', () => {
	// A session sitting at a prompt overnight is still a session. The old age guess
	// dropped it; the lock keeps it.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), done], { live: true, ageMs: 30 * 24 * 60 * 60 * 1000 })
	assert.equal(read().length, 1, 'a month-old but still-running session was dropped')
})

test('dotfiles beside the locks are not threads', () => {
	// `.coordination.lock` sits in that directory and is not a thread id.
	reset()
	fs.writeFileSync(path.join(locks, '.coordination.lock'), '')
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), done], { live: true })
	assert.equal(read().length, 1)
})

test('with no lock directory at all, it falls back to recency', () => {
	// An older Codex without the locks. Guessing from mtime is worse, and it is what
	// there is, so it degrades rather than showing nothing.
	reset()
	const gone = path.join(root, 'no-locks-here')
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), done])
	rollout(ID.b, [meta(ID.b, '/x/projects/willow'), done], { ageMs: 8 * 60 * 60 * 1000 })
	const out = codexSessions(Date.now(), dir, gone)
	assert.deepEqual(
		out.map((s) => s.proj),
		['orchard'],
		'the fallback stopped distinguishing fresh from ancient',
	)
})

test('a finished session is read as done, with its project from cwd', () => {
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), tokens(1000, 200_000), said('Renamed the helper.'), done], { live: true })
	const s = read()[0]!
	assert.equal(s.id, ID.a)
	assert.equal(s.proj, 'orchard')
	assert.equal(s.state, 'done')
	assert.equal(s.agent, 'codex')
	assert.equal(s.title, 'Renamed the helper.')
})

test('context comes from the per-turn figure, not the cumulative one', () => {
	// The trap this exists to prevent: `total_token_usage` accumulates across
	// compactions, and using it reported a real session at nine times its window.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/willow'), tokens(175_160, 258_400, 2_524_117), done], { live: true })
	const s = read()[0]!
	assert.equal(s.ctxUsed, 175_160, 'took the lifetime total instead of the live context')
	assert.equal(s.ctxLimit, 258_400, 'ignored the window Codex reports')
	assert.ok(s.ctxUsed < s.ctxLimit, 'a context bar over 100% means the wrong field was read')
})

test('a session mid-turn is working; one abandoned mid-turn is parked', () => {
	reset()
	rollout(ID.c, [meta(ID.c, '/x/projects/kestrel'), tokens(500, 200_000), tool('shell')], { live: true })
	rollout(ID.d, [meta(ID.d, '/x/projects/harbor'), tokens(500, 200_000), tool('shell')], { live: true, ageMs: 40 * 60 * 1000 })
	const byId = new Map(read().map((s) => [s.id, s]))
	assert.equal(byId.get(ID.c)?.state, 'working')
	assert.equal(byId.get(ID.d)?.state, 'parked', 'nothing written for 40 minutes is not still working')
})

test('no tab and no workspace, so the room cannot offer to focus one', () => {
	// A Codex session is not a cmux pane. Both fields are optional precisely so a
	// terminal button is not drawn for something it cannot reach.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), done], { live: true })
	const s = read()[0]!
	assert.equal(s.tab, undefined)
	assert.equal(s.workspace, undefined)
})

test('a truncated or empty rollout is skipped rather than throwing', () => {
	reset()
	const at = path.join(dir, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	for (const bad of [ID.b, ID.c]) fs.writeFileSync(path.join(locks, `${bad}.lock`), '')
	fs.writeFileSync(path.join(at, `rollout-2026-08-20T10-00-00-${ID.b}.jsonl`), '')
	fs.writeFileSync(path.join(at, `rollout-2026-08-20T10-00-00-${ID.c}.jsonl`), '{"type":"session_meta","payl')
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), done], { live: true })
	const out = read()
	assert.equal(out.length, 1, 'a broken file must not take the good ones with it')
	assert.equal(out[0]!.id, ID.a)
})

test('a missing codex directory yields nothing, quietly', () => {
	reset()
	assert.deepEqual(codexSessions(Date.now(), path.join(root, 'nope'), locks), [])
})

test('re-reading an unchanged file does not re-parse it', () => {
	// The cache is what makes this affordable: parsing every rollout in full costs
	// 849 cpu-ms, against a 12 cpu-ms budget for the whole poll.
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), tokens(10, 200_000), done], { live: true })
	const first = read()[0]!
	// Make the file unreadable. A re-parse would now fail; a cache hit will not.
	fs.chmodSync(file, 0o000)
	try {
		const second = read()[0]!
		assert.equal(second.id, first.id, 'the second call re-read a file it had already read')
		assert.equal(second.ctxUsed, first.ctxUsed)
	} finally {
		fs.chmodSync(file, 0o644)
	}
})

test('a grown file IS re-read', () => {
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), tokens(10, 200_000), tool('shell')], { live: true })
	assert.equal(read()[0]!.state, 'working')
	fs.appendFileSync(file, JSON.stringify(done) + '\n')
	assert.equal(read()[0]!.state, 'done', 'the cache held a stale answer')
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

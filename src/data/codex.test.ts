import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { codexSessions, resetCodexCache, resetCodexGhosts, sweepGhosts } from './codex.ts'

/**
 * Fixtures are written here, never copied from `~/.codex`.
 *
 * A real rollout is a transcript of somebody's actual work. Committing one to a public
 * repository is the leak this project already spent a day removing. Every record below
 * is invented; the shapes are what the real files carry.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-codex-'))
const dir = path.join(root, 'sessions')
const locks = path.join(root, 'thread-writer-locks')

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

function rollout(id: string, records: unknown[], opts: { ageMs?: number; live?: boolean; name?: string } = {}) {
	const at = path.join(dir, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	const file = path.join(at, opts.name ?? `rollout-2026-08-20T10-00-00-${id}.jsonl`)
	fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
	if (opts.ageMs) {
		const when = new Date(Date.now() - opts.ageMs)
		fs.utimesSync(file, when, when)
	}
	if (opts.live) fs.writeFileSync(path.join(locks, `${id}.lock`), '')
	return file
}

const meta = (id: string, cwd: string) => ({
	timestamp: '2026-08-20T10:00:00.000Z',
	type: 'session_meta',
	payload: { session_id: id, id, cwd, originator: 'codex_cli', cli_version: '0.149.0' },
})

const tokens = (live: number, window: number, total = live * 9) => ({
	timestamp: '2026-08-20T10:00:01.000Z',
	type: 'event_msg',
	payload: {
		type: 'token_count',
		info: {
			last_token_usage: { total_tokens: live },
			total_token_usage: { total_tokens: total },
			model_context_window: window,
		},
	},
})

const started = { type: 'event_msg', payload: { type: 'task_started' } }
const done = { type: 'event_msg', payload: { type: 'task_complete' } }
const aborted = { type: 'event_msg', payload: { type: 'turn_aborted' } }
const said = (m: string) => ({ type: 'event_msg', payload: { type: 'agent_message', message: m } })
const tool = (name: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name } })
/** What over half the real rollouts actually end on. */
const msg = (role: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [] } })

const read = () => codexSessions(Date.now(), dir, locks)

// ---------------------------------------------------------------- liveness

test('a locked thread is live; an unlocked one is gone, however recent', () => {
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done], { live: true })
	rollout(ID.b, [meta(ID.b, '/x/projects/willow'), started, done])
	assert.deepEqual(read().map((s) => s.proj), ['orchard'])
})

test('an UNREADABLE lock directory refuses rather than widening', () => {
	// `null` means "no registry, fall back to age". An EACCES is not that: falling back
	// there would multiply the set of remotely-writable sessions on a permissions error.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done]) // fresh, NOT locked
	fs.chmodSync(locks, 0o000)
	try {
		assert.deepEqual(read(), [], 'an unreadable lock directory fell back to age')
	} finally {
		fs.chmodSync(locks, 0o755)
	}
})

test('with no lock directory at all, it falls back to recency', () => {
	reset()
	const gone = path.join(root, 'no-locks-here')
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done])
	rollout(ID.b, [meta(ID.b, '/x/projects/willow'), started, done], { ageMs: 8 * 60 * 60 * 1000 })
	assert.deepEqual(codexSessions(Date.now(), dir, gone).map((s) => s.proj), ['orchard'])
})

test('an uppercase id in a filename still matches its lock', () => {
	reset()
	const upper = ID.a.toUpperCase()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done], {
		live: true,
		name: `rollout-2026-08-20T10-00-00-${upper}.jsonl`,
	})
	assert.equal(read().length, 1, 'case cost a live session')
})

// ---------------------------------------------------------------- state

test('state comes from turn markers, not from the last record type', () => {
	// The bug this replaces: matching the final record mis-stated 23 of the 45 real
	// rollouts, because a turn commonly ends on `message` or `token_count` rather than
	// on `task_complete` — and every one of those read as working, then parked.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done, msg('assistant')], { live: true })
	rollout(ID.b, [meta(ID.b, '/x/projects/willow'), started, tokens(10, 200_000)], { live: true })
	const by = new Map(read().map((s) => [s.proj, s]))
	assert.equal(by.get('orchard')?.state, 'done', 'a closed turn ending on a message read as working')
	assert.equal(by.get('willow')?.state, 'working', 'an open turn was not working')
})

test('an aborted turn is finished', () => {
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, aborted], { live: true })
	assert.equal(read()[0]!.state, 'done')
})

test('a turn left open with nothing written for a while is parked', () => {
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, tool('shell')], { live: true, ageMs: 40 * 60 * 1000 })
	assert.equal(read()[0]!.state, 'parked')
})

test('a finished session is not still running a tool', () => {
	// 18 of the 20 finished sessions on this machine reported `doing: "running shell"`,
	// because the tool name was never cleared when the turn ended.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, tool('shell'), done], { live: true })
	const s = read()[0]!
	assert.equal(s.state, 'done')
	assert.equal(s.doing, '', `a finished session claims to be doing: ${s.doing}`)
	assert.equal(s.short, '')
})

// ---------------------------------------------------------------- reading

test('context comes from the per-turn figure, not the cumulative one', () => {
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/willow'), tokens(175_160, 258_400, 2_524_117), started, done], { live: true })
	const s = read()[0]!
	assert.equal(s.ctxUsed, 175_160)
	assert.equal(s.ctxLimit, 258_400)
	assert.ok(s.ctxUsed < s.ctxLimit, 'a bar over 100% means the wrong field was read')
})

test('a final record larger than the tail window does not erase everything', () => {
	// 38 records in the real corpus exceed 64KB and the largest is 2.9MB. When the last
	// record is bigger than the window, the only line in the buffer is partial, gets
	// dropped, and every field came back empty.
	reset()
	const huge = { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'z'.repeat(200_000) } }
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), tokens(1234, 400_000), started, done, huge], { live: true })
	const s = read()[0]!
	assert.equal(s.state, 'done', 'the turn marker was lost behind a huge final record')
	assert.equal(s.ctxLimit, 400_000, 'the reported window was lost')
	assert.equal(s.ctxUsed, 1234)
})

test('a header id that disagrees with the filename is dropped', () => {
	// Liveness is proven by the filename id; a send addresses the header id. If they
	// differ, guildhall would prove one thread alive and type into another.
	reset()
	rollout(ID.a, [meta(ID.b, '/x/projects/orchard'), started, done], { live: true })
	assert.deepEqual(read(), [], 'a mismatched header id was published as a target')
})

test('a truncated or empty rollout is skipped rather than throwing', () => {
	reset()
	const at = path.join(dir, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	for (const bad of [ID.b, ID.c]) fs.writeFileSync(path.join(locks, `${bad}.lock`), '')
	fs.writeFileSync(path.join(at, `rollout-2026-08-20T10-00-00-${ID.b}.jsonl`), '')
	fs.writeFileSync(path.join(at, `rollout-2026-08-20T10-00-00-${ID.c}.jsonl`), '{"type":"session_meta","payl')
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done], { live: true })
	assert.deepEqual(read().map((s) => s.id), [ID.a])
})

test('a missing codex directory yields nothing, quietly', () => {
	reset()
	fs.writeFileSync(path.join(locks, `${ID.a}.lock`), '')
	assert.deepEqual(codexSessions(Date.now(), path.join(root, 'nope'), locks), [])
})

// ---------------------------------------------------------------- cache

test('re-reading an unchanged file does not re-parse it', () => {
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), tokens(10, 200_000), started, done], { live: true })
	const first = read()[0]!
	fs.chmodSync(file, 0o000)
	try {
		assert.equal(read()[0]!.ctxUsed, first.ctxUsed, 'the second call re-read the file')
	} finally {
		fs.chmodSync(file, 0o644)
	}
})

test('a grown file IS re-read', () => {
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, tool('shell')], { live: true })
	assert.equal(read()[0]!.state, 'working')
	fs.appendFileSync(file, JSON.stringify(done) + '\n')
	assert.equal(read()[0]!.state, 'done', 'the cache held a stale answer')
})

test('a transient read failure is not remembered as absence', () => {
	// The bug: any failure was cached against (path, size), and an idle session's file
	// never changes size again — so one unreadable moment hid it for the life of the
	// process. Measured: chmod 000 gave 0 sessions, and restoring the mode still gave 0.
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done], { live: true })
	fs.chmodSync(file, 0o000)
	assert.deepEqual(read(), [], 'an unreadable file was reported anyway')
	fs.chmodSync(file, 0o644)
	assert.equal(read().length, 1, 'the session never came back after the failure cleared')
})

test('the cache does not keep entries for sessions that have gone', () => {
	// This program is left running for days and each entry holds a message body.
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), said('a long message'), started, done], { live: true })
	assert.equal(read().length, 1)
	fs.unlinkSync(path.join(locks, `${ID.a}.lock`))
	assert.deepEqual(read(), [])
	// Re-locking and re-reading must work from the file, not from a stale entry.
	fs.writeFileSync(path.join(locks, `${ID.a}.lock`), '')
	fs.appendFileSync(file, JSON.stringify(said('a different message')) + '\n')
	assert.match(read()[0]!.title, /different/, 'a pruned entry came back stale')
})

// ---------------------------------------------------------------- ordering

test('order is stable, not by modification time', () => {
	// `assignLooks` assigns sprites by INDEX, so an mtime order meant two live workers
	// swapped appearance whenever the other one wrote a line — the exact churn the plan
	// set out to prevent.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done], { live: true })
	const willow = rollout(ID.b, [meta(ID.b, '/x/projects/willow'), started, done], { live: true })
	const before = read().map((s) => s.proj)
	// Make willow the newest, which used to reverse the list.
	const now = new Date()
	fs.utimesSync(willow, now, now)
	resetCodexCache()
	assert.deepEqual(read().map((s) => s.proj), before, 'the order followed mtime')
})

test('turns never goes backwards', () => {
	// Counted from the tail, so a long turn pushes earlier endings out of the window and
	// the count would fall — measured going 3, 3, then 0.
	reset()
	const file = rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done, started, done], { live: true })
	const first = read()[0]!.turns
	assert.equal(first, 2)
	// A record big enough to push both endings out of the 64KB window.
	fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'x', blob: 'z'.repeat(80_000) } }) + '\n')
	assert.ok(read()[0]!.turns >= first, 'the turn count went backwards')
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('an orphaned lock does not cost a walk on every poll', () => {
	// Measured by a reviewer at 1344 rollouts: 0.37 cpu-ms with every lock resolved,
	// 18.82 with ONE orphan, against a 12 cpu-ms budget for the whole poll. The walk
	// stops when every wanted id is found, an id with no file is never found, and lock
	// files do not expire — so one orphan is a permanent full-history walk.
	reset()
	// A lot of history, one real session, one lock with no file behind it.
	for (let i = 0; i < 120; i++) {
		const id = i.toString(16).padStart(8, '0') + '-9999-8888-7777-666666666666'
		rollout(id, [meta(id, '/x/projects/old' + i), started, done])
	}
	rollout(ID.a, [meta(ID.a, '/x/projects/orchard'), started, done], { live: true })
	fs.writeFileSync(path.join(locks, `${ID.d}.lock`), '') // orphan: no rollout for it
	assert.equal(read().length, 1, 'the orphan changed what is reported')

	const cost = (n: number) => {
		const t0 = process.cpuUsage()
		for (let i = 0; i < n; i++) read()
		const u = process.cpuUsage(t0)
		return (u.user + u.system) / 1000 / n
	}
	const per = cost(20)
	// Generous: the point is that it is not re-walking 120 files every time, which on
	// this fixture costs an order of magnitude more.
	assert.ok(per < 1.5, `an orphaned lock still costs ${per.toFixed(2)} cpu-ms per poll`)
})

test('a header larger than the read window is not a missing session', () => {
	// `session_meta` embeds `base_instructions`, so headers get big: 20 of the 45 real
	// rollouts exceed 8KB and the largest is 21,856 bytes. An 8KB window — chosen on a
	// sample of TWELVE files that all sat under 500 bytes — silently dropped 44% of
	// sessions, including a live one, because the truncated line failed to parse and the
	// file looked headerless.
	reset()
	const fat = { ...meta(ID.a, '/x/projects/orchard') }
	;(fat.payload as Record<string, unknown>).base_instructions = 'i'.repeat(120_000)
	rollout(ID.a, [fat, started, done], { live: true })
	const out = read()
	assert.equal(out.length, 1, 'a session with a large header vanished')
	assert.equal(out[0]!.proj, 'orchard', 'the cwd was lost with the header')
})

test('a file with no newline at all is skipped, not hung on', () => {
	reset()
	const at = path.join(dir, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	fs.writeFileSync(path.join(at, `rollout-2026-08-20T10-00-00-${ID.b}.jsonl`), 'x'.repeat(300_000))
	fs.writeFileSync(path.join(locks, `${ID.b}.lock`), '')
	assert.deepEqual(read(), [])
})

test('a session left open overnight is still a session', () => {
	// The bug: a rollout not written for 24 hours was treated as a crashed process and
	// dropped, so a Codex session idle since yesterday vanished from the room and the
	// table while somebody was sitting in it. That cutoff measured how long the session
	// had been QUIET, not whether it existed.
	//
	// Measured facts that make the cutoff wrong: codex REMOVES the lock when a session
	// ends (45 rollouts on the reporting machine, one lock), and it never refreshes the
	// lock while running — the mtime is when the session started, not a heartbeat.
	reset()
	rollout(ID.a, [meta(ID.a, '/x/alpha'), tokens(1000, 200_000)], { live: true, ageMs: 3 * 24 * 60 * 60 * 1000 })
	const out = read()
	assert.equal(out.length, 1, 'a locked thread idle for three days was dropped')
	assert.equal(out[0]!.proj, 'alpha')
})

test('a lock nobody holds is culled, but only once a sweep has said so', () => {
	// The other half. Codex cannot clean up after SIGKILL or a power cut, so an orphaned
	// lock would otherwise be a desk that never leaves.
	//
	// Until a sweep runs, the thread is shown. That default is deliberate: showing a
	// session that has ended is a much smaller wrong than hiding one that has not, which
	// is the failure this whole area exists to fix.
	reset()
	resetCodexGhosts()
	rollout(ID.b, [meta(ID.b, '/x/beta'), tokens(1000, 200_000)], { live: true, ageMs: 60_000 })
	assert.equal(read().length, 1, 'a locked thread was hidden before any sweep')

	// No codex process holds this fixture lock, so a sweep must condemn it.
	sweepGhosts(locks)
	assert.equal(read().length, 0, 'an orphaned lock survived a sweep')

	// and the verdict is forgotten on demand, so a restarted session is not stuck dead
	resetCodexGhosts()
	assert.equal(read().length, 1, 'the ghost verdict outlived a reset')
})

test('a sweep that cannot run condemns nothing', () => {
	// A sweep is an optimisation for a rare case. If it fails — lsof missing, the lock
	// directory unreadable — it must not be able to hide a live session, because that is
	// the exact bug it sits next to.
	reset()
	resetCodexGhosts()
	rollout(ID.c, [meta(ID.c, '/x/gamma'), tokens(1000, 200_000)], { live: true, ageMs: 60_000 })
	sweepGhosts('/nonexistent-directory-for-this-test')
	assert.equal(read().length, 1, 'a failed sweep hid a live session')
})

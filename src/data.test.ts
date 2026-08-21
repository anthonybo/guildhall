import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, fold, levelFor, liveSessions, pairByTty, transcriptIndex, xpForLevel, xpOf } from './data.ts'
import fs from 'node:fs'
import path from 'node:path'
import { tierOf } from './theme.ts'
import type { Registry, Session } from './data/types.ts'

/** A session row with only the fields these tests care about spelled out. */
const row = (id: string, over: Partial<Session> = {}): Session => ({
	id,
	pid: 1,
	name: id,
	proj: 'tidepool',
	cwd: '/x/projects',
	state: 'working',
	stale: 0,
	title: '',
	doing: '',
	short: '',
	last: '',
	ctxUsed: 0,
	ctxLimit: 200_000,
	unread: false,
	palette: 0,
	hueShift: 0,
	toolKind: 'think',
	turns: 0,
	level: 1,
	xp: 0,
	...over,
})

test('a session parked into a background job is one row, not two', () => {
	// Backgrounding a session does not end it: the terminal stays alive carrying
	// `parkedJobId`, and the job runs on under its own pid. Both are live, so both
	// were listed — one conversation, two rows. Two of the three `tidepool` rows
	// were exactly this pair, and the job's transcript held 962 references to the
	// terminal's session id, which is the handoff made visible.
	const registry: Registry[] = [
		{ pid: 8300, sessionId: 'terminal', cwd: '/x/projects', kind: 'interactive', parkedJobId: 'job1' },
		{ pid: 6300, sessionId: 'job', cwd: '/x/projects', kind: 'bg', jobId: 'job1' },
	]
	const out = fold([row('terminal', { pid: 8300, tab: 1, workspace: 'W-1' }), row('job', { pid: 6300 })], registry)
	assert.deepEqual(
		out.map((s) => s.id),
		['job'],
		'the parked terminal was kept alongside the job that took its work',
	)
	// the terminal owns the cmux tab and the job has none, so folding must carry it
	// across or it costs the only way to go and look at the session
	assert.equal(out[0].tab, 1, 'folding lost the cmux tab')
	assert.equal(out[0].workspace, 'W-1', 'folding lost the cmux workspace')
})

test('a parked session whose job is gone is kept', () => {
	// The job finished, or never became live. Dropping the terminal here would make
	// a real session invisible, which is the expensive direction to be wrong in.
	const registry: Registry[] = [{ pid: 8300, sessionId: 'terminal', cwd: '/x/projects', kind: 'interactive', parkedJobId: 'job1' }]
	const out = fold([row('terminal', { pid: 8300, tab: 1 })], registry)
	assert.deepEqual(
		out.map((s) => s.id),
		['terminal'],
	)
})

test('collect never lists a parked session beside the job that took its work', () => {
	// Guards the wiring rather than the function: fold() can be perfect and still
	// not be called. Only asserts when something is actually parked right now.
	const reg = liveSessions()
	const jobs = new Set(reg.map((r) => r.jobId).filter(Boolean))
	const parked = reg.filter((r) => r.parkedJobId && jobs.has(r.parkedJobId)).map((r) => r.sessionId)
	if (!parked.length) return
	const ids = new Set(collect().map((s) => s.id))
	for (const id of parked) assert.ok(!ids.has(id), `${id} is parked into a live job and was listed anyway`)
})

test('nothing is folded when nothing is parked', () => {
	const registry: Registry[] = [
		{ pid: 1, sessionId: 'a', cwd: '/x', kind: 'interactive' },
		{ pid: 2, sessionId: 'b', cwd: '/x', kind: 'bg', jobId: 'job1' },
	]
	const out = fold([row('a', { pid: 1 }), row('b', { pid: 2 })], registry)
	assert.deepEqual(
		out.map((s) => s.id),
		['a', 'b'],
	)
})

test('no two live sessions collapse onto a container directory name', () => {
	const list = collect()
	if (!list.length) return // nothing running; nothing to assert
	const containers = list.filter((s) => /^(projects|repos|src|code|dev|work|git)$/.test(s.proj))
	assert.equal(
		containers.length,
		0,
		`${containers.length} session(s) still named after a container: ${containers.map((s) => s.name).join(', ')}`,
	)
})

test('a session that ended on a question is reported as needing you', () => {
	// the registry only marks modal prompts as waiting, so a plain question has to
	// come from the transcript or it is indistinguishable from finishing normally
	const list = collect()
	for (const s of list) {
		if (s.state !== 'needs') continue
		assert.ok(s.waitingFor, `${s.proj} is marked needs-you with no reason given`)
	}
})

test('the level curve separates the top instead of saturating', () => {
	// anchored to measured accumulation (~572 xp/day for the heaviest session), not
	// to a snapshot: a month of that rate is 37, a year is 85, and the cap needs
	// about eighteen months. See xpForLevel.
	const RATE = 572
	assert.equal(levelFor(RATE * 30), 37, 'a month of heavy work')
	assert.equal(levelFor(RATE * 365), 85, 'a year of heavy work')
	assert.ok(levelFor(RATE * 365) < 99, 'a year of work must not cap the scale')
	assert.equal(xpForLevel(3), 9)
	assert.equal(levelFor(1_000_000), 99, 'the badge only has room for two digits')
	assert.equal(levelFor(0), 1)
	// a commit is the strongest single signal, but it cannot outrank sustained work
	assert.ok(xpOf({ commits: 1 }) > xpOf({ edits: 5 }), 'a commit is worth less than five edits')
	assert.ok(xpOf({ edits: 100, activeMin: 200 }) > xpOf({ commits: 10 }), 'commits swamp real work')
	// time only counts when it was spent working — an idle session must score zero
	assert.equal(xpOf({ activeMin: 0, edits: 0, commits: 0, subs: 0 }), 0)
})

test('live sessions land on distinct levels', () => {
	const list = collect()
	if (list.length < 3) return
	const levels = list.map((s) => s.level)
	assert.ok(Math.max(...levels) > Math.min(...levels) + 2, 'every session landed on the same rank')
	// and the tier colours have to move too, or a wide spread still paints one hue
	assert.ok(new Set(list.map((s) => tierOf(s.level).name)).size >= 3, 'one tier swallowed the whole room')
})

test('a project name is never a filename or a literal null', () => {
	for (const s of collect()) {
		assert.ok(s.proj, 'a session has no project name')
		assert.ok(!/\.[a-z]{1,4}$/.test(s.proj), `${s.proj} looks like a filename`)
		assert.notEqual(s.proj, 'null')
		assert.notEqual(s.proj, 'undefined')
		// and never the container the session happened to launch from
		assert.ok(!/^(projects|repos|workspace)$/.test(s.proj), 'named after a container')
	}
})

test('a session that moved directory resolves to its live transcript', () => {
	// The same session id can exist under several project slugs — one per directory
	// the session has worked in. Picking the wrong one is silent and total: activity
	// text, commit counts and lifetime totals all come from an abandoned file.
	const root = path.join(process.env.HOME ?? '', '.claude', 'projects')
	const all = new Map<string, string[]>()
	let dirs: string[] = []
	try {
		dirs = fs.readdirSync(root)
	} catch {
		return
	}
	for (const d of dirs) {
		let files: string[] = []
		try {
			files = fs.readdirSync(path.join(root, d))
		} catch {
			continue
		}
		for (const f of files) {
			if (!f.endsWith('.jsonl')) continue
			const id = f.slice(0, -6)
			all.set(id, [...(all.get(id) ?? []), path.join(root, d, f)])
		}
	}
	const dupes = [...all].filter(([, v]) => v.length > 1)
	if (!dupes.length) return
	const idx = transcriptIndex()
	const mt = (f: string) => {
		try {
			return fs.statSync(f).mtimeMs
		} catch {
			return 0
		}
	}
	for (const [id, paths] of dupes) {
		const picked = idx.get(id)
		if (!picked) continue
		const newest = Math.max(...paths.map(mt))
		assert.equal(mt(picked), newest, `${id} resolved to a stale transcript`)
	}
})

/** The dull half of a Session, so a pairing test can say only what it is about. */
const blank: Session = {
	id: '', pid: 0, name: '', proj: '', cwd: '/x', state: 'working', stale: 0, title: '', doing: '', short: '',
	last: '', ctxUsed: 0, ctxLimit: 200_000, unread: false, palette: 0, hueShift: 0, toolKind: 'think', turns: 0,
	level: 1, xp: 0,
}

test('a session with no agent record still gets its tab, by terminal device', async () => {
	// The gap this closes: cmux writes NO agent id for a workspace created from the
	// CLI — `terminal.agent` and `resumeBinding` were still null at 90 seconds — so
	// a session started from the browser had no tab and nothing to type into.
	//
	// Two earlier attempts are recorded in MISTAKES.md and must not come back.
	// Matching on the shared directory was ambiguous: seven sessions here have
	// `~/projects` as their cwd, and the browser opened whichever was busiest — an
	// unrelated session, mid-conversation. Remembering the workspace at spawn time
	// was exact but in-memory, and the watcher restarts the server on every edit.
	//
	// A tty belongs to exactly one terminal, so there is nothing left to guess.
	const { tabForTty } = await import('./data/cmux.ts')
	assert.equal(tabForTty(''), undefined, 'no tty is not a match')
	assert.equal(tabForTty('??'), undefined, 'a process with no controlling terminal has no tab')

	// A row that already has a workspace is never re-pointed by this.
	const rows: Session[] = [{ ...blank, id: 'a', proj: 'x', cwd: '/x', pid: 1, tab: 3, workspace: 'REAL' }]
	assert.equal(pairByTty(rows)[0]!.workspace, 'REAL')
})

test('a second harness is off by default, and never labels an existing session', () => {
	// The containment claim, checked rather than asserted in a comment.
	//
	// It does NOT compare two `collect()` calls to each other, which is what the first
	// version did and was racy by construction: both read live sessions, and a real
	// session's `doing` and `state` change between two calls milliseconds apart. That
	// produced an intermittent failure — the kind of test that is worse than none,
	// because the next person to see it red will assume it is weather.
	//
	// What holds whatever is running: with the flag off, nothing may come back wearing
	// a harness label. `codexSessions()` returning nothing for an empty directory is
	// covered deterministically in data/codex.test.ts.
	for (const s of collect()) {
		assert.equal(s.agent, undefined, 'a Claude Code session was labelled with a harness')
	}
	for (const s of collect(false)) {
		assert.equal(s.agent, undefined, 'passing the flag explicitly off still added a harness')
	}
})

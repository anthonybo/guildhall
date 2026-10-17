/**
 * Which lead a teammate belongs to.
 *
 * The failure worth guarding is drawing teammates at the WRONG desk, which looks exactly
 * as plausible as the right one. So these pin the link to the teammate's own
 * `--parent-session-id`, and pin that the team file's `leadSessionId` — measured to be
 * a different id from the lead's session — is never what decides it.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type Proc, type ProcStore, parseTeammate, resetTeams, teamsByLead } from './teams.ts'

/** An in-memory store, so no test reads or writes the real cache. */
const memory = (): ProcStore & { v: ReturnType<ProcStore['load']> } => {
	const m = { v: null as ReturnType<ProcStore['load']>, load: () => m.v, save: (x: NonNullable<ReturnType<ProcStore['load']>>) => void (m.v = x) }
	return m
}

const LEAD = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444'
const BIN = '/opt/TEST-ONLY/.local/share/claude/versions/9.9.9'
const argv = (name: string, parent: string, color = 'blue') => `${BIN} --agent-id ${name}@TEST-ONLY-team --agent-name ${name} --team-name TEST-ONLY-team --agent-color ${color} --agent-type TEST-ONLY-author --parent-session-id ${parent}`

let dir: string
function team(members: { name: string; isActive?: boolean }[], leadSessionId = 'cccccccc-1111-2222-3333-444444444444') {
	fs.mkdirSync(path.join(dir, 'TEST-ONLY-team'), { recursive: true })
	fs.writeFileSync(
		path.join(dir, 'TEST-ONLY-team', 'config.json'),
		JSON.stringify({ name: 'TEST-ONLY-team', leadSessionId, members: [{ name: 'team-lead', backendType: 'in-process', tmuxPaneId: 'leader' }, ...members.map((m) => ({ ...m, backendType: 'tmux', tmuxPaneId: `%${m.name}` }))] }),
	)
}
/** A process list where every teammate is this test process — always alive. */
const procs = (...ps: Proc[]) => () => new Map(ps.map((p) => [`${p.team}/${p.name}`, p]))
const mate = (name: string, parent: string): Proc => ({ ...parseTeammate(process.pid, argv(name, parent))!, pid: process.pid })

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-teams-'))
	resetTeams()
})

test('a teammate is read from its own launch arguments', () => {
	const p = parseTeammate(42, argv('fish-ocean', LEAD, 'blue'))
	assert.deepEqual(p, { pid: 42, name: 'fish-ocean', team: 'TEST-ONLY-team', parent: LEAD, color: 'blue', type: 'TEST-ONLY-author' })
})

test('only the claude binary counts, not the shells wrapped around it', () => {
	// Measured: each teammate sat under a `login` and an `sh -lc` whose quoted command
	// carried the same flags. Counting those would draw every teammate three times.
	assert.equal(parseTeammate(1, `/usr/bin/login -flp TEST-ONLY /bin/sh -lc '${argv('fish-ocean', LEAD)}'`), null)
	assert.equal(parseTeammate(1, `-/bin/sh -lc ${argv('fish-ocean', LEAD)}`), null)
	assert.ok(parseTeammate(1, argv('fish-ocean', LEAD).replace(BIN, '/opt/TEST-ONLY/.local/bin/claude')), 'the unversioned binary was refused')
})

test('a process with no parent is not a teammate that can be placed', () => {
	assert.equal(parseTeammate(1, argv('fish-ocean', LEAD).replace(/--parent-session-id \S+/, '')), null)
})

test('the lead comes from the teammates, never from the team file', () => {
	// The trap, measured: the team file named a lead that was not the lead. Its
	// leadSessionId is set to something else here, and must change nothing.
	team([{ name: 'fish-ocean', isActive: true }, { name: 'fish-trench', isActive: false }], OTHER)
	const teams = teamsByLead(1_000, dir, procs(mate('fish-ocean', LEAD), mate('fish-trench', LEAD)), memory())
	assert.deepEqual([...teams.keys()], [LEAD], 'the team was attached to the id in the team file')
	const t = teams.get(LEAD)!
	assert.deepEqual(
		t.members.map((m) => [m.name, m.active]),
		[
			['fish-ocean', true],
			['fish-trench', false],
		],
	)
})

test('a team whose members disagree about their lead is not drawn', () => {
	// Picking one would be a guess. Leaving it out is honest.
	team([{ name: 'fish-ocean' }, { name: 'fish-trench' }])
	const teams = teamsByLead(1_000, dir, procs(mate('fish-ocean', LEAD), mate('fish-trench', OTHER)), memory())
	assert.equal(teams.size, 0)
})

test('a listed teammate with no process is left out', () => {
	team([{ name: 'fish-ocean' }, { name: 'fish-gone' }])
	const t = teamsByLead(1_000, dir, procs(mate('fish-ocean', LEAD)), memory()).get(LEAD)!
	assert.deepEqual(
		t.members.map((m) => m.name),
		['fish-ocean'],
	)
})

test('a room with no teams never lists processes', () => {
	// `ps` is the most expensive thing a poll does. No team, no listing — ever.
	let calls = 0
	const counted = () => {
		calls++
		return new Map<string, Proc>()
	}
	for (let i = 0; i < 50; i++) teamsByLead(i * 2_000, dir, counted, memory())
	assert.equal(calls, 0, `listed processes ${calls} times with no team on disk`)
})

test('a steady team lists processes once, not every poll', () => {
	team([{ name: 'fish-ocean' }])
	let calls = 0
	const counted = () => {
		calls++
		return procs(mate('fish-ocean', LEAD))()
	}
	for (let i = 0; i < 50; i++) teamsByLead(1_000 + i * 2_000, dir, counted, memory())
	assert.equal(calls, 1, `a team that never changed cost ${calls} process listings`)
})

test('a fresh process reuses the last listing instead of listing again', () => {
	// The menu bar's every poll is a fresh process, so without sharing, a running team cost
	// a full process listing per poll — ~80 cpu-ms in `ps`, unseen by the perf gate.
	team([{ name: 'fish-ocean' }])
	const store = memory()
	let calls = 0
	const counted = () => {
		calls++
		return procs(mate('fish-ocean', LEAD))()
	}
	teamsByLead(1_000, dir, counted, store)
	for (let i = 1; i <= 10; i++) {
		resetTeams() // a new process: nothing in memory
		const t = teamsByLead(1_000 + i * 2_000, dir, counted, store)
		assert.equal(t.get(LEAD)?.members[0]?.name, 'fish-ocean', 'the shared listing lost the teammate')
	}
	assert.equal(calls, 1, `ten fresh processes cost ${calls} listings`)
})

test('a shared listing from before the team file changed is not trusted', () => {
	team([{ name: 'fish-ocean' }])
	const store = memory()
	let calls = 0
	const counted = () => {
		calls++
		return procs(mate('fish-ocean', LEAD), mate('fish-trench', LEAD))()
	}
	teamsByLead(1_000, dir, counted, store)
	// a teammate joins: the file is rewritten, so the old listing describes another team
	const f = path.join(dir, 'TEST-ONLY-team', 'config.json')
	const later = new Date(Date.now() + 5_000)
	team([{ name: 'fish-ocean' }, { name: 'fish-trench' }])
	fs.utimesSync(f, later, later)
	resetTeams()
	const t = teamsByLead(3_000, dir, counted, store)
	assert.equal(calls, 2, 'a stale listing was trusted after the team changed')
	assert.deepEqual(
		t.get(LEAD)?.members.map((m) => m.name),
		['fish-ocean', 'fish-trench'],
	)
})

test('a shared listing older than a minute is not trusted', () => {
	// The bound on staleness, and on a reused pid.
	team([{ name: 'fish-ocean' }])
	const store = memory()
	let calls = 0
	const counted = () => {
		calls++
		return procs(mate('fish-ocean', LEAD))()
	}
	teamsByLead(1_000, dir, counted, store)
	resetTeams()
	teamsByLead(1_000 + 61_000, dir, counted, store)
	assert.equal(calls, 2, 'a listing more than a minute old was reused')
})

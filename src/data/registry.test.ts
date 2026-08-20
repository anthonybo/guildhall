/**
 * Telling a background job from the spare the daemon keeps warm for it.
 *
 * The registry entries here are real ones, trimmed: both processes were running
 * side by side on this machine, both wrote `kind: "bg"`, and only one of them was
 * a session anybody had asked for.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { liveSessions } from './registry.ts'

/** Two pids that are certainly alive, so liveness never decides these tests.
 *  A registry file is named for its pid, so two entries need two of them. */
const PID = process.pid
const PPID = process.ppid

/** An ordinary terminal session, present so the list is never empty and the
 *  supported-lookup fallback stays out of these tests. */
const TERMINAL = { pid: PPID, sessionId: 'terminal', cwd: '/x/projects', kind: 'interactive', name: 'orchard-e8', status: 'idle' }

function write(dir: string, entries: Record<string, unknown>[]) {
	fs.mkdirSync(dir, { recursive: true })
	for (const e of entries) fs.writeFileSync(path.join(dir, `${e.pid}.json`), JSON.stringify(e))
	return dir
}

const dirWith = (entries: Record<string, unknown>[]) => write(fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-registry-')), entries)

test('an unclaimed spare is not a session', () => {
	// Verbatim shape of the spare that produced a third `tidepool` row: named after
	// its own job id, idle, and with no job directory behind it. The daemon logged
	// it as `bg spawned abcd1234 (spare)` and `claude agents --json` never listed it.
	const dir = dirWith([TERMINAL, { pid: PID, sessionId: 'spare-a', cwd: '/x/projects/tidepool', kind: 'bg', name: 'spare-job-a', jobId: 'spare-job-a', agent: 'claude', status: 'idle' }])
	assert.deepEqual(
		liveSessions(dir).map((s) => s.sessionId),
		['terminal'],
		'the spare was listed as a session',
	)
})

test('a claimed spare is still a session, whatever its command line says', () => {
	// The regression that matters most here. A spare that has been handed a job
	// keeps `claude bg-spare …` as its argv for life, because argv is fixed at exec
	// — the busiest session in the room was running under exactly that command line.
	// Nothing may key off the command line, and a named job is kept on its name
	// alone, without needing anything on disk.
	const dir = dirWith([TERMINAL, { pid: PID, sessionId: 'job-a', cwd: '/x/projects', kind: 'bg', name: 'Seed the fixtures from the importer', jobId: 'claimed-job-a', status: 'busy' }])
	assert.ok(liveSessions(dir).some((s) => s.sessionId === 'job-a'), 'a working background job was dropped')
})

test('a background job doing something is kept before it has a title', () => {
	// A job is auto-named a turn or two in, so for its first moments its name is
	// still its own id. Being busy is enough on its own — excluding too much is the
	// expensive mistake, because a missing session is invisible.
	const dir = dirWith([TERMINAL, { pid: PID, sessionId: 'job-b', cwd: '/x/projects', kind: 'bg', name: 'fresh-job-b', jobId: 'fresh-job-b', status: 'busy' }])
	assert.ok(liveSessions(dir).some((s) => s.sessionId === 'job-b'), 'an unnamed but working job was dropped')
})

test('a job with a timeline on disk is kept even while idle and unnamed', () => {
	// The definitive signal: `~/.claude/jobs/<jobId>/` gains a timeline once the job
	// owns work, and a spare's never does. Checked against `claude agents --json` on
	// this machine — the jobs with that file are exactly the ones it reports.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-home-'))
	const job = path.join(home, '.claude', 'jobs', 'idle-job-c')
	fs.mkdirSync(job, { recursive: true })
	fs.writeFileSync(path.join(job, 'timeline.jsonl'), '{"state":"working"}\n')
	// the jobs directory is resolved as a sibling of the registry directory
	const dir = write(path.join(home, '.claude', 'sessions'), [TERMINAL, { pid: PID, sessionId: 'job-c', cwd: '/x/projects', kind: 'bg', name: 'idle-job-c', jobId: 'idle-job-c', status: 'idle' }])
	assert.ok(liveSessions(dir).some((s) => s.sessionId === 'job-c'), 'a job with work on disk was dropped')
})

test('an interactive session is never judged by any of this', () => {
	// Only `kind: "bg"` is ever a spare. An idle terminal named after its own
	// directory must survive untouched, and there are eight of those here.
	const dir = dirWith([TERMINAL])
	assert.deepEqual(
		liveSessions(dir).map((s) => s.sessionId),
		['terminal'],
	)
})

/**
 * Telling a background job from the spare the daemon keeps warm for it.
 *
 * The registry entries here are real ones, trimmed: both processes were running
 * side by side on this machine, both wrote `kind: "bg"`, and only one of them was
 * a session anybody had asked for.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

/**
 * The PID-reuse guard, and the thing it must not do: drop a session that is running.
 *
 * A working session vanished from the room with nothing said. It was alive, in the
 * registry, with a transcript on disk — and the guard threw it away because it compared
 * `startedAt`, which is when the SESSION began, against what `ps` reports, which is when
 * the PROCESS began. Resume a session, or start a new conversation in a process that is
 * already up, and those are different times. Measured on the real machine: 14.8 minutes
 * apart, against a five-minute threshold.
 *
 * `process.pid` is used so `ps` reports a genuine start time and the comparison is real
 * rather than mocked.
 */
const realStart = () => {
	const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
	return Date.parse(lstart)
}

/** A registry file for this very process, with the two timestamps set as given. */
function stamped(dir: string, id: string, procStart: string | undefined, startedAt: number | undefined) {
	fs.writeFileSync(
		path.join(dir, `${process.pid}.json`),
		JSON.stringify({ pid: process.pid, sessionId: id, cwd: '/tmp/guildhall-fixture/orchard', kind: 'interactive', status: 'busy', ...(procStart ? { procStart } : {}), ...(startedAt ? { startedAt } : {}) }),
	)
}

test('a session resumed long after its process started is kept', () => {
	// The exact shape of the session that was lost: procStart correct, startedAt
	// fifteen minutes later because the session began later than the process did.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-reg-start-'))
	const started = realStart()
	const utc = new Date(started).toUTCString().replace('GMT', '').trim()
	// `ps`-style UTC stamp, the format Claude Code writes
	const procStart = new Date(started).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) /, '$2 $1 $3 ').replace(' GMT', '')
	stamped(dir, 'resumed', new Date(started).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''), started + 15 * 60_000)
	assert.ok(
		liveSessions(dir).some((s) => s.sessionId === 'resumed'),
		`a running session was dropped over its startedAt (procStart ${procStart}, utc ${utc})`,
	)
	fs.rmSync(dir, { recursive: true, force: true })
})

test('a pid that was reused is still dropped', () => {
	// The guard has to keep working. A registry entry claiming a process start hours
	// from what ps reports is a recycled pid, not a session.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-reg-reuse-'))
	const wrong = new Date(realStart() - 6 * 60 * 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
	stamped(dir, 'recycled', wrong, undefined)
	assert.ok(!liveSessions(dir).some((s) => s.sessionId === 'recycled'), 'a reused pid was accepted')
	fs.rmSync(dir, { recursive: true, force: true })
})

test('an entry with no procStart falls back to startedAt', () => {
	// Older entries have only the epoch, and must not be dropped for lacking a field.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-reg-old-'))
	stamped(dir, 'legacy', undefined, realStart())
	assert.ok(
		liveSessions(dir).some((s) => s.sessionId === 'legacy'),
		'an entry without procStart was dropped',
	)
	fs.rmSync(dir, { recursive: true, force: true })
})

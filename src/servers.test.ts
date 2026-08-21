/**
 * Knowing that a second guildhall is serving.
 *
 * Two were, for half an hour, on different ports and both bound to every interface —
 * and nothing in the program said so. "I have no indication of that and how would I
 * know" is the bug these tests exist for.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-servers-'))

import { announce, others, othersNote, stop, withdraw } from './servers.ts'

const DIR = path.join(process.env.GUILDHALL_CONFIG_DIR!, 'servers')

test('a lone server reports nobody else', () => {
	announce(4250, '0.0.0.0')
	assert.deepEqual(others(), [], 'a server found itself')
	assert.equal(othersNote(), null, 'a single server warned about itself')
	withdraw()
})

test('a second server is found, named, and its port given', () => {
	// This process stands in for the service; a live pid that is not us stands in for
	// the dev watcher. `process.ppid` is guaranteed alive and is not this process.
	announce(4250, '0.0.0.0')
	announce(4319, '0.0.0.0', process.ppid)
	const list = others()
	assert.equal(list.length, 1, `expected one other server, got ${list.length}`)
	assert.equal(list[0]!.port, 4319)
	assert.equal(list[0]!.pid, process.ppid)
	// The note has to name the PORT, not just say "another one exists": the port is the
	// only part that lets somebody go and look at it, or shut it down.
	const note = othersNote()
	assert.match(note!, /4319/, 'the note does not say which port')
	assert.match(note!, new RegExp(String(process.ppid)), 'the note does not say which process')
	withdraw()
	withdraw(process.ppid)
})

test('a server that died without cleaning up is forgotten, not reported forever', () => {
	// SIGKILL runs no cleanup, so a crashed server leaves its file behind. Without
	// pruning, the warning would name a process that no longer exists and keep doing so
	// until somebody cleared the directory by hand — a warning that cries wolf gets
	// ignored, which is this repo's stated reason for keeping the spell-check list short.
	//
	// Above the default `kern.maxproc` on macOS, so it cannot be a live process.
	const dead = 999_999
	announce(1234, '0.0.0.0', dead)
	assert.ok(fs.existsSync(path.join(DIR, `${dead}.json`)), 'the fixture was not written')
	assert.deepEqual(others(), [], 'a dead server was reported as serving')
	assert.equal(fs.existsSync(path.join(DIR, `${dead}.json`)), false, 'the stale entry was left on disk')
})

test('withdrawing stops the report, so stopping a server is visible immediately', () => {
	announce(4319, '0.0.0.0', process.ppid)
	assert.equal(others().length, 1)
	withdraw(process.ppid)
	assert.deepEqual(others(), [], 'a withdrawn server is still reported')
})

test('rubbish in the directory is ignored rather than crashing the room', () => {
	// This directory is inside the config dir, which people edit. A half-written file or
	// something unrelated must not take down the panel that reads it.
	fs.mkdirSync(DIR, { recursive: true })
	fs.writeFileSync(path.join(DIR, 'notes.txt'), 'hello')
	fs.writeFileSync(path.join(DIR, 'abc.json'), '{}')
	fs.writeFileSync(path.join(DIR, `${process.ppid}.json`), '{ truncated')
	assert.deepEqual(others(), [], 'unparseable entries were reported as servers')
	fs.rmSync(path.join(DIR, 'notes.txt'))
	fs.rmSync(path.join(DIR, 'abc.json'))
	fs.rmSync(path.join(DIR, `${process.ppid}.json`))
})

test('stopping refuses any pid this registry did not announce', () => {
	// The guard that keeps a stop button from being something larger: a menu bar app able
	// to SIGTERM an arbitrary pid is a different kind of program, so the only pids
	// accepted are ones guildhall itself wrote a file for.
	//
	// ONLY pids that cannot be signalled are used here, and that is the point. An earlier
	// version passed `process.ppid` and pid 1. With the guard deliberately removed to
	// check it was load-bearing, the test SIGTERMed its own parent shell — which is why
	// the run produced no output at all, including the failure it was supposed to report.
	// A test that verifies a safety check by tripping it has to be harmless when the check
	// is gone.
	//
	// 999_999 is above the default `kern.maxproc`, so kill can only ever return ESRCH.
	for (const pid of [999_999, 999_998]) {
		const r = stop(pid)
		assert.equal(r.ok, false, `stop(${pid}) was allowed`)
		if (!r.ok) assert.match(r.why, /not a guildhall server/, `stop(${pid}) refused for the wrong reason`)
	}
	// 0 and negatives are refused by a SEPARATE gate, before the registry is consulted,
	// and they are the dangerous ones: kill(0) signals this process group and kill(-1)
	// signals everything the caller may signal. Asserting the distinct wording proves the
	// second gate stopped them, not the registry check.
	for (const pid of [0, -1, -999, 1.5, NaN]) {
		const r = stop(pid)
		assert.equal(r.ok, false, `stop(${pid}) was allowed`)
		if (!r.ok) assert.match(r.why, /is not a process id/, `stop(${pid}) was refused by the wrong gate`)
	}
})

test('an announced server really is stopped, so the refusals above are not refusing everything', async () => {
	// Without this, `stop()` could return false unconditionally and every assertion above
	// would still pass — a guard test that proves nothing.
	//
	// A DISPOSABLE child, never a real process: `sleep` exists to be killed, and nothing
	// depends on it. Registering someone else's pid and then signalling it is how the
	// previous version of this test killed the shell running it.
	const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
	try {
		await new Promise((r) => setTimeout(r, 50)) // let it exist before announcing it
		announce(4321, '127.0.0.1', child.pid!)
		assert.ok(
			others().some((s) => s.pid === child.pid),
			'an announced live process is not in the registry, so stop would refuse it',
		)
		const r = stop(child.pid!)
		assert.equal(r.ok, true, `stop refused a server it had announced: ${r.ok ? '' : r.why}`)
		// and it is actually gone — the claim is the process, not the return value
		const died = await new Promise<boolean>((res) => {
			child.once('exit', () => res(true))
			setTimeout(() => res(false), 2000)
		})
		assert.ok(died, 'stop reported success but the process is still running')
		withdraw(child.pid!)
	} finally {
		child.kill('SIGKILL')
	}
})

test('the launchd service is recorded as such, so a panel can tell it from a stray', () => {
	// The menu bar listed the service itself under "another guildhall is also serving",
	// with a button offering to stop it — the opposite of useful. It needs to tell the
	// server it asked for from one it forgot about.
	//
	// Recorded rather than inferred from the port, because the port drifts: change the
	// setting without restarting the service and it is still bound to the old one, at
	// which point comparing ports calls the intended server a stray.
	announce(4250, '0.0.0.0', process.ppid)
	const [entry] = others()
	assert.ok(entry, 'nothing was announced')
	// This test process is not launchd's child, so `service` must be false — the flag has
	// to reflect the real parent rather than being hardcoded either way.
	assert.equal(entry!.service, false, 'a process not started by launchd claimed to be the service')
	withdraw(process.ppid)
})

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

process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-servers-'))

import { announce, others, othersNote, withdraw } from './servers.ts'

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

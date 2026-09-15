/**
 * Sessions you closed, offered back.
 *
 * The risk is offering the wrong thing: a session that is actually running, or a directory
 * this machine never said could be started in. Both would be acted on by a tap from a
 * phone, so both are asserted here rather than left to the endpoint.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-closed-'))
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-closed-root-'))
process.env.GUILDHALL_HOME = HOME
process.env.GUILDHALL_PROJECTS = ROOT

// Imported AFTER the environment is set: paths.ts reads it once, at load. Same shape as
// commands.test.ts, and the reason that file uses a dynamic import too.
const { closedSessions } = await import('./closed.ts')

const PROJ = path.join(HOME, '.claude', 'projects', 'TEST-ONLY-slug')
const A = 'aaaaaaaa-1111-2222-3333-444444444444'
const B = 'bbbbbbbb-1111-2222-3333-444444444444'

/** A project directory the spawn allowlist will accept: a git repo under the root. */
function project(name: string) {
	const dir = path.join(ROOT, name)
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
	return dir
}

/** A transcript laid out the way Claude Code writes one. */
function transcript(id: string, cwd: string, first = 'do the thing', ageMs = 0) {
	fs.mkdirSync(PROJ, { recursive: true })
	const lines = [JSON.stringify({ type: 'file-history-snapshot', cwd }), JSON.stringify({ type: 'user', cwd, message: { content: first } })]
	const file = path.join(PROJ, `${id}.jsonl`)
	fs.writeFileSync(file, `${lines.join('\n')}\n`)
	if (ageMs) {
		const t = new Date(Date.now() - ageMs)
		fs.utimesSync(file, t, t)
	}
}

beforeEach(() => {
	fs.rmSync(PROJ, { recursive: true, force: true })
	fs.mkdirSync(PROJ, { recursive: true })
})

test('a session with a process attached is never offered', () => {
	// The whole point of the list is that these are CLOSED. Offering a live one would put a
	// second window on a conversation somebody is in the middle of.
	const dir = project('orchard')
	transcript(A, dir)
	transcript(B, dir)
	assert.deepEqual(
		closedSessions([]).map((c) => c.id).sort(),
		[A, B],
		'both should be offered when nothing is running',
	)
	assert.deepEqual(
		closedSessions([A]).map((c) => c.id),
		[B],
		'a running session was offered as closed',
	)
})

test('a directory the machine would not start in is not offered', () => {
	// Reopening runs `claude` somewhere, so it is gated on the same allowlist as spawning.
	// A cwd read out of a file is still a cwd this process did not choose.
	transcript(A, '/etc')
	assert.deepEqual(closedSessions([]), [], 'offered a session outside the allowlist')
})

test('what it says about a session is read from the transcript', () => {
	// Not inferred. Matching a session to a directory by anything approximate is the
	// mistake this project has already made once, and the transcript states both outright.
	const dir = project('orchard')
	transcript(A, dir, 'why does the build take four minutes')
	const [one] = closedSessions([])
	assert.ok(one, 'nothing offered')
	assert.equal(one.cwd, dir)
	assert.equal(one.proj, 'orchard')
	assert.match(one.title, /four minutes/, 'the opening prompt is what tells two closed sessions apart')
})

test('the newest comes first and stale ones fall off', () => {
	const dir = project('orchard')
	transcript(A, dir, 'recent', 5 * 3600 * 1000)
	transcript(B, dir, 'ancient', 60 * 24 * 3600 * 1000)
	const ids = closedSessions([]).map((c) => c.id)
	assert.deepEqual(ids, [A], 'a two-month-old session is not one you are coming back to')
})

test('a transcript with no cwd is skipped rather than guessed at', () => {
	// Without a directory there is nowhere to reopen it, and picking one would be the
	// directory-matching bug wearing a different hat.
	fs.writeFileSync(path.join(PROJ, `${A}.jsonl`), `${JSON.stringify({ type: 'summary', summary: 'no cwd here' })}\n`)
	assert.deepEqual(closedSessions([]), [], 'offered a session with no directory')
})

test('a truncated transcript does not throw', () => {
	// The reader stops after a fixed number of bytes by design, so the last line it sees is
	// routinely half a JSON object. These files also reach 22MB, which is why it stops.
	const dir = project('orchard')
	fs.writeFileSync(path.join(PROJ, `${A}.jsonl`), `${JSON.stringify({ type: 'user', cwd: dir, message: { content: 'fine' } })}\n{"type":"user","mess`)
	const [one] = closedSessions([])
	assert.ok(one, 'a truncated tail lost the whole session')
	assert.equal(one.cwd, dir)
})

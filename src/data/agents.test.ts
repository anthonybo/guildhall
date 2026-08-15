/** The supported session lookup, and the fallback that uses it. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgents } from './agents.ts'
import { liveSessions } from './registry.ts'

/** A real payload from `claude agents --json`, trimmed to two records. */
const REAL = JSON.stringify([
	{ id: '3f239506', cwd: '/x/quillfeather', kind: 'background', startedAt: 1785814301517, sessionId: '11111111-2222-3333-4444-555555555555', name: 'Build a dashboard', state: 'blocked' },
	{ id: '86031b90', cwd: '/x/projects', kind: 'interactive', startedAt: 1786033920777, sessionId: '66666666-7777-8888-9999-aaaaaaaaaaaa', name: 'projects-a2', pid: 5100, status: 'busy' },
])

test('a CLI payload becomes registry entries', () => {
	const out = parseAgents(REAL)
	assert.ok(out)
	// the background record has no pid: it is not a session you can look at, and
	// the file registry never contained one either
	assert.equal(out.length, 1)
	assert.deepEqual(out[0], {
		pid: 5100,
		sessionId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
		cwd: '/x/projects',
		name: 'projects-a2',
		status: 'busy',
		startedAt: 1786033920777,
		kind: 'interactive',
	})
})

test('status keeps the vocabulary stateOf already understands', () => {
	// busy | shell | idle | waiting — the same field name and values the registry
	// files use, which is why the fallback needs no translation layer
	const out = parseAgents(JSON.stringify([{ pid: 1, sessionId: 's', cwd: '/x', status: 'waiting' }]))
	assert.equal(out?.[0].status, 'waiting')
})

test('a malformed answer is no answer, never a crash', () => {
	// an older claude without the subcommand prints usage text to stdout, and a
	// half-written pipe is not JSON. Both must leave the cache alone.
	assert.equal(parseAgents('not json at all'), null)
	assert.equal(parseAgents('{"agents":[]}'), null, 'an object is not the array this expects')
	assert.deepEqual(parseAgents('[]'), [])
	assert.deepEqual(parseAgents('[null, 3, {"nope": 1}]'), [], 'junk entries are dropped, not thrown on')
})

test('an unreadable registry falls back instead of emptying the room', () => {
	// The failure this exists for: the directory moves or its schema changes, every
	// entry is discarded as malformed, and liveSessions() returns nothing. It must
	// reach for the supported lookup rather than report an empty office.
	// The CLI answer arrives asynchronously, so the first call legitimately returns
	// []; what matters is that it neither throws nor blocks.
	const t = Date.now()
	const out = liveSessions('/nonexistent-registry-directory')
	assert.ok(Array.isArray(out))
	// 500ms, not 200. This is the one wall-clock assertion in the suite and the
	// ceiling has to clear the machine's weather, which the old one did not: it
	// failed about two runs in five while the machine sat at load 95, blocking
	// commits at random for no defect. Measured at load 16 the call takes 26-35ms.
	//
	// The number it must still catch is 730ms — the cost of `claude agents --json`,
	// which is what "blocked" would mean here. So the gap between a call that
	// returned immediately and one that waited on the subprocess is wide enough that
	// the ceiling can sit well clear of both.
	//
	// CPU time would be the usual answer here and is the wrong instrument for once:
	// waiting on a subprocess costs no CPU, so the regression would be invisible.
	assert.ok(Date.now() - t < 500, `liveSessions blocked for ${Date.now() - t}ms; the lookup must stay in the background`)
})

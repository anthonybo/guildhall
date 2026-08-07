import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, levelFor, xpForLevel, xpOf } from './data.ts'

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
	// n^3: seven levels is one doubling above about L20, so a session that has done
	// far more work reads far higher rather than tying at a cap
	assert.equal(xpForLevel(2), 8)
	assert.equal(xpForLevel(10), 1000)
	assert.equal(xpForLevel(23), 12167)
	assert.equal(levelFor(12167), 23)
	assert.equal(levelFor(0), 1)
	// and the weights favour change made over turns spent
	assert.ok(xpOf({ revs: 100 }) > xpOf({ turns: 1000 }), 'turns outweigh revisions')
})

test('live sessions land on distinct levels', () => {
	const list = collect()
	if (list.length < 3) return
	const levels = list.map((s) => s.level)
	assert.ok(Math.max(...levels) > Math.min(...levels) + 2, 'every session landed on the same rank')
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

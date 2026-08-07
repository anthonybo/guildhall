import assert from 'node:assert/strict'
import test from 'node:test'
import { collect } from './data.ts'

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

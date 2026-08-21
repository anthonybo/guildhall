import assert from 'node:assert/strict'
import test from 'node:test'
import { askCodex } from './control.ts'

/**
 * The validations, not the delivery.
 *
 * Every case here is refused BEFORE a process is spawned, which is the point: this
 * project's rule about driving an agent CLI was written after `cmux send` with an
 * unmatched target fell back to whatever surface was focused and typed test strings
 * into a live session, twice. Nothing below can reach a real thread.
 */

test('every malformed target is refused, before anything is spawned', async () => {
	// `await` in the loop, deliberately. The first version of this returned inside the
	// loop, so it checked one case and reported six — a test that passes for the wrong
	// reason, which this project has already been bitten by more than once.
	for (const bad of ['', ' ', 'not-a-uuid', '../../etc/passwd', '*', 'latest', '00000000', 'aaaaaaaa-1111-2222-3333']) {
		const r = await askCodex(bad, 'hello')
		assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)} as a thread id`)
		// OUR words, not the CLI's.
		//
		// The first version only asserted `ok === false`, and deleting the guard did not
		// fail it — because `codex queue` refuses these too. So the test proved the CLI
		// behaves well, which is not the claim: the guard exists precisely so this side
		// does not depend on that. Matching guildhall's own message is what makes the
		// test fail when the guard goes.
		assert.match(!r.ok ? r.error : '', /not a thread id/, `refused by codex rather than by us: ${JSON.stringify(bad)}`)
	}
})

const ID = 'aaaaaaaa-1111-2222-3333-444444444444'

test('an empty message is refused', async () => {
	const r = await askCodex(ID, '   ')
	assert.equal(r.ok, false)
	assert.match(!r.ok ? r.error : '', /nothing to send/)
})

test('a multi-line message is refused', async () => {
	// A newline would submit early and run the remainder as its own turn, which is
	// never what somebody typing into a box meant. Same rule as the cmux path.
	const r = await askCodex(ID, 'first line\nsecond line')
	assert.equal(r.ok, false)
	assert.match(!r.ok ? r.error : '', /one line/)
})

test('an enormous message is refused', async () => {
	const r = await askCodex(ID, 'x'.repeat(4001))
	assert.equal(r.ok, false)
	assert.match(!r.ok ? r.error : '', /too long/)
})

test('a well-formed but unknown thread fails with codex own words', async () => {
	// The only case that actually spawns the CLI, and it is safe by construction: a
	// zeroed UUID matches no thread. Verified directly — `codex queue` answers
	// "no rollout found for thread id …" and exits 1, so the status can be trusted
	// and stdout does not have to be sniffed.
	const r = await askCodex('00000000-0000-0000-0000-000000000000', 'guildhall test, not delivered')
	assert.equal(r.ok, false, 'a nonexistent thread reported success')
	assert.match(!r.ok ? r.error : '', /thread|rollout|session/i, `unhelpful error: ${!r.ok ? r.error : ''}`)
})

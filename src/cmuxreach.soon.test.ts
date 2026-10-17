/**
 * The server's reachability check must not turn a slow cmux into "cmux is unreachable".
 *
 * Reported from a phone: open chats kept showing "cmux could not be asked whether this
 * process may control it" while cmux was serving them fine. The check was a synchronous
 * `cmux capabilities` before every screen read, and under load it ran past its timeout.
 *
 * A fake cmux stands in, so nothing here can reach a real one. Its answer is read from a
 * file each run, which lets one test make it answer, then fail, then answer again.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-reachsoon-'))
process.env.GUILDHALL_CONFIG_DIR = dir
const answer = path.join(dir, 'answer')
const fake = path.join(dir, 'cmux')
// Prints the file's contents, or fails the way a timed-out or absent cmux does.
fs.writeFileSync(fake, `#!/bin/sh\n[ -s '${answer}' ] || exit 1\ncat '${answer}'\n`, { mode: 0o755 })
process.env.GUILDHALL_CMUX = fake
delete process.env.CMUX_SOCKET_CAPABILITY

const { reachSoon } = await import('./cmuxreach.ts')

const says = (mode: string | null) => fs.writeFileSync(answer, mode === null ? '' : JSON.stringify({ access_mode: mode }))

test('a re-check that fails keeps the last answer cmux gave, and a real answer replaces it', async () => {
	mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
	try {
		says(null)
		// Never answered at all: the refusal is still given, which is what it was for.
		assert.equal((await reachSoon()).ok, false, 'a cmux that never answered was treated as reachable')

		says('allowAll')
		assert.deepEqual(await reachSoon(), { ok: true })

		// cmux stops answering (the timeout under load). Past the reuse window, so it IS asked.
		says(null)
		mock.timers.tick(61_000)
		assert.deepEqual(await reachSoon(), { ok: true }, 'a failed re-check overrode a real answer — the reported bug')

		// A real answer still wins, so a genuine change of mode is noticed.
		says('cmuxOnly')
		mock.timers.tick(61_000)
		const r = await reachSoon()
		assert.equal(r.ok, false, 'a real cmuxOnly answer was ignored')
	} finally {
		mock.timers.reset()
	}
})

test('two checks at once ask cmux once', async () => {
	mock.timers.enable({ apis: ['Date'], now: 9_000_000 })
	try {
		says('allowAll')
		const [a, b] = [reachSoon(), reachSoon()]
		assert.equal(a, b, 'concurrent requests each started their own cmux process')
		await a
	} finally {
		mock.timers.reset()
	}
})

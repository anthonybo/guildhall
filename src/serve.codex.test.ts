/**
 * Turning Codex on has to reach the BROWSER, not just the room.
 *
 * `codex` was a plain boolean on ServeOptions, captured once when the server was
 * built. Pressing x in the room re-collected and redrew, so the desks appeared and
 * the setting looked like it had worked — while every phone kept getting a
 * Claude-only payload until somebody restarted the service. The menu bar switch was
 * worse: it writes config.json, which the headless process had already read.
 *
 * So this asserts on the JSON a client is served, before and after the flip, with
 * nothing restarted in between. Asserting that `opts.codex` is a function would
 * pass without proving a single session ever crossed the wire.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Both set before the imports that read them: a real passcode must not be touched,
// and the Codex reader resolves its directories at call time from these.
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-serve-codex-cfg-'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-serve-codex-'))
process.env.GUILDHALL_CODEX_DIR = path.join(root, 'sessions')
process.env.GUILDHALL_CODEX_LOCKS = path.join(root, 'thread-writer-locks')

import { createServer } from './serve.ts'
import { issue } from './auth.ts'

const ID = 'eeeeeeee-1111-2222-3333-444444444444'
// Invented, like every fixture in codex.test.ts — a real rollout is a transcript of
// somebody's actual work and does not belong in a public repository.
const CWD = '/tmp/guildhall-fixture/orchard'

function fixture() {
	const at = path.join(process.env.GUILDHALL_CODEX_DIR!, '2026/08/20')
	fs.mkdirSync(at, { recursive: true })
	fs.mkdirSync(process.env.GUILDHALL_CODEX_LOCKS!, { recursive: true })
	const records = [
		{
			timestamp: '2026-08-20T10:00:00.000Z',
			type: 'session_meta',
			payload: { session_id: ID, id: ID, cwd: CWD, originator: 'codex_cli', cli_version: '0.149.0' },
		},
		{ timestamp: '2026-08-20T10:00:01.000Z', type: 'turn_context', payload: { cwd: CWD, model: 'gpt-5' } },
	]
	fs.writeFileSync(path.join(at, `rollout-2026-08-20T10-00-00-${ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
	// The lock file is what marks a thread live; see docs/codex.md.
	fs.writeFileSync(path.join(process.env.GUILDHALL_CODEX_LOCKS!, `${ID}.lock`), '')
}

test('flipping the Codex setting reaches a browser with nothing restarted', async () => {
	fixture()
	let on = false
	// demo: false, because demo sessions are synthetic and never consult the setting
	// at all — the bug lives on the real path.
	const srv = createServer({ port: 0, host: '127.0.0.1', demo: false, codex: () => on, control: () => false, onSend: () => {} })
	await new Promise<void>((r) => {
		srv.listen(0, '127.0.0.1', () => r())
	})
	after(() => srv.close())
	const port = (srv.address() as { port: number }).port
	const cookie = `gh_sid=${issue()}`
	/** The Codex sessions in what a client is served right now. */
	const served = async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie } })
		assert.equal(res.status, 200, 'the sessions endpoint refused a valid view session')
		const body = (await res.json()) as { sessions?: { agent?: string; id: string }[] }
		// Only the Codex ones: this machine's real Claude sessions are whatever they
		// are, and asserting on them would make the test depend on who is working.
		return (body.sessions ?? []).filter((s) => s.agent === 'codex')
	}

	assert.deepEqual(await served(), [], 'a Codex session was served while the setting was off')

	on = true
	const after1 = await served()
	assert.equal(after1.length, 1, `expected exactly the one fixture thread after the flip, got ${after1.length}`)
	assert.equal(after1[0]!.id, ID)

	// And back, so this cannot pass by the payload merely being cached-then-warm.
	on = false
	assert.deepEqual(await served(), [], 'turning it back off left Codex sessions in the payload')
})

/**
 * The history's "You" list: every message you typed, and nothing that only looks like
 * one. It used to be built from loaded pages, so it was often empty, and it never had a
 * message sent while Claude was working, because those are stored differently.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set before the import that reads it, as history.test.ts does.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-mine-'))
process.env.HOME = HOME

const { yourMessages } = await import('./mine.ts')
const { historyPage } = await import('./history.ts')

const ID = 'eeeeeeee-1111-2222-3333-ffffffffffff'
const DIR = path.join(HOME, '.claude', 'projects', '-tmp-guildhall-fixture-mine')
const FILE = path.join(DIR, `${ID}.jsonl`)
fs.mkdirSync(DIR, { recursive: true })

const at = '2026-10-17T00:00:00.000Z'
const typed = (text: string) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: text } })
const queued = (text: string, kind = 'human') =>
	JSON.stringify({ type: 'attachment', timestamp: at, attachment: { type: 'queued_command', prompt: text, origin: { kind }, commandMode: 'prompt' } })
const result = JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'TEST-ONLY output' }] } })
const notice = typed('<task-notification>\n<summary>TEST-ONLY done</summary>\n</task-notification>')
const reply = JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'TEST-ONLY reply' }] } })

test('every message you typed, including ones sent while Claude was working, and nothing else', async () => {
	fs.writeFileSync(FILE, [typed('TEST-ONLY first'), reply, result, notice, queued('TEST-ONLY sent mid-turn'), queued('TEST-ONLY from a task', 'task'), typed('/clear')].join('\n') + '\n')
	const mine = (await yourMessages(ID))!
	assert.deepEqual(
		mine.map((m) => [m.text, m.queued ?? false]),
		[
			['TEST-ONLY first', false],
			['TEST-ONLY sent mid-turn', true],
			['/clear', false],
		],
	)
	// The line each one starts on, which is what the history's cards carry to be jumped to.
	const page = historyPage(ID)!
	const cards = page.entries.filter((e) => e.role === 'user' && e.kind === 'text' && e.line !== undefined)
	for (const m of mine) assert.ok(cards.some((e) => e.line === m.line), `no card for ${m.text}`)
	// And the history shows the mid-turn one as yours.
	assert.ok(page.entries.some((e) => e.queued && e.text === 'TEST-ONLY sent mid-turn'))
})

test('a second look reads only what was added, and a half-written line waits', async () => {
	fs.writeFileSync(FILE, typed('TEST-ONLY one') + '\n')
	assert.equal((await yourMessages(ID))!.length, 1)
	const half = typed('TEST-ONLY two')
	fs.appendFileSync(FILE, half.slice(0, 15))
	assert.equal((await yourMessages(ID))!.length, 1, 'a half-written line was read')
	fs.appendFileSync(FILE, half.slice(15) + '\n')
	assert.deepEqual(
		(await yourMessages(ID))!.map((m) => m.text),
		['TEST-ONLY one', 'TEST-ONLY two'],
	)
	assert.equal(await yourMessages('no-such-session'), null)
})

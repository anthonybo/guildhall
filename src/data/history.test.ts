/**
 * Reading a conversation backwards out of a transcript.
 *
 * The thing that has to hold is that paging loses NOTHING. A transcript is the only
 * record of the history — the terminal keeps none, because Claude Code draws on the
 * alternate screen where Ghostty hardcodes `scrollback-limit = 0` — so a page that
 * quietly drops entries produces a conversation with holes in it that reads as
 * complete. The first version did exactly that: it capped a page with
 * `entries.slice(-want * 4)` while leaving the cursor past everything it had read, so
 * the dropped entries were unreachable by any later page.
 *
 * So these tests walk a whole file to the beginning and assert every record comes back
 * exactly once, in order, across chunk boundaries.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set before the import that reads it: PROJ_DIR is built from the home directory at
// module load, and `os.homedir()` honours HOME.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-history-'))
process.env.HOME = HOME

const { historyPage } = await import('./history.ts')

const ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'
const DIR = path.join(HOME, '.claude', 'projects', '-tmp-guildhall-fixture-orchard')

/** `n` turns of invented conversation, each padded so the file crosses chunk boundaries. */
function write(n: number, pad = 0) {
	fs.mkdirSync(DIR, { recursive: true })
	const lines: string[] = []
	for (let i = 0; i < n; i++) {
		const filler = pad ? ' ' + 'x'.repeat(pad) : ''
		lines.push(
			JSON.stringify({
				type: 'user',
				timestamp: `2026-08-26T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
				message: { role: 'user', content: `question ${i}${filler}` },
			}),
		)
		lines.push(
			JSON.stringify({
				type: 'assistant',
				timestamp: `2026-08-26T00:00:${String(i % 60).padStart(2, '0')}.500Z`,
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: `answer ${i}${filler}` },
						{ type: 'tool_use', name: 'Read', input: { file_path: `/tmp/guildhall-fixture/file${i}.ts` } },
					],
				},
			}),
		)
	}
	fs.writeFileSync(path.join(DIR, `${ID}.jsonl`), lines.join('\n') + '\n')
	return n
}

/** Page all the way back, returning every entry oldest-first. */
function readAll() {
	const all: { text: string; kind: string }[] = []
	let before: number | undefined
	let guard = 0
	for (;;) {
		const page = historyPage(ID, before)
		assert.ok(page, 'no page')
		all.unshift(...page.entries.map((e) => ({ text: e.text, kind: e.kind })))
		if (page.cursor === null) break
		assert.ok(++guard < 500, 'paging did not reach the beginning')
		assert.notEqual(page.cursor, before, 'cursor did not move — this would loop forever')
		before = page.cursor
	}
	return all
}

test('a page comes back newest last, with each block flattened to its own entry', () => {
	write(3)
	const page = historyPage(ID)
	assert.ok(page)
	// user question, assistant answer, assistant tool call — per turn, in file order
	assert.deepEqual(
		page.entries.map((e) => `${e.role}/${e.kind}`),
		['user/text', 'assistant/text', 'assistant/tool', 'user/text', 'assistant/text', 'assistant/tool', 'user/text', 'assistant/text', 'assistant/tool'],
	)
	assert.equal(page.entries[0]!.text, 'question 0')
	assert.equal(page.entries.at(-1)!.tool, 'Read')
	// the tool's subject is what the terminal shows in `⏺ Read(...)`
	assert.match(page.entries.at(-1)!.text, /file2\.ts$/)
})

test('paging back across chunk boundaries loses nothing and duplicates nothing', () => {
	// Padded so the file is comfortably larger than the 256KB read chunk, which is the
	// only way the partial-line handling is exercised at all.
	const turns = write(400, 700)
	const file = path.join(DIR, `${ID}.jsonl`)
	assert.ok(fs.statSync(file).size > 256 * 1024, 'fixture is too small to cross a chunk boundary')

	const all = readAll()
	// three entries per turn, all present, in order, exactly once
	assert.equal(all.length, turns * 3, `expected ${turns * 3} entries, got ${all.length}`)
	for (let i = 0; i < turns; i++) {
		assert.match(all[i * 3]!.text, new RegExp(`^question ${i}( |$)`), `turn ${i} question missing or out of order`)
		assert.match(all[i * 3 + 1]!.text, new RegExp(`^answer ${i}( |$)`), `turn ${i} answer missing or out of order`)
		assert.equal(all[i * 3 + 2]!.kind, 'tool')
	}
})

test('a half-written last line is skipped rather than throwing', () => {
	// The live session is appending while this reads, so the tail is routinely a
	// fragment of JSON.
	write(2)
	fs.appendFileSync(path.join(DIR, `${ID}.jsonl`), '{"type":"assistant","message":{"rol')
	const page = historyPage(ID)
	assert.ok(page, 'a torn final line took the whole page down')
	assert.equal(page.entries.at(-1)!.kind, 'tool')
})

test('a session with no transcript on disk is null, not an empty conversation', () => {
	// These are different answers and the view says different things about them:
	// nothing to show, versus a session whose history this machine does not have.
	assert.equal(historyPage('cccccccc-9999-8888-7777-dddddddddddd'), null)
})

test('a cursor past the end of the file is clamped rather than read off the end', () => {
	write(2)
	const page = historyPage(ID, 1 << 30)
	assert.ok(page)
	assert.ok(page.entries.length > 0, 'an over-large cursor returned nothing')
})

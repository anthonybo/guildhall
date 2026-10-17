/**
 * Which file a terminal picture is, and what is never handed out as one.
 *
 * The route serves a file off this machine, so the rules are the point: an image this
 * session itself read, found by bare name, and nothing else.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set before the import that reads it, as history.test.ts does.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-shown-'))
process.env.HOME = HOME

const { shownImage } = await import('./shown.ts')

const ID = 'cccccccc-1111-2222-3333-dddddddddddd'
const DIR = path.join(HOME, '.claude', 'projects', '-tmp-guildhall-fixture-shown')
const FILES = path.join(HOME, 'TEST-ONLY-files')
fs.mkdirSync(DIR, { recursive: true })
fs.mkdirSync(FILES, { recursive: true })

const read = (file: string) =>
	JSON.stringify({
		type: 'assistant',
		timestamp: '2026-10-17T00:00:00.000Z',
		message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] },
	})

test('an image this session read is found by its name, and the newest read wins', () => {
	const older = path.join(FILES, 'old')
	const newer = path.join(FILES, 'new')
	fs.mkdirSync(older)
	fs.mkdirSync(newer)
	fs.writeFileSync(path.join(older, 'wolf.png'), 'TEST-ONLY')
	fs.writeFileSync(path.join(newer, 'wolf.png'), 'TEST-ONLY')
	fs.writeFileSync(path.join(DIR, `${ID}.jsonl`), [read(path.join(older, 'wolf.png')), read(path.join(newer, 'wolf.png'))].join('\n') + '\n')
	assert.deepEqual(shownImage(ID, 'wolf.png'), { file: path.join(newer, 'wolf.png'), type: 'image/png' })
})

test('anything but a bare image name this session read is refused', () => {
	const notes = path.join(FILES, 'notes.md')
	const unread = path.join(FILES, 'unread.png')
	fs.writeFileSync(notes, 'TEST-ONLY')
	fs.writeFileSync(unread, 'TEST-ONLY')
	fs.writeFileSync(path.join(DIR, `${ID}.jsonl`), [read(notes), read(path.join(FILES, 'gone.png'))].join('\n') + '\n')
	// A file that exists but was never read here, a read file of another type, a read
	// image that has since been deleted, and anything shaped like a path.
	for (const name of ['unread.png', 'notes.md', 'gone.png', `../${path.basename(FILES)}/unread.png`, unread, '.png', '']) {
		assert.equal(shownImage(ID, name), null, `${JSON.stringify(name)} was handed out`)
	}
	assert.equal(shownImage('no-such-session', 'wolf.png'), null)
})

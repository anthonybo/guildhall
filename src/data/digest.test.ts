import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest } from './digest.ts'

/** A transcript holding just the tool calls a test cares about. */
function transcript(calls: { name: string; input: Record<string, unknown> }[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-digest-'))
	const file = path.join(dir, 'session.jsonl')
	fs.writeFileSync(
		file,
		calls.map((c) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: c.name, input: c.input }] } })).join('\n') + '\n',
	)
	return file
}

const read = (p: string) => ({ name: 'Read', input: { file_path: p } })
const edit = (p: string) => ({ name: 'Edit', input: { file_path: p, old_string: 'a', new_string: 'b' } })

test('where a session writes is kept apart from everything it looks at', () => {
	// The failure this exists for, measured on a real session: it was building
	// `harbor` while reading `saltmarsh` for reference, and the reading outvoted the
	// work — 53 minutes labelled `saltmarsh` while every file it wrote went to
	// harbor. Counting all tool inputs equally is what did it.
	const f = transcript([
		...Array.from({ length: 9 }, () => read('/Users/x/projects/saltmarsh/src/api.ts')),
		edit('/Users/x/projects/harbor/src/app.tsx'),
		edit('/Users/x/projects/harbor/src/menu.tsx'),
	])
	const d = digest(f)
	assert.equal(d.subProj, 'saltmarsh', 'the raw vote still reflects everything touched')
	assert.equal(d.writeProj, 'harbor', 'but the project being WRITTEN must be its own answer')
})

test('a session that only reads has no write target, and is not renamed by one', () => {
	// Research sessions write nothing. They must fall back to the old behaviour
	// rather than get an empty name.
	const d = digest(transcript([read('/Users/x/projects/saltmarsh/README.md'), read('/Users/x/projects/willow/main.go')]))
	assert.equal(d.writeProj, undefined)
	assert.ok(d.subProj, 'reading still names it something')
})

test('the write target follows the newest work, not the loudest', () => {
	// One edit in the right place beats a pile of reads in the wrong one, which is
	// the whole point: a single file written somewhere is a stronger statement about
	// where the work is than twenty files opened.
	const d = digest(transcript([...Array.from({ length: 20 }, () => read('/Users/x/projects/willow/x.go')), edit('/Users/x/projects/kestrel/y.ts')]))
	assert.equal(d.writeProj, 'kestrel')
})

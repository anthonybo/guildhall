import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-projects-'))
process.env.GUILDHALL_PROJECTS = ROOT

import { createProject, spawnAllowed } from './projects.ts'
import { trustNew, uuidOfRef } from '../control.ts'

test('a new project is a fresh git repo under the root, and then allowed to spawn', () => {
	const r = createProject('TEST-ONLY-idea')
	assert.ok(r.ok, JSON.stringify(r))
	assert.equal(r.dir, path.join(ROOT, 'TEST-ONLY-idea'))
	assert.ok(fs.existsSync(path.join(r.dir, '.git')))
	assert.ok(spawnAllowed(r.dir))
})

test('a name can never become a path somewhere else, or reuse existing work', () => {
	for (const bad of ['..', '../escape', 'a/b', '.hidden', '/etc', 'a..b', '', 'x'.repeat(65), 'has space', '~']) {
		assert.equal(createProject(bad).ok, false, `accepted ${JSON.stringify(bad)}`)
	}
	assert.equal(fs.existsSync(path.join(ROOT, '..', 'escape')), false)
	fs.mkdirSync(path.join(ROOT, 'TEST-ONLY-existing'))
	fs.writeFileSync(path.join(ROOT, 'TEST-ONLY-existing', 'work.txt'), 'mine')
	const again = createProject('TEST-ONLY-existing')
	assert.equal(again.ok, false)
	assert.match(again.ok ? '' : again.error, /already exists/)
})

const WS = '11111111-2222-3333-4444-555555555555'
const ASK = (caret: 'no' | 'yes') =>
	`Quick safety check: Is this a project you created or one you trust?\n ${caret === 'no' ? '❯' : ' '} No, exit\n ${caret === 'yes' ? '❯' : ' '} Yes, I trust this folder\n`
const READY = '────────────────────────\n❯ \n────────────────────────\n'

/** A fake session whose screen moves the caret when ▼ is pressed. */
function fake(start: string[], moves = true) {
	const pressed: string[] = []
	let caret: 'no' | 'yes' = 'no'
	const screens = [...start]
	const io = {
		read: async () => {
			const s = screens.length > 1 ? screens.shift()! : screens[0]
			return { ok: true as const, text: s === 'ASK' ? ASK(caret) : s }
		},
		press: async (_: unknown, k: string) => {
			pressed.push(k)
			if (k === 'down' && moves) caret = 'yes'
			return { ok: true as const, text: '' }
		},
		wait: async () => {},
	}
	return { io, pressed }
}

test('the trust prompt of a new folder is answered yes: ▼ then Enter', async () => {
	const { io, pressed } = fake(['', '', 'ASK'])
	assert.equal(await trustNew(WS, io), true)
	assert.deepEqual(pressed, ['down', 'enter'])
})

test('Enter is never pressed unless the caret is on the yes — Enter on "No, exit" kills the session', async () => {
	const { io, pressed } = fake(['ASK'], false)
	assert.equal(await trustNew(WS, io), false)
	assert.deepEqual(pressed, ['down'])
})

test('a session that comes up ready is left alone', async () => {
	const { io, pressed } = fake(['', READY])
	assert.equal(await trustNew(WS, io), false)
	assert.deepEqual(pressed, [])
})

test('a target that is not a workspace UUID is refused before anything is read', async () => {
	const { io, pressed } = fake(['ASK'])
	assert.equal(await trustNew('', io), false)
	assert.deepEqual(pressed, [])
})

test('a new tab is found even though cmux lists it a second after saying it made it', async () => {
	const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
	let calls = 0
	const list = async () => {
		calls++
		// Measured: absent for 0.7-1.2s after `workspace create` returns.
		const rows = calls < 5 ? [] : [{ ref: 'workspace:7', id }]
		return { ok: true as const, text: JSON.stringify({ workspaces: rows }) }
	}
	assert.equal(await uuidOfRef('workspace:7', list, async () => {}), id)
	assert.equal(calls, 5)
	const never = async () => ({ ok: true as const, text: '{"workspaces":[]}' })
	assert.equal(await uuidOfRef('workspace:7', never, async () => {}), null)
})

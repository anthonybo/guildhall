/**
 * Finding the slash commands a session will take.
 *
 * The failure that matters is offering one that does not exist, or naming it wrongly:
 * the whole point is that the name leaving the phone is right, because Claude Code's own
 * autocomplete cannot correct it — guildhall sends the line and its carriage return in
 * one call, so the TUI never sees the keystrokes.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-commands-'))
process.env.GUILDHALL_HOME = HOME

const { commands } = await import('./commands.ts')

const PROJ = path.join(HOME, 'work', 'orchard')

function skill(name: string, front: string) {
	const dir = path.join(HOME, '.claude', 'skills', name)
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'SKILL.md'), front)
}

beforeEach(() => {
	fs.rmSync(path.join(HOME, '.claude'), { recursive: true, force: true })
	fs.rmSync(PROJ, { recursive: true, force: true })
})

test('a skill is named by its front matter, and described from it', () => {
	skill('impeccable', '---\nname: impeccable\ndescription: Design work, with a point of view.\n---\n\nbody\n')
	const [c] = commands()
	assert.equal(c!.name, 'impeccable')
	assert.equal(c!.description, 'Design work, with a point of view.')
	assert.equal(c!.scope, 'skill')
})

test('a skill with no front matter still gets its folder name', () => {
	// Better to offer a command with no description than to lose it: the name is the
	// part that has to be right.
	skill('web-perf', '# no front matter here\n')
	assert.deepEqual(
		commands().map((c) => c.name),
		['web-perf'],
	)
	assert.equal(commands()[0]!.description, '')
})

test('a directory without a SKILL.md is not a command', () => {
	fs.mkdirSync(path.join(HOME, '.claude', 'skills', 'not-a-skill', 'scripts'), { recursive: true })
	assert.deepEqual(commands(), [])
})

test("a project's own commands are offered, and only inside that project", () => {
	fs.mkdirSync(path.join(PROJ, '.claude', 'commands'), { recursive: true })
	fs.writeFileSync(path.join(PROJ, '.claude', 'commands', 'ship.md'), '---\ndescription: Cut a release.\n---\n')
	assert.deepEqual(
		commands(PROJ).map((c) => `${c.name}:${c.scope}`),
		['ship:project'],
	)
	// Somewhere else, it is not on offer — it would not run there.
	assert.deepEqual(commands('/tmp/guildhall-fixture/elsewhere'), [])
	assert.deepEqual(commands(), [])
})

test('a project command shadows a user command of the same name', () => {
	// Because the project one is what would actually run. Offering the other would name
	// a description that does not match the behaviour.
	fs.mkdirSync(path.join(HOME, '.claude', 'commands'), { recursive: true })
	fs.writeFileSync(path.join(HOME, '.claude', 'commands', 'ship.md'), '---\ndescription: the user one\n---\n')
	fs.mkdirSync(path.join(PROJ, '.claude', 'commands'), { recursive: true })
	fs.writeFileSync(path.join(PROJ, '.claude', 'commands', 'ship.md'), '---\ndescription: the project one\n---\n')
	const hits = commands(PROJ).filter((c) => c.name === 'ship')
	assert.equal(hits.length, 1, 'the same command was offered twice')
	assert.equal(hits[0]!.description, 'the project one')
	assert.equal(hits[0]!.scope, 'project')
})

test('anything that is not a .md file is ignored', () => {
	fs.mkdirSync(path.join(HOME, '.claude', 'commands'), { recursive: true })
	for (const f of ['real.md', 'README.txt', '.DS_Store', 'notes']) fs.writeFileSync(path.join(HOME, '.claude', 'commands', f), 'x')
	assert.deepEqual(
		commands().map((c) => c.name),
		['real'],
	)
})

test('the list is sorted, so the same command is in the same place every time', () => {
	for (const n of ['zebra', 'alpha', 'mango']) skill(n, `---\nname: ${n}\n---\n`)
	assert.deepEqual(
		commands().map((c) => c.name),
		['alpha', 'mango', 'zebra'],
	)
})

test('missing directories are an empty list, not a crash', () => {
	// A machine with no skills and no commands is normal, and the picker has to open
	// on it and say so rather than failing.
	assert.deepEqual(commands('/tmp/guildhall-fixture/nowhere'), [])
})

test('a quoted description is unquoted, and a long one is cut', () => {
	skill('long', `---\nname: long\ndescription: "${'x'.repeat(400)}"\n---\n`)
	const [c] = commands()
	assert.ok(!c!.description.startsWith('"'), 'the quotes were kept')
	assert.ok(c!.description.length <= 160, `description was ${c!.description.length} characters`)
})

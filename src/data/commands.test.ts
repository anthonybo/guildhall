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

/** An installed, enabled plugin, laid out the way a real one is. */
function plugin(key: string, at: string, skillName?: string, cmds: string[] = []) {
	const root = path.join(HOME, at)
	if (skillName) {
		fs.mkdirSync(path.join(root, 'skills', skillName), { recursive: true })
		fs.writeFileSync(path.join(root, 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: from a plugin\n---\n`)
	}
	for (const c of cmds) {
		fs.mkdirSync(path.dirname(path.join(root, 'commands', c)), { recursive: true })
		fs.writeFileSync(path.join(root, 'commands', c), '---\ndescription: a plugin command\n---\n')
	}
	fs.mkdirSync(path.join(HOME, '.claude', 'plugins'), { recursive: true })
	const settings = path.join(HOME, '.claude', 'settings.json')
	const now = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {}
	now.enabledPlugins = { ...(now.enabledPlugins ?? {}), [key]: true }
	fs.writeFileSync(settings, JSON.stringify(now))
	const reg = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json')
	const have = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, 'utf8')) : { version: 2, plugins: {} }
	have.plugins[key] = [{ scope: 'user', installPath: root }]
	fs.writeFileSync(reg, JSON.stringify(have))
}

test('a skill from an enabled plugin is offered', () => {
	// This is the whole report: `/frontend-design` is a plugin skill and was missing
	// entirely, because only ~/.claude/skills was being read.
	plugin('frontend-design@official', 'installed/frontend-design', 'frontend-design')
	const hit = commands().find((c) => c.name === 'frontend-design')
	assert.ok(hit, 'a plugin skill was not offered')
	assert.equal(hit.scope, 'plugin')
	assert.equal(hit.description, 'from a plugin')
})

test('a plugin that is NOT enabled is not offered', () => {
	// ~/.claude/plugins/marketplaces is a catalog of everything on offer. Listing it
	// would put commands in the picker that are not installed and will not run — the
	// same rule as a project's commands only counting inside that project.
	plugin('on@official', 'installed/on', 'yes-please')
	// present on disk, absent from settings
	const off = path.join(HOME, 'installed/off')
	fs.mkdirSync(path.join(off, 'skills', 'not-enabled'), { recursive: true })
	fs.writeFileSync(path.join(off, 'skills', 'not-enabled', 'SKILL.md'), '---\nname: not-enabled\n---\n')
	const names = commands().map((c) => c.name)
	assert.ok(names.includes('yes-please'))
	assert.ok(!names.includes('not-enabled'), 'a disabled plugin was offered')
})

test('a plugin turned off in settings is dropped even though it is installed', () => {
	plugin('half@official', 'installed/half', 'half-on')
	const settings = path.join(HOME, '.claude', 'settings.json')
	const j = JSON.parse(fs.readFileSync(settings, 'utf8'))
	j.enabledPlugins['half@official'] = false
	fs.writeFileSync(settings, JSON.stringify(j))
	assert.ok(!commands().some((c) => c.name === 'half-on'), 'a plugin set to false was still offered')
})

test('commands in subdirectories are namespaced rather than lost', () => {
	// A folder is a namespace — `commands/frontend/audit.md` is `/frontend:audit`. A flat
	// read silently dropped every command anybody had organised.
	fs.mkdirSync(path.join(HOME, '.claude', 'commands', 'frontend'), { recursive: true })
	fs.writeFileSync(path.join(HOME, '.claude', 'commands', 'frontend', 'audit.md'), '---\ndescription: nested\n---\n')
	fs.writeFileSync(path.join(HOME, '.claude', 'commands', 'flat.md'), '---\ndescription: top level\n---\n')
	assert.deepEqual(
		commands().map((c) => c.name),
		['flat', 'frontend:audit'],
	)
})

test('a plugin missing from the install record is still found in the cache', () => {
	// The registry and the cache can disagree; the cache layout is the fallback, so an
	// enabled plugin is not dropped just because the bookkeeping is behind.
	fs.mkdirSync(path.join(HOME, '.claude', 'plugins', 'cache', 'mkt', 'cached', 'skills', 'from-cache'), { recursive: true })
	fs.writeFileSync(path.join(HOME, '.claude', 'plugins', 'cache', 'mkt', 'cached', 'skills', 'from-cache', 'SKILL.md'), '---\nname: from-cache\n---\n')
	fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
	fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'cached@mkt': true } }))
	assert.ok(
		commands().some((c) => c.name === 'from-cache'),
		'an enabled plugin absent from the install record was dropped',
	)
})

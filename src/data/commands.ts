/**
 * The slash commands a session will accept, so they can be picked instead of spelled.
 *
 * Typing `/impeccable` on a phone is the problem this solves. Claude Code's own
 * autocomplete cannot help through guildhall: a message is sent as one line followed by
 * a carriage return in a single call, so the TUI never sees the keystrokes that would
 * open its menu. The name has to be right before it leaves the phone — and it usually
 * is not, because these names are long and a phone keyboard is unkind to them. Reported
 * as "impossible to really add slash commands", with the name misspelled twice in the
 * report itself.
 *
 * So the list is read from the same places Claude Code reads it from, and offered.
 *
 * Read on demand, never on the poll path: this is reached when somebody opens the
 * picker, which is a deliberate act a few times a day, and the directories are small.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Command = {
	/** Without the slash. `impeccable`, not `/impeccable`. */
	name: string
	description: string
	/** Where it came from, so the picker can group and say so. */
	scope: 'skill' | 'user' | 'project' | 'plugin' | 'built-in'
}

/**
 * Claude Code's own commands, which are not files and cannot be discovered.
 *
 * Everything else here is read from disk. These are compiled into the CLI — a 333MB
 * Mach-O binary — and are not recoverable from it: `status`, `clear` and `compact`
 * appear at dozens of unrelated offsets in its strings while `pr-comments` and
 * `migrate-installer` do not appear at all, so anything scraped would be part guesswork
 * and part omission. That is worse than a written list, because it would look automatic.
 *
 * So this IS a hand-kept list and will drift when Claude Code changes. It is kept short
 * and to the ones that are both long-standing and worth having from a phone — where the
 * cost of a stale entry is Claude Code answering "unknown command", not a wrong action.
 * `/quit` and `/login` are deliberately absent: ending or reauthenticating a session you
 * are not sitting at is not a thing to make one tap away.
 */
const BUILT_IN: [string, string][] = [
	['clear', 'Clear the conversation and free the context window'],
	['compact', 'Summarize the conversation so far and keep going'],
	['context', 'Show what is filling the context window'],
	['cost', 'What this session has cost so far'],
	['usage', 'Plan usage and limits'],
	['model', 'Switch the model for this session'],
	['status', 'Version, account, model and connectivity'],
	['resume', 'Pick up an earlier conversation'],
	['agents', 'Manage subagents'],
	['memory', 'Edit the memory files this project loads'],
	['review', 'Review a pull request'],
	['todos', 'The current to-do list'],
	['export', 'Export this conversation'],
	['init', 'Write a CLAUDE.md for this project'],
	['mcp', 'MCP server status and tools'],
	['permissions', 'What this session is allowed to do'],
	['config', 'Settings for this session'],
	['doctor', 'Check the installation'],
	['help', 'What the commands are'],
]

/** Enough for any real setup, and a ceiling on what a directory of junk can cost. */
const MAX = 200
/** A description is a hint in a list, not documentation. */
const DESC = 160

const home = () => process.env.GUILDHALL_HOME || os.homedir()

/**
 * `name:` and `description:` out of a markdown front matter block.
 *
 * Deliberately not a YAML parser. The front matter here is two flat keys and pulling in
 * a parser to read them would be the largest dependency in the project. A key it does
 * not understand is skipped, which costs a description and never a command.
 */
function frontMatter(file: string): { name?: string; description?: string } {
	let text: string
	try {
		// These files run to thousands of lines; the front matter is in the first few.
		const fd = fs.openSync(file, 'r')
		try {
			const buf = Buffer.alloc(4096)
			const n = fs.readSync(fd, buf, 0, 4096, 0)
			text = buf.subarray(0, n).toString('utf8')
		} finally {
			fs.closeSync(fd)
		}
	} catch {
		return {}
	}
	if (!text.startsWith('---')) return {}
	const end = text.indexOf('\n---', 3)
	const block = end === -1 ? text : text.slice(0, end)
	const out: { name?: string; description?: string } = {}
	for (const line of block.split('\n')) {
		const m = /^(name|description):\s*(.*)$/.exec(line)
		if (!m) continue
		const value = m[2]!.trim().replace(/^["']|["']$/g, '')
		if (m[1] === 'name') out.name = value
		else out.description = value
	}
	return out
}

/**
 * Every `*.md` under a commands directory, INCLUDING subdirectories.
 *
 * A folder is a namespace: `commands/frontend/audit.md` is `/frontend:audit`, and a flat
 * read misses every command anybody has organised. The first version read one level and
 * reported a dozen where there were far more.
 */
function commandsIn(dir: string, scope: 'user' | 'project' | 'plugin', prefix = '', depth = 0): Command[] {
	// Deep enough for any real arrangement, and a stop on a directory loop.
	if (depth > 3) return []
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const out: Command[] = []
	for (const e of entries) {
		const full = path.join(dir, e.name)
		if (e.isDirectory()) {
			out.push(...commandsIn(full, scope, `${prefix}${e.name}:`, depth + 1))
			continue
		}
		if (!e.name.endsWith('.md')) continue
		const fm = frontMatter(full)
		out.push({ name: `${prefix}${e.name.slice(0, -3)}`, description: (fm.description ?? '').slice(0, DESC), scope })
	}
	return out
}

/**
 * The plugins actually turned on, and where they are installed.
 *
 * A marketplace is a CATALOG — `~/.claude/plugins/marketplaces` holds every plugin on
 * offer, and listing those would put commands in the picker that are not installed and
 * will not run. `settings.json` says which are enabled and `installed_plugins.json` says
 * where each one landed, so both are consulted rather than the directory being trusted.
 */
function enabledPlugins(h: string): string[] {
	let enabled: Record<string, unknown> = {}
	try {
		enabled = (JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
	} catch {
		return []
	}
	let installed: Record<string, { installPath?: string }[]> = {}
	try {
		installed = (JSON.parse(fs.readFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: typeof installed }).plugins ?? {}
	} catch {
		installed = {}
	}
	const roots: string[] = []
	for (const [key, on] of Object.entries(enabled)) {
		if (!on) continue
		const where = installed[key]?.find((i) => i.installPath)?.installPath
		if (where && fs.existsSync(where)) {
			roots.push(where)
			continue
		}
		// Not in the install record: fall back to the cache laid out as
		// cache/<marketplace>/<plugin>, which is where an install puts it.
		const [name, market] = key.split('@')
		if (!name || !market) continue
		const guess = path.join(h, '.claude', 'plugins', 'cache', market, name)
		if (fs.existsSync(guess)) roots.push(guess)
	}
	return roots
}

/** Every skill directory holding a SKILL.md, named by its front matter or its folder. */
function skills(dir: string, scope: 'skill' | 'plugin' = 'skill'): Command[] {
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const out: Command[] = []
	for (const e of entries) {
		if (!e.isDirectory()) continue
		const file = path.join(dir, e.name, 'SKILL.md')
		if (!fs.existsSync(file)) continue
		const fm = frontMatter(file)
		out.push({ name: fm.name || e.name, description: (fm.description ?? '').slice(0, DESC), scope })
	}
	return out
}

/**
 * What this session can be sent, most specific first.
 *
 * `cwd` is the session's directory, because a project's own commands are only available
 * inside it — offering another project's would be offering something that will not run.
 */
export function commands(cwd?: string): Command[] {
	const h = home()
	const plugins = enabledPlugins(h)
	const all: Command[] = [
		...(cwd ? commandsIn(path.join(cwd, '.claude', 'commands'), 'project') : []),
		...commandsIn(path.join(h, '.claude', 'commands'), 'user'),
		...skills(path.join(h, '.claude', 'skills')),
		// An installed plugin lays its skills and commands out the same way a project
		// does, one level down. `frontend-design` lives here and was missing entirely.
		...plugins.flatMap((root) => [...skills(path.join(root, 'skills'), 'plugin'), ...commandsIn(path.join(root, 'commands'), 'plugin')]),
		// Last, so anything on disk with the same name wins: a command somebody wrote is
		// the one that would actually run.
		...BUILT_IN.map(([name, description]): Command => ({ name, description, scope: 'built-in' })),
	]
	// First definition of a name wins, which is why project comes first: it is the one
	// that would actually run.
	const seen = new Set<string>()
	const out: Command[] = []
	for (const c of all) {
		if (!c.name || seen.has(c.name)) continue
		seen.add(c.name)
		out.push(c)
		if (out.length >= MAX) break
	}
	return out.sort((a, b) => a.name.localeCompare(b.name))
}

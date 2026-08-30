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
	scope: 'skill' | 'user' | 'project'
}

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

/** Every `*.md` in a commands directory, named by its file. */
function commandsIn(dir: string, scope: 'user' | 'project'): Command[] {
	let names: string[]
	try {
		names = fs.readdirSync(dir)
	} catch {
		return []
	}
	const out: Command[] = []
	for (const file of names) {
		if (!file.endsWith('.md')) continue
		const fm = frontMatter(path.join(dir, file))
		out.push({ name: file.slice(0, -3), description: (fm.description ?? '').slice(0, DESC), scope })
	}
	return out
}

/** Every skill directory holding a SKILL.md, named by its front matter or its folder. */
function skills(dir: string): Command[] {
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
		out.push({ name: fm.name || e.name, description: (fm.description ?? '').slice(0, DESC), scope: 'skill' })
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
	const all = [
		...(cwd ? commandsIn(path.join(cwd, '.claude', 'commands'), 'project') : []),
		...commandsIn(path.join(h, '.claude', 'commands'), 'user'),
		...skills(path.join(h, '.claude', 'skills')),
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

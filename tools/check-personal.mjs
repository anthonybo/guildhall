#!/usr/bin/env node
/**
 * Refuse to commit anything personal to whoever is committing.
 *
 * This is a public repository that is developed against private work, so the
 * material at hand while writing it — project names, spend, home directories, the
 * contents of a real session — is exactly the material most likely to end up in a
 * comment, a test fixture, or a commit message. It did: dollar figures in two
 * commit messages, eight private project names across sixty places in the source,
 * and 222MB of build output carrying an absolute path.
 *
 * **The word list is not in this file, and must never be.** A checked-in list of
 * somebody's private project names is the leak it was written to prevent. Instead:
 *
 *  - names are DERIVED from the machine — the sibling directories of this
 *    checkout, which on a normal setup is exactly the set of things being worked
 *    on — minus this project and anything in the allowlist
 *  - the allowlist lives OUTSIDE the repo, at
 *    ~/.config/guildhall/public-words, one word per line, for names that are
 *    genuinely public (this project, its siblings that are also published)
 *  - the patterns below are generic: money, home paths, tokens
 *
 * So the check is silent on a fresh clone with no siblings, strict on the machine
 * where the private material actually exists, and never itself contains a secret.
 *
 * `allow-personal: <why>` on the line exempts it, and the reason is required, so
 * an exemption is a decision rather than a habit. Same convention as
 * check-secrets and check-spelling.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** Words that are fine to publish, read from outside the repo. */
function publicWords() {
	const own = path.basename(root)
	const file = path.join(process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall'), 'public-words')
	let listed = []
	try {
		listed = fs.readFileSync(file, 'utf8').split('\n')
	} catch {}
	return new Set(
		[own, ...listed]
			.map((w) => w.trim().toLowerCase())
			.filter((w) => w && !w.startsWith('#')),
	)
}

/**
 * The names of things being worked on next to this one.
 *
 * Directories beside the checkout. Short ones are dropped — a two or three letter
 * directory matches ordinary words and would make this cry wolf, which is how a
 * check gets turned off.
 */
function privateNames() {
	const allowed = publicWords()
	let siblings = []
	try {
		siblings = fs.readdirSync(path.dirname(root), { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
			.map((e) => e.name)
	} catch {}
	return siblings.filter((n) => n.length >= 5 && !allowed.has(n.toLowerCase()))
}

/** Generic shapes that are personal wherever they appear. */
const PATTERNS = [
	// A spend figure. `$0` and `$20` are fine — a price in prose — but cents are
	// what an account statement looks like.
	{ what: 'a dollar amount with cents', re: /\$\s?\d[\d,]*\.\d{2}\b/ },
	// Somebody's home directory. The placeholder the plists ship is the exception.
	// Obvious placeholders are not anybody's home directory. `/Users/x` in a test
	// fixture names nobody; the point is to catch a real account name.
	{ what: 'a home directory path', re: /\/Users\/(?!(CHANGEME|x|you|user|USER|me|someone|somebody-else)\b)[A-Za-z0-9._-]+/ },
	{ what: 'a usage percentage tied to an account', re: /\b(session|weekly)\s*\(?\d*h?\)?\s*[:—-]?\s*\d{1,3}%\s*used/i },
]

const staged = () => {
	try {
		return execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], { encoding: 'utf8', cwd: root })
	} catch {
		return ''
	}
}

const found = []
let file = ''
// Only ADDED lines, so an old file that already contains something questionable
// does not block unrelated work — the same rule check-secrets uses.
for (const line of staged().split('\n')) {
	if (line.startsWith('+++ b/')) file = line.slice(6)
	if (!line.startsWith('+') || line.startsWith('+++')) continue
	const text = line.slice(1)
	if (/allow-personal:\s*\S/.test(text)) continue
	for (const p of PATTERNS) {
		const m = p.re.exec(text)
		if (m) found.push({ file, what: p.what, hit: m[0], text })
	}
	for (const name of privateNames()) {
		if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
			found.push({ file, what: `the name of a project beside this one`, hit: name, text })
		}
	}
}

// The commit message too, which is where the dollar figures actually went. Only
// the patterns — a message may legitimately discuss a sibling project by name in
// a way a source comment should not.
const msgFile = process.argv[2]
if (msgFile && fs.existsSync(msgFile)) {
	for (const line of fs.readFileSync(msgFile, 'utf8').split('\n')) {
		if (line.startsWith('#') || /allow-personal:\s*\S/.test(line)) continue
		for (const p of PATTERNS) {
			const m = p.re.exec(line)
			if (m) found.push({ file: 'the commit message', what: p.what, hit: m[0], text: line })
		}
	}
}

if (!found.length) {
	console.log('personal: nothing of yours in the diff')
	process.exit(0)
}

console.error('Personal details in what you are about to commit:\n')
for (const f of found) {
	console.error(`  ${f.file}  ${f.what}: ${f.hit}`)
	console.error(`    ${f.text.trim().slice(0, 100)}`)
}
console.error(`\n${found.length} to fix. If one is genuinely fine to publish, either add the word to`)
console.error('~/.config/guildhall/public-words, or put `allow-personal: <why>` on the line.')
process.exit(1)

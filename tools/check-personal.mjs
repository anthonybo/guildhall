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
	// Cents were required, so a per-day figure with no cents — one of which was
	// sitting in a doc — sailed through. Three digits or more is a bill, not a
	// price in prose.
	{ what: 'a dollar amount that looks like a bill', re: /\$\s?\d{3,}(\.\d{2})?\b|\$\s?\d[\d,]*\.\d{2}\b/ },
	// The old version demanded the literal word "used", which one phrasing happens
	// to use and a bare percentage next to "context" does not.
	{ what: 'a usage figure tied to an account', re: /\d{1,3}\s*%\s*(used|context|of (the )?(quota|plan|window))|\b(quota|weekly|session)\b[^.\n]{0,20}\d{1,3}\s*%/i },
	// A tailnet address identifies a machine on the owner's network. 100.64/10 is
	// CGNAT, which on a laptop means Tailscale.
	{ what: 'a Tailscale address', re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
	{ what: 'an email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
	{ what: 'a tailnet or local hostname', re: /\b[A-Za-z0-9-]+\.(ts\.net|local)\b/ },
	// A tty and a pid are both copied off a real machine when they appear in prose.
	{ what: 'a tty from a real machine', re: /\bttys\d{3}\b/ },
	{ what: 'a pid from a real run', re: /\bpid \d{3,}\b/i },
]

/**
 * Paths that must never be committed, whatever is in them.
 *
 * The largest of the four leaks this gate exists for was 222MB of build output,
 * and no pattern would ever have found it: the check reads a text diff, and a
 * compiled binary has no added lines to read.
 */
const FORBIDDEN_PATHS = /(^|\/)(node_modules|dist|target|\.build|[^/]+\.app)(\/|$)/
/** A tracked blob this big is almost always something generated. */
const BIG = 1024 * 1024

const staged = () => {
	try {
		return execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], { encoding: 'utf8', cwd: root })
	} catch {
		return ''
	}
}

// Derived ONCE. This was called inside the per-line loop, so it did a readdirSync
// of the parent directory and rebuilt forty regexes for every added line — a
// release staging a regenerated bundle would have done that thousands of times.
const NAMES = privateNames().map((n) => ({
	name: n,
	// Leading boundary only for longer names, so `nameApp` and `name_v2` are caught
	// too. A trailing boundary let a glued form through.
	re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${n.length >= 6 ? '' : '\\b'}`, 'i'),
}))

const found = []
let file = ''
const msgFile = process.argv[2]
// Only ADDED lines, so an old file that already contains something questionable
// does not block unrelated work — the same rule check-secrets uses.
for (const line of (msgFile ? '' : staged()).split('\n')) {
	if (line.startsWith('+++ b/')) file = line.slice(6)
	if (!line.startsWith('+') || line.startsWith('+++')) continue
	const text = line.slice(1)
	if (/allow-personal:\s*\S/.test(text)) continue
	for (const p of PATTERNS) {
		const m = p.re.exec(text)
		if (m) found.push({ file, what: p.what, hit: m[0], text })
	}
	for (const n of NAMES) {
		if (n.re.test(text)) found.push({ file, what: 'the name of a project beside this one', hit: n.name, text })
	}
}

// The commit message, which is where the spend actually leaked.
//
// Names are checked here too. They were deliberately NOT, on the argument that a
// message may legitimately discuss a sibling project — and the very next commit
// after this gate landed put a private project name in its message. The exemption
// is what the legitimate case is for.
if (msgFile && fs.existsSync(msgFile)) {
	for (const line of fs.readFileSync(msgFile, 'utf8').split('\n')) {
		if (line.startsWith('#') || /allow-personal:\s*\S/.test(line)) continue
		for (const p of PATTERNS) {
			const m = p.re.exec(line)
			if (m) found.push({ file: 'the commit message', what: p.what, hit: m[0], text: line })
		}
		for (const n of NAMES) {
			if (n.re.test(line)) found.push({ file: 'the commit message', what: 'the name of a project beside this one', hit: n.name, text: line })
		}
	}
}

// Staged paths, checked as paths rather than as content.
if (!msgFile) {
	let names = []
	try {
		names = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8', cwd: root })
			.split('\n').filter(Boolean)
	} catch {}
	for (const name of names) {
		if (FORBIDDEN_PATHS.test(name)) {
			found.push({ file: name, what: 'a generated path that must not be committed', hit: name, text: '' })
			continue
		}
		let size = 0
		try {
			size = fs.statSync(path.join(root, name)).size
		} catch {}
		if (size > BIG) {
			found.push({ file: name, what: `a ${Math.round(size / 1024 / 1024)}MB file, which is almost certainly generated`, hit: name, text: '' })
		}
	}
	// A binary diff has no lines to scan, so nothing above can see inside it. The
	// screenshot that showed which other apps are installed was exactly this case.
	// Not an error — a prompt to have looked.
	const binaries = staged().split('\n').filter((l) => l.startsWith('Binary files')).length
	if (binaries) {
		console.log(`personal: ${binaries} binary file(s) staged — nothing here can see inside them, so look before you commit`)
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

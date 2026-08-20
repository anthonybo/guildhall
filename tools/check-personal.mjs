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
	// NO tilde form. `~/.config/guildhall` is the PORTABLE way to write a path and
	// contains no account name at all — it is what the fix looks like, not the leak.
	// Matching it flagged the documentation, and `~10s` and `~1042ms` besides, which
	// is the cry-wolf this project has written down as how a check gets deleted.
	// Only an absolute path spells somebody's account out.
	{ what: 'a home directory path', re: /\/(Users|home)\/(?!(CHANGEME|x|you|user|me|someone|somebody-else)\b)[A-Za-z0-9._-]{2,}/i },
	// The account name on its own, wherever it appears — a path is only one way to
	// spell it. Skipped on a copyright line and in this repository's own URL, which
	// are the two places it belongs.
	{
		what: 'this account name',
		re: new RegExp(`\\b${os.userInfo().username}\\b`, 'i'),
		unless: /copyright|github\.com\/|githubusercontent|Co-Authored-By/i,
	},
	// Cents were required, so a per-day figure with no cents — one of which was
	// sitting in a doc — sailed through. Three digits or more is a bill, not a
	// price in prose.
	{ what: 'a dollar amount that looks like a bill', re: /\$\s?\d{3,}(\.\d{2})?\b|\$\s?\d[\d,]*\.\d{2}\b/ },
	// The old version demanded the literal word "used", which one phrasing happens
	// to use and a bare percentage next to "context" does not.
	{ what: 'a usage figure tied to an account', re: /\d{1,3}\s*%\s*(used|context|of (the )?(quota|plan|window))|\b(quota|weekly|session)\b[^.\n]{0,20}\d{1,3}\s*%/i },
	// A tailnet address identifies a machine on the owner's network. 100.64/10 is
	// CGNAT, which on a laptop means Tailscale.
	{
		what: 'a Tailscale address',
		re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
		// `100.64.0.0/10` is the range's NAME, which the code has to say out loud to
		// explain what it is checking, and a fixture at a boundary names no machine.
		// Bare `range` used to be in here. Once `unless` started applying to the
		// staged diff as well as to --all, a word that general would have exempted any
		// line mentioning a range of anything — including a range of costs. The
		// notation itself (`/10`) and the words that only appear when describing the
		// block rather than using an address are enough.
		unless: /\/10\b|CGNAT|boundar|fixture|synthetic|address (block|range)/i,
	},
	{ what: 'an email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
	// The hostname check is appended below, once the machine's own names are known.
	// A pid is only interesting when it was copied off a real machine; an obvious
	// placeholder is the fix, not the leak.
	{ what: 'a pid from a real run', re: /\bpid (?!1234\b)\d{3,}\b/i, replaces: 'pid' },
	// A tty and a pid are both copied off a real machine when they appear in prose.
	{ what: 'a tty from a real machine', re: /\bttys\d{3}\b/ },
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

/**
 * The staged diff.
 *
 * `maxBuffer` explicitly, and NO try/catch swallowing the failure.
 *
 * Without it Node's 1MiB default applied, `execFileSync` threw ENOBUFS, the catch
 * returned an empty string, and this printed "nothing of yours in the diff" and
 * exited 0 — indistinguishable from a clean pass. Measured: the same file flagged
 * three findings in a 261-byte diff and zero in a 1.27MB one.
 *
 * That is the incident exactly. The 222MB of build output would have produced a
 * diff far over the limit, so the check that should have objected was guaranteed to
 * be the one that went silent. check-secrets.mjs already passes 64MB; this did not.
 */
const staged = () => {
	try {
		return execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
			encoding: 'utf8',
			cwd: root,
			maxBuffer: 64 << 20,
		})
	} catch (e) {
		console.error(`check-personal could not read the staged diff: ${e.message}`)
		console.error('Refusing to pass. A check that cannot look must not report clean.')
		process.exit(1)
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

/**
 * Hostnames, but only the ones that name THIS machine.
 *
 * The first version matched any `<label>.local` or `<label>.ts.net`. That flagged
 * `willow.local`, which is an invented hostname in a doc comment and a test
 * fixture, and the fix was four `allow-personal` notes wedged into prose — one of
 * them a `//` inside a JSDoc block. Exemptions scattered through documentation to
 * quiet a check are how a check gets deleted.
 *
 * What actually leaks is a REAL machine's name, so that is what this matches: the
 * labels this machine answers to, plus the private project names, since a tailnet
 * host is usually named after one. An invented name passes; `my-laptop.local`
 * does not.
 */
function hostCheck() {
	const labels = new Set()
	for (const n of NAMES) labels.add(n.name.toLowerCase())
	// os.hostname() is `name.local` or `name` depending on the network, and
	// LocalHostName is the Bonjour name, which is the one that appears in a URL.
	let names = [os.hostname()]
	try {
		names.push(execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }))
		names.push(execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }))
	} catch {
		// not macOS, or scutil unavailable — os.hostname() still applies
	}
	for (const raw of names) {
		const label = String(raw).trim().split('.')[0].toLowerCase()
		// A generic label matches half the words in the file. `localhost` and
		// `mac` are not identifying, and treating them as such is the cry-wolf
		// failure again.
		if (label.length >= 4 && !/^(mac|host|local|localhost|computer|macbook|imac)$/.test(label)) labels.add(label)
	}
	if (!labels.size) return null
	const alt = [...labels].map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
	return { what: "this machine's hostname", re: new RegExp(`\\b(${alt})\\.(ts\\.net|local)\\b`, 'i') }
}
const HOST = hostCheck()
if (HOST) PATTERNS.push(HOST)

const found = []
let file = ''
const args = process.argv.slice(2)
/**
 * `--all` scans everything, not the diff.
 *
 * The diff-only design has a hole the size of the repository: three real leaks sat
 * in the tree and in 15 to 24 commits of unpushed history while this printed
 * "nothing of yours" — because they were added before it existed, so they are in no
 * staged diff. It is also why its slot in `npm run check` protected nothing: at
 * release time the index is empty and an empty diff is a clean pass.
 *
 * This mode is what a pre-push hook wants, since a push transmits history rather
 * than a diff.
 */
const ALL = args.includes('--all')
const RANGE = (args.find((a) => a.startsWith('--range=')) || '').slice(8)
const msgFile = args.find((a) => !a.startsWith('--'))
// Only ADDED lines, so an old file that already contains something questionable
// does not block unrelated work — the same rule check-secrets uses.
for (const line of (msgFile ? '' : staged()).split('\n')) {
	// `+++ ` with the space: adding a line whose text starts with `++` produces
	// `+++foo`, which the old test discarded as a header.
	if (line.startsWith('+++ b/')) {
		file = line.slice(6)
		// The PATH is content too. Skipping the header threw away the only place a
		// filename appears, so a filename carrying an account name passed with clean contents.
		for (const p of PATTERNS) {
			const m = p.re.exec(file)
			if (m) found.push({ file, what: `${p.what}, in the FILENAME`, hit: m[0], text: file })
		}
		for (const n of NAMES) {
			if (n.re.test(file)) found.push({ file, what: 'a project name in the FILENAME', hit: n.name, text: file })
		}
		continue
	}
	if (!line.startsWith('+') || line.startsWith('+++ ')) continue
	const text = line.slice(1)
	if (/allow-personal:\s*\S/.test(text)) continue
	for (const p of PATTERNS) {
		// `unless` applies HERE too. It was honored only in --all mode, so a pattern
		// that had already reasoned about its own false positive still blocked the
		// commit that introduced the line — this file's own comment naming the
		// `100.64.0.0/10` range was refused by the check it documents. An escape
		// valve the common path ignores is not an escape valve.
		if (p.unless?.test(text)) continue
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
			if (p.unless?.test(line)) continue
			const m = p.re.exec(line)
			if (m) found.push({ file: 'the commit message', what: p.what, hit: m[0], text: line })
		}
		for (const n of NAMES) {
			if (n.re.test(line)) found.push({ file: 'the commit message', what: 'the name of a project beside this one', hit: n.name, text: line })
		}
	}
}

// Everything currently tracked, plus every message in the range about to be
// pushed. Only in --all mode; the per-commit path stays a diff scan so it stays
// fast enough to sit in front of every commit.
if (ALL) {
	const out = (cmd, a) => {
		try {
			return execFileSync(cmd, a, { encoding: 'utf8', cwd: root, maxBuffer: 256 << 20 })
		} catch (e) {
			console.error(`check-personal could not run ${cmd}: ${e.message}`)
			process.exit(1)
		}
	}
	// Binary files are not text, and reading one as UTF-8 produces byte noise that
	// matches almost anything — three "home directory paths" came out of a sprite
	// sheet. The PATH is still checked below.
	const BINARY = /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|otf|zip|gz|mov|mp4|pdf|icns)$/i
	for (const name of out('git', ['ls-files']).split('\n').filter(Boolean)) {
		if (BINARY.test(name)) continue
		let body = ''
		try {
			body = fs.readFileSync(path.join(root, name), 'utf8')
		} catch {
			continue // binary or unreadable; the path itself is still checked below
		}
		const lines = body.split('\n')
		for (const [i, text] of lines.entries()) {
			if (/allow-personal:\s*\S/.test(text)) continue
			for (const p of PATTERNS) {
				if (p.unless?.test(text)) continue
				for (const m of text.matchAll(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g'))) {
					found.push({ file: `${name}:${i + 1}`, what: p.what, hit: m[0], text })
				}
			}
			for (const n of NAMES) {
				if (n.re.test(text)) found.push({ file: `${name}:${i + 1}`, what: 'the name of a project beside this one', hit: n.name, text })
			}
		}
		for (const p of PATTERNS) {
			const m = p.re.exec(name)
			if (m) found.push({ file: name, what: `${p.what}, in the FILENAME`, hit: m[0], text: name })
		}
	}
	// Messages in the range, which is where a cherry-pick, a revert or a
	// filter-branch puts text that no commit-msg hook ever saw.
	//
	// RANGE is split, because git wants each revision as its own argument and a new
	// branch needs three (`<sha> --not --remotes=origin`). Passed as one string it
	// became a single unparseable revision.
	const revs = RANGE.split(/\s+/).filter(Boolean)
	if (revs.length) {
		for (const line of out('git', ['log', '--format=%B', ...revs]).split('\n')) {
			if (/allow-personal:\s*\S/.test(line)) continue
			for (const p of PATTERNS) {
				if (p.unless?.test(line)) continue
				const m = p.re.exec(line)
				if (m) found.push({ file: `a commit message in ${RANGE}`, what: p.what, hit: m[0], text: line })
			}
			for (const n of NAMES) {
				if (n.re.test(line)) found.push({ file: `a commit message in ${RANGE}`, what: 'a project name', hit: n.name, text: line })
			}
		}

		// And the CONTENT of every object in the range, which is the hole this check
		// had until it was measured.
		//
		// Scanning the tracked tree plus the range's MESSAGES reads two things and
		// misses the third: what earlier commits in the range contain. Twelve private
		// project names and two spend figures were fixed at the tip as an ordinary
		// commit, so 23 of 25 commits still carried the originals — and `git push`
		// sends all of them. This check printed "nothing of yours in the tree or the
		// range" over exactly that, because neither thing it read was where the
		// material was.
		//
		// Deduplicated by blob, so a file unchanged across 20 commits is read once.
		const seen = new Set()
		const objects = out('git', ['rev-list', '--objects', ...revs]).split('\n')
		for (const entry of objects) {
			const sp = entry.indexOf(' ')
			if (sp < 0) continue // a commit, which has no path
			const sha = entry.slice(0, sp)
			const name = entry.slice(sp + 1)
			if (!name || seen.has(sha)) continue
			seen.add(sha)
			for (const p of PATTERNS) {
				const m = p.re.exec(name)
				if (m) found.push({ file: `${name} in ${RANGE}`, what: `${p.what}, in a HISTORICAL filename`, hit: m[0], text: name })
			}
			for (const n of NAMES) {
				if (n.re.test(name)) found.push({ file: `${name} in ${RANGE}`, what: 'a project name in a HISTORICAL filename', hit: n.name, text: name })
			}
			if (BINARY.test(name)) continue
			let body = ''
			try {
				body = execFileSync('git', ['cat-file', '-p', sha], { encoding: 'utf8', cwd: root, maxBuffer: 256 << 20 })
			} catch {
				continue // a tree, a submodule, or too big to read as text
			}
			// One report per blob per pattern. A generated bundle can hold the same
			// name in 400 places, and 400 identical lines is a wall nobody reads.
			for (const [i, text] of body.split('\n').entries()) {
				if (/allow-personal:\s*\S/.test(text)) continue
				for (const p of PATTERNS) {
					if (p.unless?.test(text)) continue
					const m = p.re.exec(text)
					if (m) found.push({ file: `${name}:${i + 1} in history`, what: p.what, hit: m[0], text })
				}
				for (const n of NAMES) {
					if (n.re.test(text)) found.push({ file: `${name}:${i + 1} in history`, what: 'a project name', hit: n.name, text })
				}
			}
		}
	}
}

// Staged paths, checked as paths rather than as content.
if (!msgFile && !ALL) {
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
	if (names.length > 400) {
		found.push({ file: `${names.length} staged files`, what: 'more files than a hand-made change has', hit: `${names.length}`, text: '' })
	}
	const binaries = staged().split('\n').filter((l) => l.startsWith('Binary files')).length
	if (binaries) {
		console.log(`personal: ${binaries} binary file(s) staged — nothing here can see inside them, so look before you commit`)
	}
}

if (!found.length) {
	console.log(ALL ? 'personal: nothing of yours in the tree or the range' : 'personal: nothing of yours in the diff')
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

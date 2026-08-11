#!/usr/bin/env node
/**
 * Refuse to commit a credential.
 *
 * This exists because of a genuinely alarming hour. A throwaway script overwrote
 * the live control password with a string that a test file already contained, and
 * because that test string was in the repository, the question "is my password on
 * GitHub" became a reasonable one to ask. It was not — the real password is an
 * scrypt hash in ~/.config, outside the repo, and no code path can put it there —
 * but nobody should have to take that on trust twice.
 *
 * So: scan what is being committed, not the whole tree. Only ADDED lines, so a file
 * that already contains something questionable does not block unrelated work, and
 * so the check gets faster as the repo grows rather than slower.
 *
 * Deliberately narrow. This repo's comments discuss passwords constantly, so prose
 * is never matched — only an assignment to a literal, or a format that can only be
 * a credential. A noisy secret scanner gets disabled, and a disabled scanner is
 * worth nothing.
 *
 *   node tools/check-secrets.mjs            scan staged changes
 *   node tools/check-secrets.mjs --all      scan every tracked file
 */
import { execFileSync } from 'node:child_process'

const all = process.argv.includes('--all')

/** A line saying `allow-secret: <reason>` is let through, with the reason on it. */
const PRAGMA = /allow-secret:/

/**
 * Filenames that are credentials whatever is inside them. guildhall keeps these in
 * ~/.config, outside the repo — so one appearing in a commit means something has
 * gone wrong, not that the contents happen to look safe.
 */
const FILENAMES = [/(^|\/)control-pass$/, /(^|\/)passcode$/, /(^|\/)session\.key$/, /(^|\/)\.env(\.|$)/, /(^|\/)id_(rsa|ed25519)$/, /\.pem$/, /\.p12$/]

const RULES = [
	{ name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	// guildhall's own stored format. If this ever appears in a diff, a real
	// credential file has been pasted or committed.
	{ name: 'scrypt password hash', re: /scrypt\$\d+\$[0-9a-f]{16,}\$[0-9a-f]{32,}/ },
	{ name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/ },
	{ name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
	{ name: 'Cloudflare/bearer token', re: /\b(bearer|authorization)\s*[:=]\s*['"`][A-Za-z0-9._\-]{24,}['"`]/i },
	/**
	 * A secret-shaped name assigned a string literal.
	 *
	 * The word boundary and the `[:=]` are what keep this off the prose: this repo
	 * has hundreds of comment lines about passwords and none of them assign one.
	 * Six characters minimum, so `pass = ''` and `token: 'x'` placeholders are fine.
	 */
	{ name: 'credential assigned to a literal', re: /\b(pass|passwd|password|passphrase|secret|apikey|api_key|access_token|auth_token)\b\s*[:=]\s*['"`][^'"`\n]{6,}['"`]/i },
]

function addedLines() {
	if (all) {
		const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
		const out = []
		for (const f of files) {
			let text
			try {
				text = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
			} catch {
				continue
			}
			text.split('\n').forEach((line, i) => out.push({ file: f, line: i + 1, text: line }))
		}
		return out
	}
	// -U0 so only the changed lines arrive, with hunk headers to keep line numbers.
	const diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { encoding: 'utf8', maxBuffer: 64 << 20 })
	const out = []
	let file = ''
	let line = 0
	for (const raw of diff.split('\n')) {
		if (raw.startsWith('+++ b/')) {
			file = raw.slice(6)
			continue
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
		if (hunk) {
			line = Number(hunk[1])
			continue
		}
		if (raw.startsWith('+') && !raw.startsWith('+++')) {
			out.push({ file, line, text: raw.slice(1) })
			line++
		}
	}
	return out
}

const staged = all ? [] : execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).split('\n').filter(Boolean)

const hits = []
for (const f of staged) {
	const rule = FILENAMES.find((re) => re.test(f))
	if (rule) hits.push({ file: f, line: 0, name: 'credential file', text: f })
}
for (const { file, line, text } of addedLines()) {
	if (PRAGMA.test(text)) continue
	for (const r of RULES) {
		if (!r.re.test(text)) continue
		hits.push({ file, line, name: r.name, text: text.trim().slice(0, 100) })
		break
	}
}

if (!hits.length) {
	console.log(`secrets: clean${all ? ' (whole tree)' : ''}`)
	process.exit(0)
}

console.error('\nsecrets: refusing to commit\n')
for (const h of hits) console.error(`  ${h.file}${h.line ? `:${h.line}` : ''}\n    ${h.name} — ${h.text}\n`)
console.error(`If it is genuinely not a credential, put \`allow-secret: <why>\` on the line.`)
console.error(`If it is one, take it out of the commit. Real secrets belong in ~/.config, never in this repo.\n`)
process.exit(1)

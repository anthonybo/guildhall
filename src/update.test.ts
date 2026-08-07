import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test in this file writes settings, so it must never touch the real ones.
// It used to: the suite reset the passcode in ~/.config/guildhall on every run,
// which looked like a chosen code refusing to stick. Set before any import that
// reads it — the modules resolve the directory per call, not at load.
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-test-'))


import { available, check, compare, newestTag } from './update.ts'

const cache = () => path.join(process.env.GUILDHALL_CONFIG_DIR!, 'update.json')
const seed = (latest: string, ageMs: number) => fs.writeFileSync(cache(), JSON.stringify({ at: Date.now() - ageMs, latest }))

test('versions compare by number, not by string', () => {
	// "0.2.10" < "0.2.9" alphabetically, which is the classic way to miss an update
	assert.equal(compare('0.2.9', '0.2.10'), -1)
	assert.equal(compare('0.2.10', '0.2.9'), 1)
	assert.equal(compare('0.3.0', '0.2.99'), 1)
	assert.equal(compare('1.0.0', '1.0.0'), 0)
	assert.equal(compare('1.0', '1.0.0'), 0, 'a missing part should count as zero')
})

test('the newest tag wins, however git ordered them', () => {
	const out = [
		'abc123\trefs/tags/v0.2.9',
		'def456\trefs/tags/v0.2.10',
		'aaa111\trefs/tags/v0.1.0',
		'bbb222\trefs/tags/not-a-version',
	].join('\n')
	assert.equal(newestTag(out), '0.2.10')
})

test('nothing to report is a valid answer', () => {
	// offline, no remote, or no tags at all — all the same, and none of them are
	// worth interrupting someone over
	assert.equal(newestTag(''), '')
	assert.equal(newestTag('abc\trefs/heads/main'), '')
})

test('a cached answer is reported even once it has gone stale', async () => {
	// The regression: the cache both answered and suppressed the lookup, and only
	// answered while fresh. So a day-old cache reported nothing AND skipped the
	// network, and in a repo that ships several versions an afternoon the arrow
	// never appeared at all. Staleness may gate the lookup; it must not gate the
	// answer, because "something newer exists" does not stop being true.
	seed('99.0.0', 26 * 60 * 60 * 1000)
	const latest = await new Promise<string | null>((resolve) => {
		check((v) => resolve(v), '/nonexistent-so-the-network-half-cannot-answer')
		setTimeout(() => resolve(null), 2000)
	})
	assert.equal(latest, '99.0.0', 'a stale cache holding a newer version was not reported')
	assert.equal(available(), '99.0.0')
})

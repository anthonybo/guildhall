/**
 * The ledgers on disk.
 *
 * Speed is the reason this exists — a menu bar poll went from ~8.5 cpu-s to ~0.27 — but
 * speed is worthless if the totals drift, because every session's level is computed from
 * them and a wrong one would never be noticed. So almost everything here asserts that a
 * process resuming from the cache arrives at EXACTLY what a full parse arrives at, in the
 * cases where a cache could plausibly lie.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-ledgers-'))
process.env.GUILDHALL_CACHE_DIR = path.join(DIR, 'cache')
const { advance, persistLedgers, resetLedgers } = await import('./transcript.ts')
const { cacheFile, loadLedgers } = await import('./ledgercache.ts')

const FILE = path.join(DIR, 'TEST-ONLY-session.jsonl')
const edit = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/TEST-ONLY/x.ts' } }] } })
const work = (ms: number) => JSON.stringify({ type: 'system', durationMs: ms, note: 'TEST-ONLY padding to pass the length prefilter' })

/** A fresh process: nothing in memory, and the cache not yet read. */
const freshProcess = () => resetLedgers()
/** Save as a short-lived run would — the throttle starts at zero for it. */
const save = () => persistLedgers(Date.now() + 10 * 60_000)
/** The totals a full parse gives, with no cache at all. */
function fullParse() {
	const keep = fs.existsSync(cacheFile()) ? fs.readFileSync(cacheFile()) : null
	fs.rmSync(cacheFile(), { force: true })
	freshProcess()
	const { commits, edits, activeMs } = advance(FILE)
	if (keep) fs.writeFileSync(cacheFile(), keep)
	freshProcess()
	return { commits, edits, activeMs }
}
const totals = (L: { commits: number; edits: number; activeMs: number }) => ({ commits: L.commits, edits: L.edits, activeMs: L.activeMs })

beforeEach(() => {
	fs.rmSync(path.join(DIR, 'cache'), { recursive: true, force: true })
	fs.rmSync(FILE, { force: true })
	freshProcess()
})

test('a fresh process resumes from the cache and agrees with a full parse', () => {
	fs.writeFileSync(FILE, `${[edit, work(1000), edit].join('\n')}\n`)
	advance(FILE)
	assert.ok(save(), 'nothing was written')

	// More work arrives; a NEW process reads only what was appended.
	fs.appendFileSync(FILE, `${[work(500), edit].join('\n')}\n`)
	freshProcess()
	const resumed = totals(advance(FILE))
	assert.deepEqual(resumed, fullParse(), 'resuming from the cache disagrees with reading the whole file')
	assert.deepEqual(resumed, { commits: 0, edits: 3, activeMs: 1500 })
})

test('a resumed process does not read what the cache already covers', () => {
	// The point of the whole thing. Overwrite the covered bytes with garbage of the same
	// length: a process that honours the cache never looks at them, so its totals are
	// unchanged; one that re-read from zero would lose the edits.
	fs.writeFileSync(FILE, `${[edit, edit].join('\n')}\n`)
	advance(FILE)
	save()
	const covered = fs.statSync(FILE).size
	const fd = fs.openSync(FILE, 'r+')
	fs.writeSync(fd, Buffer.alloc(covered - 1, 0x78), 0, covered - 1, 0)
	fs.closeSync(fd)
	freshProcess()
	assert.equal(advance(FILE).edits, 2, 'the cache was ignored and the file re-read from byte zero')
})

test('a partial last line is counted once, when it completes — not twice, not never', () => {
	// The fragment is deliberately not stored. If it were, and also re-read, it would count
	// twice; if the offset were stored past it, it would never count.
	fs.writeFileSync(FILE, `${edit}\n${edit.slice(0, 30)}`)
	advance(FILE)
	save()
	fs.appendFileSync(FILE, `${edit.slice(30)}\n`)
	freshProcess()
	assert.equal(advance(FILE).edits, 2, 'the line split across the save was miscounted')
})

test('the stored offset is always a line boundary', () => {
	fs.writeFileSync(FILE, `${edit}\n${work(1)}\n${edit.slice(0, 25)}`)
	advance(FILE)
	save()
	const stored = loadLedgers().get(FILE)
	assert.ok(stored, 'no entry stored')
	const bytes = fs.readFileSync(FILE)
	assert.equal(bytes[stored.off - 1], 0x0a, `offset ${stored.off} is not just past a newline`)
})

test('a transcript replaced by a LONGER one is not added to its predecessor', () => {
	// The check that only became necessary once ledgers outlive a process. "Shorter than
	// where we stopped" catches a truncation and misses a replacement that happens to be
	// bigger — whose counts would then be added to a stranger's.
	fs.writeFileSync(FILE, `${[edit, edit, edit].join('\n')}\n`)
	advance(FILE)
	save()
	fs.rmSync(FILE)
	fs.writeFileSync(FILE, `${[work(10), work(10), work(10), work(10), work(10)].join('\n')}\n`)
	freshProcess()
	const after = totals(advance(FILE))
	assert.deepEqual(after, { commits: 0, edits: 0, activeMs: 50 }, `a replacement inherited its predecessor: ${JSON.stringify(after)}`)
})

test('a transcript that got shorter starts over', () => {
	fs.writeFileSync(FILE, `${[edit, edit, edit].join('\n')}\n`)
	advance(FILE)
	save()
	fs.truncateSync(FILE, 0)
	fs.appendFileSync(FILE, `${edit}\n`)
	freshProcess()
	assert.equal(advance(FILE).edits, 1)
})

test('a corrupt cache is ignored rather than trusted', () => {
	// A hand-edited or half-written cache must never inject an offset that skips bytes.
	fs.writeFileSync(FILE, `${[edit, edit].join('\n')}\n`)
	fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
	for (const junk of ['not json', JSON.stringify({ v: 1, ledgers: { [FILE]: { ino: 1, off: -5, commits: 0, edits: 0, activeMs: 0 } } }), JSON.stringify({ v: 99, ledgers: {} })]) {
		fs.writeFileSync(cacheFile(), junk)
		freshProcess()
		assert.equal(advance(FILE).edits, 2, `a bad cache changed the totals: ${junk.slice(0, 40)}`)
	}
})

test('the cache is private to this user', () => {
	// It lists the paths of every transcript, which name every project.
	fs.writeFileSync(FILE, `${edit}\n`)
	advance(FILE)
	save()
	assert.equal(fs.statSync(cacheFile()).mode & 0o077, 0, 'the cache is readable by other users')
})

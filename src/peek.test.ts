/**
 * Rationing the reads, which is the whole job.
 *
 * A glance costs a cmux process — 0.08 cpu-s, measured, the same whether it returns 1KB
 * or 58KB. Seven desks on a two-second timer is a third of a core continuously, the cost
 * CLAUDE.md apologises for. So what most of these assert is not what comes back; it is
 * HOW MANY TIMES cmux is asked, and whether an idle session costs anything at all.
 *
 * Several exist because a review found the bug first and no test could have caught it.
 * Each of those says so.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { type Reader, clean, glance, keepOnly, peekSize, resetPeek, whenQuiet } from './peek.ts'

const WS = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444'

let calls = 0
let answer: (ws: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
const reader: Reader = (ws) => {
	calls++
	return answer(ws)
}

beforeEach(() => {
	resetPeek()
	calls = 0
	answer = async () => ({ ok: true, text: 'one\ntwo\n' })
})

/** Ask, wait for the refresh the synchronous call started, then ask again. */
async function settle(ws: string, token: string, now: number, read: Reader = reader) {
	glance(ws, token, now, read)
	await whenQuiet()
	return glance(ws, token, now, read)
}

test('the first look is empty and starts a read; the next has the lines', async () => {
	const first = glance(WS, 't1', 1000, reader)
	assert.deepEqual(first.lines, [], 'it should not block for the first read')
	assert.equal(first.reading, true)
	await whenQuiet()
	const then = glance(WS, 't1', 1000, reader)
	assert.deepEqual(then.lines, ['one', 'two'])
	assert.equal(then.reading, false)
	assert.equal(calls, 1)
})

test('an idle session costs nothing at all', async () => {
	// The whole reason the token exists. Same token, any number of frames, no process.
	await settle(WS, 'size:900', 1000)
	assert.equal(calls, 1)
	for (let i = 0; i < 200; i++) glance(WS, 'size:900', 1000 + i, reader)
	await whenQuiet()
	assert.equal(calls, 1, `an idle desk cost ${calls - 1} extra reads`)
})

test('a session that moved is read again', async () => {
	await settle(WS, 'size:900', 1000)
	await settle(WS, 'size:1200', 1100)
	assert.equal(calls, 2)
})

test('a long backstop covers what the token cannot see', async () => {
	// A bash run streams output without the transcript growing, so the token sits still
	// while the screen moves.
	await settle(WS, 'same', 1000)
	glance(WS, 'same', 1000 + 29_000, reader)
	await whenQuiet()
	assert.equal(calls, 1, 'read again before the backstop')
	glance(WS, 'same', 1000 + 31_000, reader)
	await whenQuiet()
	assert.equal(calls, 2, 'the backstop never fired')
})

test('frames during a read do not start another one', async () => {
	// The pile-up this file claims cannot happen: a slow cmux and sixty frames a second.
	let release = (_: { ok: true; text: string }) => {}
	answer = () => new Promise((r) => (release = r))
	glance(WS, 't', 1000, reader)
	for (let i = 0; i < 50; i++) glance(WS, 't', 1000 + i, reader)
	assert.equal(calls, 1, `${calls} reads were started for one workspace`)
	release({ ok: true, text: 'done\n' })
	await whenQuiet()
	assert.deepEqual(glance(WS, 't', 1000, reader).lines, ['done'])
})

test('a reader that REJECTS does not poison the workspace forever', async () => {
	// Found by review, and nothing could have caught it: the rejected promise was left in
	// place, so every later call got the same rejection and the session never recovered
	// short of a restart. runCmux does not reject today — this is the seam, not the
	// shipped path.
	answer = async () => {
		throw new Error('boom')
	}
	glance(WS, 't1', 1000, reader)
	await whenQuiet()
	const bad = glance(WS, 't1', 1000, reader)
	assert.match(bad.error ?? '', /boom/)
	assert.deepEqual(bad.lines, [], 'a failure with nothing cached should be empty')
	// and it recovers once cmux does
	answer = async () => ({ ok: true, text: 'back\n' })
	const after = await settle(WS, 't2', 1000 + 31_000)
	assert.deepEqual(after.lines, ['back'], 'the workspace never recovered')
	assert.equal(after.error, undefined)
})

test('a failure keeps the last good text rather than blanking the desk', async () => {
	await settle(WS, 't1', 1000)
	answer = async () => ({ ok: false, error: 'cmux is busy' })
	const after = await settle(WS, 't2', 2000)
	assert.deepEqual(after.lines, ['one', 'two'], 'a failed read wiped the desk')
	assert.match(after.error ?? '', /busy/)
})

test('a failure backs off instead of asking again every frame', async () => {
	// usage.ts says this in bold: no backoff is what got its calls rate-limited. An
	// unreachable cmux would otherwise be asked once per frame, forever.
	answer = async () => ({ ok: false, error: 'no cmux here' })
	await settle(WS, 't1', 1000)
	assert.equal(calls, 1)
	for (let i = 0; i < 100; i++) glance(WS, `t${i}`, 1000 + i * 100, reader)
	await whenQuiet()
	assert.equal(calls, 1, `a broken cmux was asked ${calls} times inside the backoff`)
	glance(WS, 'later', 1000 + 31_000, reader)
	await whenQuiet()
	assert.equal(calls, 2, 'it never tried again after the backoff')
})

test('a read landing after the entry was dropped does not resurrect it', async () => {
	// Found by review. keepOnly did not actually bound the map while reads were out.
	let release = (_: { ok: true; text: string }) => {}
	answer = () => new Promise((r) => (release = r))
	glance(WS, 't', 1000, reader)
	resetPeek()
	assert.equal(peekSize(), 0)
	release({ ok: true, text: 'ghost\n' })
	await whenQuiet()
	assert.equal(peekSize(), 0, 'a landing read resurrected a dropped workspace')

	resetPeek()
	glance(OTHER, 't', 1000, reader)
	keepOnly([])
	release({ ok: true, text: 'ghost\n' })
	await whenQuiet()
	assert.equal(peekSize(), 0, 'keepOnly does not bound the map while a read is out')
})

test('the caller cannot corrupt the cache through the array it is handed', async () => {
	// Found by review: the cached array was returned by reference, so one caller's pop()
	// changed what every other desk saw.
	await settle(WS, 't', 1000)
	const mine = glance(WS, 't', 1000, reader)
	mine.lines.push('INJECTED')
	mine.lines.reverse()
	assert.deepEqual(glance(WS, 't', 1000, reader).lines, ['one', 'two'], 'the cache was mutated from outside')
})

test('a junk workspace id is refused without minting an entry or a process', () => {
	const r = glance('not-a-uuid', 't', 1000, reader)
	assert.equal(r.error, 'not a workspace id')
	assert.equal(calls, 0, 'a process was started for a junk id')
	assert.equal(peekSize(), 0, 'a junk id grew the map')
})

test('workspaces that leave the room are forgotten', async () => {
	await settle(WS, 't', 1000)
	await settle(OTHER, 't', 1000)
	assert.equal(peekSize(), 2)
	keepOnly([WS])
	assert.equal(peekSize(), 1)
	keepOnly([])
	assert.equal(peekSize(), 0)
})

test('clean strips the furniture and keeps at most a glance', () => {
	// This was untested: removing the length cap left every test passing.
	assert.deepEqual(clean('a\n\n\n'), ['a'], 'trailing blanks kept')
	assert.deepEqual(clean('────────\nreal\n'), ['real'], 'a box rule survived')
	assert.deepEqual(clean('  ⎿  indented\n'), ['indented'], 'the gutter survived')
	assert.deepEqual(clean('a     b\n'), ['a  b'], 'a run of spaces survived')
	const many = clean(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'))
	assert.equal(many.length, 14, `kept ${many.length} lines`)
	assert.equal(many.at(-1), 'line 59', 'it kept the wrong end — the newest lines matter')
})

test('two workspaces are read separately and do not share state', async () => {
	answer = async (ws) => ({ ok: true, text: ws === WS ? 'mine\n' : 'theirs\n' })
	await settle(WS, 't', 1000)
	await settle(OTHER, 't', 1000)
	assert.deepEqual(glance(WS, 't', 1000, reader).lines, ['mine'])
	assert.deepEqual(glance(OTHER, 't', 1000, reader).lines, ['theirs'])
	assert.equal(calls, 2)
})

test('the status block is not what a small display gets spent on', () => {
	// It is the least informative part of the screen, every value in it is already in the
	// table, and it carries the day's spend — which this project's own rule says must not
	// leave the machine, and the room gets rendered into committed images.
	const screen = ['I have finished the audit and pushed it.', '', '❯', 'Opus 5 1M - ├ guildhall · main', '930k/1M ● ● ● ● ● Today $0 5hr ██░░░░', 'Weekly ████████░░ 84.0% 1hr 37m', '▶▶ auto mode on (shift+tab to cycle)'].join('\n')
	const out = clean(screen)
	assert.equal(out.at(-1), '❯', `kept the status block: ${JSON.stringify(out.slice(-3))}`)
	assert.ok(
		!out.some((l) => /Opus|Weekly|auto mode/.test(l)),
		'status chrome survived',
	)
	assert.ok(
		!out.some((l) => l.includes('$')),
		'a spend figure survived onto the wall',
	)
	assert.ok(out.includes('I have finished the audit and pushed it.'), 'it threw away the actual content')
})

test('a dollar sign mid-conversation is not mistaken for the status bar', () => {
	// Stripping only from the END is what makes the heuristic safe: content keeps its
	// characters, and the worst case is losing one trailing line.
	const out = clean(['it cost $4 to run', 'and then it finished'].join('\n'))
	assert.deepEqual(out, ['it cost $4 to run', 'and then it finished'])
})

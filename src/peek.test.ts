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
import { PEEK_LINES, type Reader, clean, glance, keepOnly, peekSize, resetPeek, whenQuiet } from './peek.ts'

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
	// Against the CONSTANT, not a literal: the cap moved from 14 to 40 when desk screens
	// started showing seven rows, and a hard-coded 14 here would have to be edited every
	// time rather than simply holding the rule that there IS a cap.
	const many = clean(Array.from({ length: PEEK_LINES + 40 }, (_, i) => `line ${i}`).join('\n'))
	assert.equal(many.length, PEEK_LINES, `kept ${many.length} lines`)
	assert.equal(many.at(-1), `line ${PEEK_LINES + 39}`, 'it kept the wrong end — the newest lines matter')
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
	assert.ok(
		!out.some((l) => /Opus|Weekly|auto mode/.test(l)),
		'status chrome survived',
	)
	assert.ok(
		!out.some((l) => l.includes('$')),
		'a spend figure survived onto the wall',
	)
	assert.deepEqual(out, ['I have finished the audit and pushed it.'], 'it threw away the actual content')
})

test('a bare prompt is dropped and a typed one is kept', () => {
	// Changed deliberately. An empty `❯` is a quarter of the board spent saying the
	// session has an input box; a message sitting there unsent is one of the few things
	// genuinely worth seeing from across a room.
	assert.deepEqual(clean('the answer is 4\n❯\n'), ['the answer is 4'], 'a bare prompt took a row')
	assert.deepEqual(clean('the answer is 4\n❯ and then this\n'), ['the answer is 4', '❯ and then this'], 'an unsent message was dropped')
})

test('the trailer above the prompt is not what gets shown', () => {
	// Measured on seven live sessions: five rendered as spinner / update notice / bare
	// prompt and NOTHING else, because the prompt boundary only strips downward. This is
	// one of those screens, verbatim.
	const screen = ['I read the file and the cause is the render order.', '', '✢ Pouncing… (18m 51s · ↓ 29.2k tokens)', '                              ✔ Update installed · Restart to update', '──────────────────────────────', '❯ ', '──────────────────────────────', '  Opus 5 1M - ├ guildhall · desk-screens    XHigh  Effort', '  100k/1M ● ○ ○ ○ ○   Today $0     5hr ██████░░░░ 59.0% 2hr 35m'].join('\n')
	const out = clean(screen)
	assert.deepEqual(out, ['I read the file and the cause is the render order.'], `drew the furniture: ${JSON.stringify(out)}`)
})

test('a screen with nothing but a spinner still shows the spinner', () => {
	// The trailer strip must not turn a just-started session into "nothing on screen yet",
	// which would read as broken rather than as busy.
	const out = clean('✢ Pouncing… (3s)\n❯\n')
	assert.deepEqual(out, ['✢ Pouncing… (3s)'])
})

test('the day spend cannot reach the wall even when the prompt is gone', () => {
	// The measured leak. With --lines 14 the prompt can be pushed out of the window
	// entirely, and the old fallback popped from the end and stopped at the first line
	// that matched nothing — a background-agent line sitting inside the status block.
	// `$0`, not the figure this was found with: the point is the SHAPE of the status line,
	// and a real spend in a fixture is the thing this test exists to stop leaving the
	// machine. check:personal refuses it, correctly.
	const screen = ['960k/1M ● ● ● ● ●  Today $0  5hr █████░░░░░ 51.0% 2hr 55m', '◯ general-purpose  Running … ↓ 122.3k tokens', 'Weekly █████████░ 89.0% 55m', '⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')
	const out = clean(screen)
	assert.ok(
		!out.some((l) => l.includes('$')),
		`a spend figure reached the wall: ${JSON.stringify(out)}`,
	)
	assert.ok(
		!out.some((l) => /122\.3k|Weekly|auto mode/.test(l)),
		`status chrome survived the fallback: ${JSON.stringify(out)}`,
	)
})

test('a quote is not mistaken for the prompt', () => {
	// `>` is a markdown blockquote, a diff marker and a Python REPL as well as a prompt.
	// Truncating at the LAST one anywhere in the window turned 14 lines into 1; the fix is
	// to look for it only near the bottom, where a prompt actually lives.
	const quoted = ['> the user asked for the monitors to show real terminals', 'so I measured what a desk can hold:', 'eight characters, in both renderers', 'which is why there is one board instead of seven', 'and it is drawn on the back wall'].join('\n')
	const out = clean(quoted)
	assert.equal(out.length, 5, `a quote truncated the screen to ${out.length} lines: ${JSON.stringify(out)}`)
	// A Python session, where the marker is the transcript itself.
	const repl = ['>>> len(rows)', '14', 'and the traceback below it', 'IndexError: list index out of range', 'so the cap was the bug'].join('\n')
	assert.equal(clean(repl).length, 5, 'a REPL transcript was truncated at its own prompt')
})

test('a dollar sign mid-conversation is not mistaken for the status bar', () => {
	// Stripping only from the END is what makes the heuristic safe: content keeps its
	// characters, and the worst case is losing one trailing line.
	const out = clean(['it cost $4 to run', 'and then it finished'].join('\n'))
	assert.deepEqual(out, ['it cost $4 to run', 'and then it finished'])
})

test('a rule with text on the end of it does not spend a line', () => {
	// Seen on the board in a live session: the glass is three lines and one of them was a
	// horizontal rule. The entirely-box-characters filter cannot catch this, because the
	// line is not entirely box characters.
	assert.deepEqual(clean('the real answer\n──────────────────────  waiting\n'), ['the real answer', 'waiting'])
	assert.deepEqual(clean('──────────────\nkept\n'), ['kept'], 'a plain rule survived')
	// and a blank line is a third of the display, so it goes as well
	assert.deepEqual(clean('one\n\ntwo\n'), ['one', 'two'])
})

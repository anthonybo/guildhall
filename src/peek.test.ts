/**
 * Rationing the reads, which is the whole job.
 *
 * A glance at a screen costs a cmux process — 0.08 cpu-s, measured, and the same whether
 * it returns 1KB or 58KB. Seven desks asking every two seconds is a third of a core
 * continuously, which is the cost this project has a written apology for. So what these
 * tests assert is not that the text comes back; it is HOW MANY TIMES cmux is asked.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { PEEK_LINES, type Reader, keepOnly, peek, peekSize, resetPeek } from './peek.ts'

const WS = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444'

let calls = 0
let answer: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>
/** Counts every read, which is the thing under test. */
const reader: Reader = async () => {
	calls++
	return answer()
}

beforeEach(() => {
	resetPeek()
	calls = 0
	answer = async () => ({ ok: true, text: 'one\ntwo\nthree\n' })
})

test('a glance returns the lines, trailing blanks trimmed', async () => {
	answer = async () => ({ ok: true, text: 'hello   \nworld\t\n\n\n' })
	assert.deepEqual(await peek(WS, Date.now(), reader), ['hello', 'world'])
	assert.equal(calls, 1)
})

test('a second glance inside the window costs nothing', async () => {
	const t = 1_000_000
	await peek(WS, t, reader)
	await peek(WS, t + 500, reader)
	await peek(WS, t + 1999, reader)
	assert.equal(calls, 1, `cmux was asked ${calls} times for one window`)
})

test('past the window it reads again', async () => {
	const t = 2_000_000
	await peek(WS, t, reader)
	await peek(WS, t + 2001, reader)
	assert.equal(calls, 2)
})

test('callers arriving together share one read', async () => {
	// The case that matters: seven desks and two browsers all want the same session at
	// the same moment. That is one spawn, not nine.
	let release = () => {}
	answer = () =>
		new Promise((r) => {
			release = () => r({ ok: true, text: 'shared\n' })
		})
	const all = Promise.all([peek(WS, 9e12, reader), peek(WS, 9e12, reader), peek(WS, 9e12, reader)])
	release()
	const [a, b, c] = await all
	assert.equal(calls, 1, `three callers caused ${calls} reads`)
	assert.deepEqual(a, ['shared'])
	assert.deepEqual(b, c)
})

test('different workspaces are read separately', async () => {
	await peek(WS, Date.now(), reader)
	await peek(OTHER, Date.now(), reader)
	assert.equal(calls, 2)
})

test('a failed read keeps the last good lines rather than blanking the desk', async () => {
	// A desk showing slightly old text is better than one that goes empty whenever cmux
	// is busy — the room is glanced at, not studied.
	const t = 3_000_000
	answer = async () => ({ ok: true, text: 'good\n' })
	assert.deepEqual(await peek(WS, t, reader), ['good'])
	answer = async () => ({ ok: false, error: 'cmux said no' })
	assert.deepEqual(await peek(WS, t + 3000, reader), ['good'], 'a failed read wiped the desk')
})

test('a failure with nothing cached is empty, not undefined', async () => {
	answer = async () => ({ ok: false, error: 'nope' })
	assert.deepEqual(await peek(WS, Date.now(), reader), [])
})

test('workspaces that leave the room are forgotten', async () => {
	// Or the map grows for the life of a program meant to run for days.
	await peek(WS, Date.now(), reader)
	await peek(OTHER, Date.now(), reader)
	assert.equal(peekSize(), 2)
	keepOnly([WS])
	assert.equal(peekSize(), 1)
	keepOnly([])
	assert.equal(peekSize(), 0)
})

test('it asks for a glance, not a screenful', async () => {
	// Reading 120 lines would be the terminal view's job and its cost.
	let asked = -1
	const spy: Reader = async (_ws, lines) => {
		asked = lines ?? -1
		return { ok: true as const, text: 'x\n' }
	}
	await peek(WS, Date.now(), spy)
	assert.equal(asked, PEEK_LINES)
	assert.ok(PEEK_LINES <= 20, 'a glance should stay small')
})

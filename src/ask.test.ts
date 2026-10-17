/**
 * How a message is typed into a session, against a fake terminal.
 *
 * The failure worth guarding is a message delivered TWICE, which was reported as "my
 * long logs get doubled up and stuck": the check could not see a long message in the
 * box, called it lost, and typed a second copy beside the first. These pin that a
 * send is never re-typed, and that Enter only goes into a prompt holding this text.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { type Io, ask, pieces } from './ask.ts'

const WS = '00000000-1111-2222-3333-444444444444'
const RULE = '─'.repeat(60)
const screen = (box: string[]) => ['  ⏺ earlier output', RULE, ...box, RULE, '  Opus 5  ⏵⏵ auto mode'].join('\n')

/** A terminal that answers each read with the next screen, and records every write. */
function fake(screens: string[]) {
	const writes: string[] = []
	let i = 0
	const io: Io = {
		input: async (_w, t) => (writes.push(t), { ok: true, text: '' }),
		read: async () => ({ ok: true, text: screens[Math.min(i++, screens.length - 1)] }),
		wait: async () => {},
	}
	return { io, writes, enters: () => writes.filter((w) => w === '\r').length }
}

const long = `TEST-ONLY log start ${'2026-10-09 12:00:00 INFO a line of a pasted log '.repeat(80)}TEST-ONLY log end`

test('a long message showing only its END in the box is submitted, not re-typed', async () => {
	// Measured: a 3,900-character line showed only its last rows; its start, which is
	// all the old check looked for, had scrolled out of the box.
	const t = fake([screen([`❯ …${long.slice(-200)}`]), screen(['❯ '])])
	const r = await ask(WS, long, t.io)
	assert.equal(r.ok, true)
	assert.equal(t.enters(), 1)
	assert.equal(t.writes.filter((w) => w !== '\r').length, 1, 'the message was typed more than once')
})

test("Claude Code's paste marker counts as the message being in the box", async () => {
	const t = fake([screen(['❯ [Pasted text #1 +1 lines]']), screen(['❯ '])])
	assert.equal((await ask(WS, long, t.io)).ok, true)
	assert.equal(t.enters(), 1)
})

test('a message that never shows up is reported, never typed a second time', async () => {
	// The old repair. It is how the second copy got there.
	const t = fake([screen(['❯ '])])
	const r = await ask(WS, 'TEST-ONLY a short message', t.io)
	assert.equal(r.ok, false)
	assert.deepEqual(t.writes, ['TEST-ONLY a short message'], 'typed again, or Enter pressed into an empty prompt')
})

test('Enter is pressed a bounded number of times into a box that will not submit', async () => {
	const t = fake([screen(['❯ TEST-ONLY stuck'])])
	const r = await ask(WS, 'TEST-ONLY stuck', t.io)
	assert.equal(r.ok, false)
	assert.ok(t.enters() <= 3, `pressed Enter ${t.enters()} times`)
	assert.match(!r.ok ? r.error : '', /would not submit/)
})

test('no prompt on screen gets one Enter, as the single write always did, never more', async () => {
	const t = fake(['a modal with no input box'])
	assert.equal((await ask(WS, 'TEST-ONLY hello', t.io)).ok, true)
	assert.equal(t.enters(), 1)
})

test('the text is written without an Enter in it', async () => {
	// An Enter inside a long write lands INSIDE Claude Code's paste as a newline, and
	// the message sits unsent.
	const t = fake([screen(['❯ TEST-ONLY hello']), screen(['❯ '])])
	await ask(WS, 'TEST-ONLY hello', t.io)
	assert.ok(!t.writes[0].includes('\r'))
})

test('pieces rejoin exactly and never split a character in half', () => {
	const text = `${'a'.repeat(511)}😀${'b'.repeat(1500)}`
	const ps = pieces(text)
	assert.equal(ps.join(''), text)
	assert.ok(ps.every((p) => p.length <= 512))
	assert.ok(!ps.some((p) => /^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p)), 'a surrogate pair was split')
})

test('a message over the limit is refused with the numbers', async () => {
	const t = fake([screen(['❯ '])])
	const r = await ask(WS, 'x'.repeat(20_001), t.io)
	assert.equal(r.ok, false)
	assert.match(!r.ok ? r.error : '', /20,001.*20,000/)
	assert.equal(t.writes.length, 0)
})

/** Codex's layout, as measured on 0.162: no rules, a `›` composer, the model line below. */
const codex = (composer: string, history: string[] = []) =>
	[...history, `› ${composer}`, '  GPT-5 medium · ~/projects/x', '  ? for shortcuts'].join('\n')

test('a Codex composer that ignores the first Enters is pressed until it sends, and typed once', async () => {
	// Measured: 2,900 characters stayed in the composer through Enters at 1, 3 and 5s
	// and went at 7s.
	const held = codex(long.slice(-200))
	const t = fake([held, held, held, held, codex('Ask Codex to do anything', [`› ${long.slice(0, 80)}`])])
	const r = await ask(WS, long, t.io)
	assert.equal(r.ok, true)
	assert.equal(t.enters(), 4)
	assert.equal(t.writes.filter((w) => w !== '\r').length, 1, 'the message was typed more than once')
})

test("a sent Codex message echoed ABOVE an empty composer counts as sent, not stuck", async () => {
	const msg = 'TEST-ONLY reply with only OK'
	const t = fake([codex(msg), codex('Ask Codex to do anything', [`› ${msg}`, '• OK'])])
	assert.equal((await ask(WS, msg, t.io)).ok, true)
	assert.equal(t.enters(), 1)
})

test("Codex's paste placeholder counts as the message being in the composer", async () => {
	const t = fake([codex('[Pasted Content 2983 chars]'), codex('Ask Codex to do anything')])
	assert.equal((await ask(WS, long, t.io)).ok, true)
	assert.equal(t.enters(), 1)
})

test('two rules a session printed, with no ❯ between them, are not mistaken for a prompt', async () => {
	const msg = 'TEST-ONLY a table above'
	const t = fake([codex(msg, [RULE, '| a | b |', RULE]), codex('Ask Codex to do anything', [RULE, '| a | b |', RULE, `› ${msg}`])])
	assert.equal((await ask(WS, msg, t.io)).ok, true)
	assert.equal(t.enters(), 1)
})

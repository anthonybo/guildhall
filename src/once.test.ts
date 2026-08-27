/**
 * At most once.
 *
 * This is the sixth attempt at "I have to send everything twice", and the five before it
 * are in MISTAKES.md. What is different is that this one does not depend on knowing why
 * a send is repeated: whatever drops — a sleeping laptop, a stale connection, a double
 * tap, a browser retry — the same key must not reach the session twice.
 *
 * So the test that matters is not "does the key work". It is that a second attempt gets
 * the FIRST attempt's answer and causes no second delivery.
 */
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { claim, finish, release, resetOnce } from './once.ts'

beforeEach(() => resetOnce())

test('a fresh key is allowed through exactly once', () => {
	assert.equal(claim('key-one'), null, 'the first attempt was refused')
	// Claimed immediately, before the send is attempted: two requests arriving together
	// must not both pass, or the whole thing is a race with extra steps.
	assert.deepEqual(claim('key-one'), { pending: true }, 'a second attempt was allowed to send')
})

test('a retry after the answer is known repeats the answer and sends nothing', () => {
	assert.equal(claim('key-two'), null)
	finish('key-two', { status: 200, body: '{"ok":true}' })
	const again = claim('key-two')
	assert.deepEqual(again, { done: { status: 200, body: '{"ok":true}' } })
	// Byte-identical, because the client must not be able to tell a retry from the send
	// that worked — that ambiguity is the entire bug.
	assert.ok(again && 'done' in again && again.done.body === '{"ok":true}')
})

test('a failed send is remembered too, so a retry does not try again', () => {
	// The point is one composed message reaching the session AT MOST once. If the first
	// attempt typed something and then failed, a retry must not type it a second time.
	assert.equal(claim('key-three'), null)
	finish('key-three', { status: 400, body: '{"error":"the message would not go in"}' })
	assert.deepEqual(claim('key-three'), { done: { status: 400, body: '{"error":"the message would not go in"}' } })
})

test('a refusal before anything was typed leaves the key usable', () => {
	// "no such session" happens before a single character is sent. Burning the key
	// would answer every later attempt with the stale refusal — so fixing the cause
	// and pressing Send again would appear broken forever.
	assert.equal(claim('key-four'), null)
	release('key-four')
	assert.equal(claim('key-four'), null, 'a key burned by a refusal that never sent anything')
})

test('release cannot resurrect a key that already has an answer', () => {
	// Otherwise a late release after a successful send would reopen the door the whole
	// module exists to hold shut.
	assert.equal(claim('key-five'), null)
	finish('key-five', { status: 200, body: '{"ok":true}' })
	release('key-five')
	assert.ok(claim('key-five'), 'a completed key was reopened')
})

test('keys expire, so the same phone can send again later', () => {
	const t0 = 1_000_000
	assert.equal(claim('key-six', t0), null)
	finish('key-six', { status: 200, body: '{"ok":true}' }, t0)
	// Inside the window: still the remembered answer.
	assert.ok(claim('key-six', t0 + 60_000))
	// Past it: a new message may use it again. Keys are random, so this is only about
	// not growing forever.
	assert.equal(claim('key-six', t0 + 200_000), null, 'a key never expired')
})

test('a flood of keys cannot grow the store without limit', () => {
	// A caller inventing keys must not be able to consume memory. Real use is a person
	// typing, so the ceiling is far above anything legitimate.
	const t0 = 2_000_000
	for (let i = 0; i < 500; i++) claim(`flood-${i}`, t0)
	// The oldest are dropped rather than the newest, so the keys most likely to be
	// retried — the recent ones — are the ones still protected.
	assert.deepEqual(claim('flood-499', t0), { pending: true }, 'the newest key was evicted')
})

test('an expired claim that finishes late does not come back to life', () => {
	// The send took longer than the window. Writing the result back would create a key
	// nobody is holding, which a later retry would then be answered from.
	const t0 = 3_000_000
	assert.equal(claim('key-slow', t0), null)
	finish('key-slow', { status: 200, body: '{"ok":true}' }, t0 + 300_000)
	assert.equal(claim('key-slow', t0 + 300_001), null, 'a long-dead key was revived by a late finish')
})

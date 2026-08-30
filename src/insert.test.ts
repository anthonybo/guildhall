/**
 * Putting a slash command into a box that already has something in it.
 *
 * The rule is that nothing already typed is ever lost. The first version assigned
 * `input.value` and wiped the box — "that should never happen" — and it went unnoticed
 * because every test of the picker started from an empty box, which is the one case
 * where assigning and inserting look identical.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { insertCommand } from '../web/dom.ts'

/** `|` marks the caret; `[...]` marks a selection. Keeps the cases readable. */
const at = (text: string, caret: number, name: string) => insertCommand(text, caret, caret, name)

test('an empty box just gets the command', () => {
	assert.deepEqual(at('', 0, 'impeccable'), { value: '/impeccable ', caret: 12 })
})

test('text already typed is kept, and the command lands at the caret', () => {
	// The whole report. Everything before and after the caret survives.
	const r = at('make the header responsive ', 27, 'impeccable')
	assert.equal(r.value, 'make the header responsive /impeccable ')
	assert.equal(r.caret, r.value.length)
})

test('the caret in the middle inserts there and leaves the tail alone', () => {
	const r = at('before after', 7, 'ship')
	assert.equal(r.value, 'before /ship after')
	// and the caret sits after what was inserted, ready to keep typing
	assert.equal(r.value.slice(0, r.caret), 'before /ship ')
})

test('a partial command being typed is completed, not doubled', () => {
	// Type-ahead filters on this, so picking from a filtered list must replace what
	// filtered it. Otherwise `/imp` plus a pick gives `/imp/impeccable`.
	assert.equal(at('/imp', 4, 'impeccable').value, '/impeccable ')
	assert.equal(at('look at /fro', 12, 'frontend-design').value, 'look at /frontend-design ')
})

test('a slash mid-word is not treated as a command being typed', () => {
	// `src/data` is a path, not a partial command, and eating it would destroy the
	// thing somebody was in the middle of writing.
	const r = at('check src/da', 12, 'impeccable')
	assert.equal(r.value, 'check src/da/impeccable ')
})

test('a selection is replaced, the way any text box behaves', () => {
	// "old text" selected, from 6 to 14
	const r = insertCommand('keep .old text. keep', 5, 15, 'ship')
	assert.equal(r.value, 'keep /ship  keep')
})

test('a caret past the end of the text does not produce holes', () => {
	// Defensive: selectionStart can be stale after the value changed underneath it.
	const r = at('short', 999, 'ship')
	assert.equal(r.value, 'short/ship ')
	assert.equal(r.caret, r.value.length)
})

test('the command always ends with a space, so an argument can follow', () => {
	for (const [text, caret] of [
		['', 0],
		['hello ', 6],
		['/im', 3],
	] as const) {
		assert.match(at(text, caret, 'impeccable').value, / $/, `no trailing space for ${JSON.stringify(text)}`)
	}
})

test('nothing that was typed is ever lost', () => {
	// The property, stated directly: every character outside the replaced partial
	// command survives.
	const text = 'please run the audit on the header and report back'
	for (let caret = 0; caret <= text.length; caret++) {
		const { value } = at(text, caret, 'impeccable')
		const without = value.replace('/impeccable ', '')
		assert.equal(without, text, `characters lost with the caret at ${caret}`)
	}
})

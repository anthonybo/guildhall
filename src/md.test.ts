/**
 * Recognising the shape of a reply.
 *
 * The risk here is not missing a structure — an unrecognised line stays a paragraph and
 * nothing is lost. The risk is the opposite: styling something as a heading or a
 * summary when it is neither, which makes the colour untrustworthy and therefore
 * useless. So most of these are cases where the obvious rule over-reaches.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { blocks, inlines } from '../web/md.ts'

const kinds = (s: string) => blocks(s).map((b) => b.kind)
const runsOf = (s: string, i = 0) => {
	const b = blocks(s)[i]!
	assert.ok('runs' in b, `block ${i} has no runs`)
	return b.runs.map((r) => r.text).join('')
}

test('a bolded line on its own is a heading; bold inside a sentence is not', () => {
	assert.deepEqual(kinds('**What changed**'), ['heading'])
	assert.equal(runsOf('**What changed**'), 'What changed')
	// The over-reach that matters: this is a sentence, and colouring it as a heading
	// would put a heading in the middle of a paragraph.
	assert.deepEqual(kinds('the **bundle** grew by 2KB'), ['para'])
	assert.deepEqual(kinds('# Heading one'), ['heading'])
})

test('a summary is found however it is written', () => {
	for (const opener of ['TL;DR — it works', 'TLDR: it works', '**TL;DR** — it works', 'tl;dr it works']) {
		assert.deepEqual(kinds(opener), ['tldr'], `not recognised: ${opener}`)
		assert.match(runsOf(opener), /it works/)
	}
	// and the marker itself is not left in the text, since the styling says it
	assert.doesNotMatch(runsOf('**TL;DR** — it works'), /TL;?DR/i)
})

test('a mention of a summary mid-paragraph is not a summary', () => {
	// "styled as a summary" has to mean "is one". This sentence talks about one.
	assert.deepEqual(kinds('I put the TL;DR at the end of the message'), ['para'])
})

test('bullets group into one list, and a paragraph after them starts again', () => {
	const b = blocks('- one\n- two\n- three\n\nand then prose')
	assert.deepEqual(
		b.map((x) => x.kind),
		['bullet', 'para'],
	)
	const list = b[0]!
	assert.ok('items' in list)
	assert.equal(list.items.length, 3)
	assert.equal(list.items[2]!.map((r) => r.text).join(''), 'three')
})

test('a fence swallows what is inside it, structure and all', () => {
	// This is the whole reason fences are handled first. A shell prompt starting with
	// `#` inside a code sample is a comment, not a heading, and a `-` is a flag.
	const b = blocks('before\n\n```\n# not a heading\n- not a bullet\n```\n\nafter')
	assert.deepEqual(
		b.map((x) => x.kind),
		['para', 'code', 'para'],
	)
	const code = b[1]!
	assert.ok('text' in code)
	assert.equal(code.text, '# not a heading\n- not a bullet')
})

test('an unterminated fence does not swallow the rest and vanish', () => {
	// A page cut mid-message ends in a half-written fence. Losing everything after it
	// would be losing conversation, which is the one thing this view must not do.
	const b = blocks('text\n\n```\nstill code')
	assert.deepEqual(
		b.map((x) => x.kind),
		['para', 'code'],
	)
	const code = b[1]!
	assert.ok('text' in code)
	assert.equal(code.text, 'still code')
})

test('inline runs split bold and code without losing any characters', () => {
	const text = 'set **wrap** with `--wrap` first'
	assert.equal(
		inlines(text)
			.map((r) => r.text)
			.join(''),
		'set wrap with --wrap first',
		'characters were dropped or duplicated',
	)
	assert.deepEqual(
		inlines(text).filter((r) => r.strong).map((r) => r.text),
		['wrap'],
	)
	assert.deepEqual(
		inlines(text).filter((r) => r.code).map((r) => r.text),
		['--wrap'],
	)
	// plain text comes back as one run rather than nothing
	assert.deepEqual(inlines('plain'), [{ text: 'plain' }])
})

test('every character of a reply survives being split into blocks', () => {
	// The parser must never eat content. Compared with the markers removed, since
	// those are what the styling replaces.
	const reply = '**Heading**\n\nsome prose with **bold** in it\n\n- a bullet\n- another\n\n> quoted\n\nTL;DR — done'
	const got = blocks(reply)
		.map((b) => ('runs' in b ? b.runs.map((r) => r.text).join('') : 'items' in b ? b.items.map((i) => i.map((r) => r.text).join('')).join('') : 'text' in b ? b.text : ''))
		.join('')
		.replace(/\s+/g, '')
	const want = reply
		.replace(/\*\*/g, '')
		.replace(/^[->]\s+/gm, '')
		.replace(/TL;DR\s*—\s*/i, '')
		.replace(/\s+/g, '')
	assert.equal(got, want)
})

test('a pipe table is recognised, with its header, alignment and cells', () => {
	const md = '| check | budget |\n|---|---:|\n| terminal frame | 4.0 |\n| bundle | 170 KB |'
	const b = blocks(md)
	assert.deepEqual(
		b.map((x) => x.kind),
		['table'],
	)
	const t = b[0]!
	assert.ok('head' in t)
	assert.deepEqual(
		t.head.map((h) => h.map((r) => r.text).join('')),
		['check', 'budget'],
	)
	assert.deepEqual(t.align, ['left', 'right'])
	assert.equal(t.rows.length, 2)
	assert.deepEqual(
		t.rows[1]!.map((c) => c.map((r) => r.text).join('')),
		['bundle', '170 KB'],
	)
})

test('a pipe that is not a table stays prose', () => {
	// The over-reach that would wreck ordinary text. None of these has a separator
	// line under a header, which is the only thing that makes a table a table.
	for (const notTable of ['run it | head -3', 'a | b', 'the exit code of `cmux rpc … | head` is head’s']) {
		assert.deepEqual(kinds(notTable), ['para'], `treated as a table: ${notTable}`)
	}
	// a separator with no pipe is a horizontal rule at most, not a table
	assert.notDeepEqual(kinds('heading\n-----'), ['table'])
})

test('a table inside a fence is left alone', () => {
	// Sample markdown in a code block is being SHOWN, not rendered.
	const b = blocks('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```')
	assert.deepEqual(
		b.map((x) => x.kind),
		['code'],
	)
})

test('a ragged row cannot slip its columns', () => {
	// Hand-written tables lose a trailing cell all the time. Padding to the header is
	// what stops a value appearing under the wrong heading, which is the one failure
	// that makes a table actively misleading rather than merely ugly.
	const b = blocks('| a | b | c |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |')
	const t = b[0]!
	assert.ok('rows' in t)
	for (const row of t.rows) assert.equal(row.length, 3, 'a row does not match the header width')
	assert.equal(t.rows[0]!.map((c) => c.map((r) => r.text).join('')).join('|'), '1|2|')
	assert.equal(t.rows[1]!.map((c) => c.map((r) => r.text).join('')).join('|'), '1|2|3')
})

test('a table ends where its rows end, and prose after it survives', () => {
	const b = blocks('| a |\n|---|\n| 1 |\n\nprose after')
	assert.deepEqual(
		b.map((x) => x.kind),
		['table', 'para'],
	)
	assert.equal(runsOf('| a |\n|---|\n| 1 |\n\nprose after', 1), 'prose after')
})

test('cells keep their inline formatting', () => {
	const t = blocks('| what | how |\n|---|---|\n| **bold** | `code` |')[0]!
	assert.ok('rows' in t)
	const [first, second] = t.rows[0]!
	assert.deepEqual(first, [{ text: 'bold', strong: true }])
	assert.deepEqual(second, [{ text: 'code', code: true }])
})

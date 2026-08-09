/**
 * URL detection in terminal output.
 *
 * Terminal text is prose, and every case here is one where the obvious regex
 * gets it wrong in a way you only notice after tapping the link on a phone.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { linkParts } from '../web/links.ts'

/** Just the hrefs, which is what these tests are about. */
const hrefs = (s: string) => linkParts(s).filter((p) => p.href).map((p) => p.href)

test('a bare url is found', () => {
	assert.deepEqual(hrefs('open http://willow.local/ now'), ['http://willow.local/'])
})

test('a sentence full stop is not part of the link', () => {
	// The one that actually bit: "Try http://willow.local/." linkified the stop,
	// and the resulting URL 404s.
	assert.deepEqual(hrefs('Try http://willow.local/.'), ['http://willow.local/'])
})

test('enclosing punctuation is handed back', () => {
	assert.deepEqual(hrefs('(see https://example.com/a).'), ['https://example.com/a'])
	assert.deepEqual(hrefs('"https://example.com/b",'), ['https://example.com/b'])
})

test('a url containing brackets is truncated, and that is the deliberate trade', () => {
	// Brackets are excluded from the match outright, so a Wikipedia-style path is
	// cut at the opening paren rather than captured.
	//
	// The alternative — allowing brackets inside a URL — breaks the far more common
	// case in this app's output: prose like "(see http://x.test)" would swallow the
	// closing paren into the link. Terminal output here is sentences with the odd
	// localhost or GitHub URL in them, not bracketed wiki paths, so this is the
	// cheaper error. Written down because it looks like a bug until you know why.
	assert.deepEqual(hrefs('http://example.com/wiki/Foo_(bar)'), ['http://example.com/wiki/Foo_'])
})

test('several links on one line all come back', () => {
	assert.deepEqual(hrefs('http://a.test/1 and http://b.test/2'), ['http://a.test/1', 'http://b.test/2'])
})

test('the surrounding prose survives intact', () => {
	// The parts must reassemble into the original line, or the terminal would be
	// drawing something different from what the session printed.
	const line = 'Reload at http://100.100.100.100:5190/?v=3. Then tell me.' // allow-personal: synthetic CGNAT literals, which are what this test exercises
	assert.equal(
		linkParts(line)
			.map((p) => p.text)
			.join(''),
		line,
	)
})

test('a scheme with nothing after it is not a link', () => {
	assert.deepEqual(hrefs('http://'), [])
	assert.deepEqual(hrefs('see https://.'), [])
})

test('text with no url is one plain part', () => {
	assert.deepEqual(linkParts('nothing here'), [{ text: 'nothing here' }])
})

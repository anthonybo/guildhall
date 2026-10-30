/**
 * Joining a narrow terminal's prose back up so it can fill a wide browser (web/reflow.ts)
 * — and leaving alone everything whose meaning is in its columns.
 *
 * Hand-built screens, because the real ones it was measured on are private
 * conversations. Each case is one that went wrong, or nearly did, while measuring.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { reflow } from '../web/reflow.ts'

const WHITE = '#FFFFFF'
const styles = [
	{ id: 0 },
	{ id: 1, foreground: '#0869CB', foreground_source: 'rgb' }, // keyword blue
	{ id: 2, foreground: '#CDAC08', foreground_source: 'rgb' }, // number yellow
	{ id: 3, foreground: '#B1B9F9', foreground_source: 'rgb' }, // one accent
	{ id: 4, foreground: '#999999', foreground_source: 'rgb' }, // secondary gray
	{ id: 5, foreground: '#4EBA65', foreground_source: 'rgb' }, // green
]

/** A 40-column screen from rows of [column, text, style?] runs. */
function screen(rows: [number, string, number?][][], columns = 40) {
	const row_spans = rows.flatMap((runs, row) => runs.map(([column, text, style_id = 0]) => ({ row, column, text, style_id })))
	return { rows: rows.length, columns, styles, row_spans, terminal_foreground: WHITE, terminal_background: '#000000' }
}
const text = (l: { runs: { text: string }[] }) => l.runs.map((r) => r.text).join('').trim()

test('prose the pane broke only for width is joined, at its hanging indent', () => {
	const g = screen([
		[[0, '⏺ The quick brown fox jumps over the']], // "lazy" would not have fitted
		[[2, 'lazy dog and keeps on running until']],
		[[2, 'night.']],
		[],
		[[0, '- one item that wraps onto the next']],
		[[2, 'line under its marker.']],
		[[0, '- a short item.']],
	])
	const out = reflow(g).filter((l) => !l.fixed)
	assert.deepEqual(out.map(text), ['⏺ The quick brown fox jumps over the lazy dog and keeps on running until night.', '- one item that wraps onto the next line under its marker.', '- a short item.'])
	assert.equal(out[0]!.hang, 2, 'continuation rows hang under the text after the marker')
})

test("the spinner's line wraps like a reply and is joined the same way", () => {
	const g = screen([[[0, '✻ Cogitated for 44m 49s · done 11:23 · 1']], [[2, 'shell still running']]])
	assert.deepEqual(reflow(g).map(text), ['✻ Cogitated for 44m 49s · done 11:23 · 1 shell still running'])
})

test('a row that ended early is a real line break, and stays one', () => {
	// "dog" would have fitted after "fox", so the terminal broke here on purpose
	const g = screen([[[0, 'The quick brown fox']], [[0, 'dog is a separate line here.']]])
	assert.deepEqual(reflow(g).filter((l) => !l.fixed).map(text), ['The quick brown fox', 'dog is a separate line here.'])
})

test('a syntax-highlighted code block keeps every line, even ones that reach the edge', () => {
	// Measured on a real 47-column block: without this, three statements became one line.
	// Highlighted at both ends, as a real block is throughout; the plain-white statement in
	// the middle reaches the edge and would otherwise be joined to the next.
	const g = screen([
		[[2, 'function', 1], [11, 'make(a, b = '], [24, '0', 2], [25, ') {']],
		[[4, 'count += step; console.log(value, a)']],
		[[4, 'console.log(b)']],
		[[4, 'return', 1], [11, 'count + '], [19, '1', 2], [20, ';']],
		[[2, '}']],
	])
	const lines = reflow(g)
	assert.ok(lines.slice(0, 3).every((l) => l.rows.length === 1), 'a code line was joined to another')
})

test('one colored hint under a paragraph does not make the paragraph code', () => {
	// The "✔ Update installed" line sits under a recap with no blank row between.
	const g = screen([
		[[0, '※ recap: the first part of a long recap']],
		[[2, 'continues here and ends.']],
		[[10, 'tip · ', 4], [16, '✔ Updated', 5], [26, ' · ', 4], [29, 'restart', 3]],
	])
	assert.equal(reflow(g)[0]!.rows.length, 2, 'the recap stopped joining')
})

test('boxes, the status bar and a word split at the edge', () => {
	const g = screen([
		[[0, '┌──────────┐']],
		[[0, '│ box text │']],
		[[0, 'a_very_long_token_that_runs_right_to_t_']], // all 40 columns, no spaces: split mid-word
		[[0, 'he_edge and then words']],
		[[0, '────────────────────────────────────────']],
		[[0, '❯ ']],
		[[0, '────────────────────────────────────────']],
		[[2, 'Opus · status bar that is long enough to']],
		[[2, 'wrap but must never be joined']],
	])
	const lines = reflow(g)
	assert.ok(lines[0]!.fixed && lines[1]!.fixed, 'a box was reflowed')
	assert.equal(text(lines[2]!), 'a_very_long_token_that_runs_right_to_t_he_edge and then words', 'a split word was joined with a space')
	assert.ok(lines.slice(-2).every((l) => l.fixed), 'the status bar was joined')
})

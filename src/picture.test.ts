/**
 * Finding a picture in a terminal grid. The kitty placeholder cells came out as a tall
 * blank hole on a phone, with everything after the picture apparently gone.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PLACEHOLDER, pictures } from '../web/picture.ts'

/** A placeholder cell as cmux reports it: the character plus two combining marks. */
const cell = (row: number, column: number) => ({ row, column, style_id: 8, text: `${PLACEHOLDER}̅̅` })
const text = (row: number, column: number, t: string) => ({ row, column, style_id: 0, text: t })

test('consecutive placeholder rows are one picture, named by the line above it', () => {
	const spans = [text(0, 2, 'Read 1 file'), text(1, 5, 'w-all.png')]
	for (let r = 2; r < 6; r++) for (let c = 5; c < 9; c++) spans.push(cell(r, c))
	spans.push(text(7, 0, '⏺ after the picture'))
	assert.deepEqual(pictures(spans, 10), [{ top: 2, bottom: 5, left: 5, right: 8, name: 'w-all.png', style: 8 }])
})

test('a picture whose name has scrolled off is still found, without one', () => {
	const spans = [cell(0, 3), cell(0, 4), cell(1, 3), cell(1, 4), text(3, 0, 'later text, no file name')]
	assert.deepEqual(pictures(spans, 5), [{ top: 0, bottom: 1, left: 3, right: 4, name: null, style: 8 }])
})

test('two pictures with a line between them are two, and plain text is none', () => {
	const spans = [text(0, 0, 'a.png'), cell(1, 0), text(2, 0, 'b.jpeg'), cell(3, 0)]
	assert.deepEqual(
		pictures(spans, 4).map((p) => p.name),
		['a.png', 'b.jpeg'],
	)
	assert.deepEqual(pictures([text(0, 0, 'a screenshot.png is mentioned here')], 1), [])
})

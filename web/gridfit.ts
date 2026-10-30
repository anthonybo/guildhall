/**
 * Draw one line `reflow` joined (reflow.ts): the terminal's text, wrapped at the browser's
 * width instead of the pane's, keeping its hanging indent so a list item or a `⏺` reply
 * still reads as one.
 */
import { type Grid, type Style, fill, styledCell } from './cell.ts'
import type { Line } from './reflow.ts'

export function fitLine(line: Line, byId: Map<number, Style>, g: Grid): HTMLElement {
	const el = document.createElement('div')
	el.dataset.row = String(line.rows[0])
	// Wraps where the panel ends. Continuation rows sit under the text after the marker
	// (`hang`), and the first row starts where the terminal started it (`indent`) — `ch`
	// is one cell of this monospace face, so both are exact.
	el.style.cssText = `white-space:pre-wrap;overflow-wrap:break-word;padding-left:${line.hang}ch;text-indent:${line.indent - line.hang}ch`
	let started = false
	for (const sp of line.runs) {
		// The first row's leading blanks are the indent, which text-indent now draws.
		const text = started ? sp.text : sp.text.trimStart()
		if (!text) continue
		started = true
		const cell = styledCell(byId.get(sp.style_id), g, sp.column)
		// nodes, never innerHTML: this is whatever the terminal is showing
		fill(cell, text)
		el.append(cell)
	}
	return el
}

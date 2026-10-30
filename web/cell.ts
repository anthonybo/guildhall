/**
 * One run of terminal text as a styled element, shared by the exact grid (grid.ts) and
 * the reflowed one (gridfit.ts) so the two can never draw a color, a link or an inverse
 * cursor differently.
 */
import { linkParts } from './links.ts'

export type Style = { foreground?: string; background?: string; bold?: boolean; faint?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; inverse?: boolean; invisible?: boolean; id: number }
export type Span = { row: number; column: number; style_id: number; text: string }
export type Grid = { rows: number; columns: number; styles: Style[]; row_spans: Span[]; terminal_foreground?: string; terminal_background?: string }

/**
 * Put `text` into `host`, turning any URLs into real links.
 *
 * Built as nodes rather than markup: this is whatever a session happened to
 * print, and it must never be able to become HTML. The anchor keeps the
 * terminal's own colour and adds an underline, so a link looks like a link
 * without losing whatever the colour already meant.
 */
export function fill(host: HTMLElement, text: string) {
	const parts = linkParts(text)
	// the overwhelmingly common case: no link, one text node, no allocation beyond it
	if (parts.length === 1 && !parts[0]!.href) return void host.append(text)
	for (const p of parts) {
		if (!p.href) {
			host.append(p.text)
			continue
		}
		const a = document.createElement('a')
		a.href = p.href
		a.textContent = p.text
		a.target = '_blank'
		// noopener because the opened page must not get a handle on this one, and
		// this page can type into somebody's terminal
		a.rel = 'noopener noreferrer'
		a.className = 'underline decoration-dotted underline-offset-2 hover:decoration-solid'
		host.append(a)
	}
}

/** A span element carrying `st`'s look, for a run that starts at terminal column `column`. */
export function styledCell(st: Style | undefined, g: Grid, column: number): HTMLSpanElement {
	const cell = document.createElement('span')
	// Where this run starts in the terminal, so a tap can be mapped back to a cell
	// however the row was laid out (see cellAt).
	cell.dataset.col = String(column)
	// inverse swaps them, which is how a selected row or a cursor is drawn
	const fg = st?.inverse ? (st?.background ?? g.terminal_background) : st?.foreground
	const bg = st?.inverse ? (st?.foreground ?? g.terminal_foreground) : st?.background
	if (fg) cell.style.color = fg
	if (bg && bg !== g.terminal_background) cell.style.background = bg
	if (st?.bold) cell.style.fontWeight = '700'
	if (st?.faint) cell.style.opacity = '0.7'
	if (st?.italic) cell.style.fontStyle = 'italic'
	if (st?.underline || st?.strikethrough) cell.style.textDecoration = `${st.underline ? 'underline' : ''} ${st.strikethrough ? 'line-through' : ''}`.trim()
	if (st?.invisible) cell.style.visibility = 'hidden'
	return cell
}

/**
 * Drawing a terminal's screen into the page, at a size you can actually read.
 *
 * Split out of terminal.ts, which had grown past the length this repository
 * allows and was doing two unrelated jobs: talking to the machine, and turning a
 * grid of styled cells into DOM. This is the second one and nothing else — it
 * touches no network, holds no session, and can be reasoned about on its own.
 *
 * Spans carry a row, a column and a style id, so this PLACES them rather than
 * concatenating them — which is what makes a status bar or a progress gauge land
 * where the terminal put it instead of drifting. Gaps between spans are padded
 * with spaces, because a terminal row is a fixed number of cells and a missing
 * one shifts everything after it.
 */
import { linkParts } from './links.ts'
import { fullScreen } from './viewport.ts'

type Style = { foreground?: string; background?: string; bold?: boolean; faint?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; inverse?: boolean; invisible?: boolean; id: number }
type Span = { row: number; column: number; style_id: number; text: string }
export type Grid = { rows: number; columns: number; styles: Style[]; row_spans: Span[]; terminal_foreground?: string; terminal_background?: string }

/**
 * Draw the grid.
 *
 * Spans carry a row, a column and a style id, so this places them rather than
 * concatenating them — which is what makes a status bar or a progress gauge land
 * where the terminal put it instead of drifting. Gaps between spans are padded
 * with spaces, because a terminal row is a fixed number of cells and a missing
 * one shifts everything after it.
 */
/**
 * Width of one character as a fraction of the font size, measured once.
 *
 * Cached because it cannot change without the font changing, and measuring it
 * forces a layout — which is not something to do twice a second behind a poll.
 */
/** Largest type this will use. Past about here a terminal stops reading as one. */
const COMFORTABLE = 15

/**
 * Smallest type this will shrink to before it gives up and scrolls sideways.
 *
 * A 193-column screen on a 390px phone wants about 3px to fit, which is not small
 * type so much as a texture; past the floor, scrolling is the better trade
 * because you can at least reach the words.
 *
 * 8 rather than 9 because a 70-column screen needs 8.68px to fit that same phone,
 * and a floor that rounded that up would make the common case scroll to save four
 * per cent of nothing.
 */
const LEGIBLE = 8

/**
 * Type size once the grid has been given up on and the rows are reflowed.
 *
 * No longer tied to the column count — the lines are wrapping anyway — so this is
 * just a readable size on a phone. 12px puts about 50 characters on a 390px
 * screen, which is a comfortable measure for prose.
 */
const READABLE = 12

/** The screen's own horizontal padding (px-3 both sides), which is not grid. */
const PAD = 24

/** One non-space character repeated a long way: a divider, not words. */
const RULE = /^(\S)\1{7,}$/

/**
 * Put `text` into `host`, turning any URLs into real links.
 *
 * Built as nodes rather than markup: this is whatever a session happened to
 * print, and it must never be able to become HTML. The anchor keeps the
 * terminal's own colour and adds an underline, so a link looks like a link
 * without losing whatever the colour already meant.
 */
function fill(host: HTMLElement, text: string) {
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

let ratio = 0
function advanceRatio(host: HTMLElement) {
	if (ratio) return ratio
	const probe = document.createElement('span')
	probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px'
	probe.textContent = 'M'.repeat(100)
	host.append(probe)
	const w = probe.getBoundingClientRect().width
	probe.remove()
	// 100 chars at 100px, so the raw width is already the ratio x 10000
	ratio = w > 0 ? w / 10000 : 0.6
	return ratio
}

/**
 * Draw `g` into `pre`, sizing `panel` around it.
 *
 * Returns whether the grid was too wide to fit legibly, which is the one thing
 * the caller needs back: it is the same test that decides between the two draw
 * modes, so the Wrapped/Exact control appears from the measurement rather than
 * from a breakpoint that only approximates it — a desktop window dragged narrow
 * enough gets the control too. Returned rather than reached for through
 * `getElementById`, so this module never has to know what the caller called it.
 */
export function paint(pre: HTMLElement, g: Grid, panel: HTMLElement, wrap: boolean): boolean {
	const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24
	const byId = new Map(g.styles.map((st) => [st.id, st]))
	const rows = new Map<number, Span[]>()
	for (const sp of g.row_spans) {
		const list = rows.get(sp.row) ?? []
		list.push(sp)
		rows.set(sp.row, list)
	}
	pre.style.background = g.terminal_background ?? 'transparent'
	pre.style.color = g.terminal_foreground ?? 'inherit'
	// Fit the real column count to the real width. A terminal is only legible as a
	// whole, so the type is sized to the grid rather than the grid to the type.
	//
	// The ratio is measured, not assumed: it varies by platform and by which font
	// in the stack actually resolved, and getting it wrong either overflows the
	// screen or leaves it in a pool of dead space. On this Mac the stack lands on
	// ui-monospace at 0.602.
	//
	// Shrink to fit, never magnify to fill. These terminals run 70 to 193 columns
	// depending on how the panes are split, so "use the whole window" and "stay
	// readable" are the same instruction only when the grid happens to match the
	// glass. Stretching a 70-column screen across 1541px needs 28px type, which is
	// not full width so much as zoomed in — the columns to fill it do not exist.
	// A wide grid shrinks until it fits; a narrow one stops at a comfortable size
	// and is centred, which reads as deliberate rather than as a failure to fill.
	//
	// The panel is then narrowed to what the grid actually needs. Leaving it full
	// width and centring the text only splits the dead space into two pools; a
	// terminal window that is the size of its terminal reads as deliberate.
	//
	// The cap is cleared before measuring, or each pass would measure the width the
	// previous pass constrained it to and walk the type down to nothing.
	panel.style.maxWidth = ''
	panel.style.marginInline = ''
	const advance = advanceRatio(pre)
	const usable = Math.max(200, pre.clientWidth - PAD)
	const exact = Math.min(COMFORTABLE, usable / (g.columns * advance))
	// Reflowing is only on the table when the grid cannot fit legibly, which on
	// every desktop width is never — so this branch is, in practice, the phone.
	const cramped = exact < LEGIBLE
	const reflow = wrap && cramped
	const size = reflow ? READABLE : Math.max(LEGIBLE, exact)
	pre.style.fontSize = `${size.toFixed(2)}px`
	pre.style.lineHeight = '1.25'
	pre.style.whiteSpace = reflow ? 'pre-wrap' : 'pre'
	// break-word, not break-all: a wrapped path or a long token should move whole
	// rather than be sliced mid-word wherever the edge happens to fall
	pre.style.overflowWrap = reflow ? 'break-word' : ''
	// Take the whole height the window has left, rather than a flat 60vh. A cmux
	// pane is 60 rows and 60vh of a laptop window showed 28 of them — less than
	// half the session's screen on a view whose only job is to show that screen.
	// Measured from the chrome around it rather than from the panel's own position,
	// which moves as the page scrolls.
	//
	// Only when the panel is INLINE. Full screen on a phone it is a flex column, and
	// `flex-1` already gives the screen exactly the space between the bar and the
	// input — a maxHeight computed from `window.innerHeight` would fight that, and
	// lose the moment the keyboard opens and changes the height it was computed from.
	if (fullScreen()) {
		pre.style.maxHeight = ''
	} else {
		const headerH = document.getElementById('bar')?.getBoundingClientRect().height ?? 0
		const above = (panel.firstElementChild?.getBoundingClientRect().height ?? 0) + headerH
		const below = panel.lastElementChild?.getBoundingClientRect().height ?? 0
		pre.style.maxHeight = `${Math.max(200, window.innerHeight - above - below - 24)}px`
	}
	const needed = Math.ceil(g.columns * advance * size) + PAD + 2
	if (needed < pre.clientWidth) {
		panel.style.maxWidth = `${needed}px`
		panel.style.marginInline = 'auto'
	}

	const out: HTMLElement[] = []
	for (let r = 0; r < g.rows; r++) {
		const line = document.createElement('div')
		const spans = (rows.get(r) ?? []).sort((a, b) => a.column - b.column)
		let col = 0
		for (const sp of spans) {
			// Column gaps place a span where the terminal put it. Reflowed, they place
			// nothing — the row is no longer a row — and a status bar's 40-space gaps
			// would wrap into blank lines, so they collapse to a readable separation.
			if (sp.column > col) line.append(reflow ? '  '.slice(0, Math.min(2, sp.column - col)) : ' '.repeat(sp.column - col))
			const st = byId.get(sp.style_id)
			const cell = document.createElement('span')
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
			// A divider is one character repeated across the whole terminal, and
			// reflowed it becomes four wrapped lines of dashes where the terminal drew
			// one — so a rule is clipped to the width instead of wrapped. It reads as
			// the line it was meant to be, and costs one row rather than four.
			if (reflow && RULE.test(sp.text)) cell.style.cssText += ';display:inline-block;width:100%;white-space:nowrap;overflow:hidden;vertical-align:bottom'
			// nodes, never innerHTML: this is whatever the terminal is showing, and it
			// must not be able to become markup
			fill(cell, sp.text)
			line.append(cell)
			col = sp.column + [...sp.text].length
		}
		if (!spans.length) line.append('\u00a0')
		out.push(line)
	}
	pre.replaceChildren(...out)
	if (atBottom) pre.scrollTop = pre.scrollHeight
	return cramped
}


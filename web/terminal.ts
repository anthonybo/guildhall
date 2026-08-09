/**
 * The terminal view: what a session's screen actually shows, and a box to type
 * into it.
 *
 * Everything else in this client reads a summary. This shows the real thing, and
 * can write to it — so it is gated on a token the viewing passcode does not
 * grant, kept in sessionStorage rather than localStorage so closing the tab
 * forgets it, and never put in a URL where a proxy or history could keep it.
 *
 * The screen is polled rather than streamed. A terminal is only interesting when
 * you are looking at it, and polling stops dead when the panel closes — which is
 * the behaviour a phone battery wants and a stream would not give.
 */
import { linkParts } from './links.ts'

const KEY = 'guildhall.control'
const WRAP = 'guildhall.terminal.wrap'

/**
 * What to do when the grid is wider than the glass — which only ever happens on
 * a phone, because every desktop width fits every pane at a readable size.
 *
 * `exact` keeps the true grid and scrolls sideways: alignment survives, and you
 * drag to read. `wrap` reflows the rows like any other text, which breaks the
 * status bar's columns but means you can actually read the prose.
 *
 * Wrapping is the default because the thing you open this view to do is read
 * what the session said. Shrinking the grid to fit was measured and rejected: a
 * 193-column screen on a 390px phone lands at 2.89px, which is a grey texture
 * rather than small type — it fits in the sense that a photograph of a page fits.
 */
let wrap = localStorage.getItem(WRAP) !== 'exact'

/** The last screen drawn, so an unchanged one is not rebuilt under your selection. */
let lastSig = ''

let openId: string | null = null
let openName = ''
let timer = 0
let el: HTMLElement
let onClose = () => {}

const token = () => sessionStorage.getItem(KEY) ?? ''

async function api(path: string, init: RequestInit = {}) {
	const res = await fetch(path, { ...init, headers: { 'x-guildhall-control': token(), ...(init.headers ?? {}) } })
	const body = await res.json().catch(() => ({ error: 'unreadable reply' }))
	return { status: res.status, ...body } as { status: number; render_grid?: Grid; error?: string; ok?: boolean }
}

/** Ask for the token. Only reached when the server says the current one is wrong. */
function askForToken(why: string) {
	// STOP POLLING. This is the whole bug behind "I keep getting locked out and I
	// never even entered a password".
	//
	// The screen polls every two seconds. A refusal used to render this form and
	// leave the timer running, so the client re-sent the same rejected password
	// thirty times a minute, forever. The server counts each one and never resets
	// the count on failure, so the lock doubles every time: five free tries gone in
	// ten seconds, then 15s, 30s, 60s, up to a thirty-minute maximum — and two
	// seconds after each lock expired the timer burned the next attempt and
	// re-locked, longer. One stale token was enough to lock a phone out
	// permanently with nobody touching it.
	//
	// A refused request is now the end of the conversation. Only submitting a
	// password starts it again.
	clearInterval(timer)
	timer = 0
	el.innerHTML = ''
	// the panel was sized to a terminal; a password form is not one
	el.style.maxWidth = ''
	el.style.marginInline = ''
	const wrap = document.createElement('div')
	wrap.className = 'p-4'
	const h = document.createElement('p')
	h.className = 'mt-0 mb-2 text-label'
	h.textContent = 'Control password'
	const p = document.createElement('p')
	p.className = 'mt-0 mb-3 text-[0.78rem]/[1.45] text-faint'
	// say plainly where it comes from: it is read off the machine, not sent to you
	p.textContent = `${why} It is the password you set on the machine running guildhall — press ? there, then c.`
	const input = document.createElement('input')
	input.type = 'password'
	input.autocomplete = 'off'
	input.spellcheck = false
	input.placeholder = 'the password you set'
	input.className = 'w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-label'
	const go = document.createElement('button')
	go.type = 'button'
	go.textContent = 'Unlock'
	go.className = 'mt-2 cursor-pointer rounded border border-gold bg-gold px-3 py-1.5 font-bold text-bg'
	const submit = () => {
		sessionStorage.setItem(KEY, input.value.trim())
		if (openId) show(openId, openName)
	}
	go.addEventListener('click', submit)
	input.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
	wrap.append(h, p, input, go)
	el.append(wrap)
	input.focus()
}

function chrome(name: string) {
	el.innerHTML = ''
	// Not sticky, and that was a real bug rather than a preference: the panel sets
	// `overflow-hidden` to clip its rounded corners, which makes IT the scroll
	// container a sticky child resolves against — so `top: <header height>` offset
	// the bar that far down from the panel's own top instead of parking it under
	// the page header, and the screen showed through the gap above it.
	//
	// It does not need to be sticky. paint() sizes the screen to the window minus
	// this bar, the form and the header, so the whole panel fits by construction
	// and Close is on screen whenever the terminal is.
	const bar = document.createElement('div')
	bar.id = 'screenbar'
	bar.className = 'flex items-center gap-2 border-b border-line bg-panel px-3 py-2'
	const title = document.createElement('span')
	title.className = 'font-bold text-label'
	title.textContent = name
	const live = document.createElement('span')
	live.className = 'text-[0.72rem] text-faint'
	live.textContent = 'live terminal'
	// Shown only when it does something. Both modes draw the same thing at any width
	// that fits the grid, so paint() reveals this from the same test that chooses
	// between them rather than from a breakpoint that only approximates it — a
	// desktop window dragged narrow enough gets the control too.
	const mode = document.createElement('button')
	mode.type = 'button'
	mode.id = 'screenmode'
	mode.hidden = true
	mode.className = 'flex min-h-11 cursor-pointer items-center rounded border border-line bg-transparent px-3 text-[0.78rem] text-muted hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold'
	const label = () => {
		mode.textContent = wrap ? 'Wrapped' : 'Exact'
		mode.title = wrap ? 'Lines are reflowed to fit. Tap for the true grid.' : 'The true grid, scrolled sideways. Tap to reflow it to fit.'
	}
	label()
	mode.addEventListener('click', () => {
		wrap = !wrap
		localStorage.setItem(WRAP, wrap ? 'wrap' : 'exact')
		label()
		refresh()
	})

	// Was a bare ✕ at `px-1` — about a 20px target, unlabelled, sat next to a
	// bordered button that read as the real control. Now it says what it does and
	// clears 44px, which is the smallest thing a thumb reliably hits.
	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕ Close'
	x.title = 'Close the terminal (Esc)'
	// Red outline, so the way out is the one thing in this bar that is not grey.
	// Not a red FILL — that reads as destructive, and this closes a panel. Not
	// gold either: the Send button below it is gold, and two identical buttons
	// where one sends and one closes is a mix-up waiting to happen. 5.41:1.
	x.className =
		'flex min-h-11 cursor-pointer items-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot'
	x.addEventListener('click', close)
	// Grouped so the pair stays right-aligned when the mode button is hidden — two
	// separate `ml-auto`s would split the free space and strand them apart.
	const tail = document.createElement('div')
	tail.className = 'ml-auto flex items-center gap-2'
	tail.append(mode, x)
	bar.append(title, live, tail)

	const pre = document.createElement('pre')
	pre.id = 'screen'
	// the screen is preformatted terminal output: never innerHTML, and it scrolls
	// inside its own box so a tall screen cannot stretch the page
	// A terminal is a fixed grid and must not reflow, so it scrolls sideways.
	// Size and height are both set in paint(), from the real grid and the real
	// window, because a terminal you have to scroll to read one line of is barely
	// a terminal.
	pre.className = 'm-0 overflow-auto px-3 py-2 whitespace-pre'
	pre.textContent = 'reading…'

	const form = document.createElement('form')
	form.className = 'flex gap-2 border-t border-line p-2'
	const input = document.createElement('input')
	input.id = 'ask'
	input.autocomplete = 'off'
	input.placeholder = 'Type into this session…'
	input.className = 'flex-1 rounded border border-line bg-bg px-2 py-1.5 font-mono text-label'
	const send = document.createElement('button')
	send.type = 'submit'
	send.textContent = 'Send'
	send.className = 'cursor-pointer rounded border border-gold bg-gold px-3 py-1.5 font-bold text-bg'
	form.append(input, send)
	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		const text = input.value
		if (!text.trim()) return
		input.value = ''
		send.disabled = true
		const r = await api('/api/send', { method: 'POST', body: JSON.stringify({ id: openId, text }) })
		send.disabled = false
		if (r.error) {
			pre.textContent = `${r.error}\n\n${pre.textContent}`
			input.value = text // give it back rather than losing what was typed
		}
		refresh()
		input.focus()
	})

	el.append(bar, pre, form)
	return { pre, input }
}

async function refresh() {
	if (!openId) return
	const r = await api(`/api/screen?id=${encodeURIComponent(openId)}`)
	if (r.status === 401) return askForToken('That password was not accepted.')
	if (r.status === 403) return askForToken('Control is off, or this device is not on the machine or its tailnet.')
	if (r.status === 429) return askForToken('Too many wrong tries — wait a moment.')
	const pre = document.getElementById('screen')
	if (!pre) return
	if (r.error) return void (pre.textContent = r.error)
	if (!r.render_grid) return
	// Repaint only when the screen actually changed.
	//
	// This used to rebuild every node twice a second regardless, which quietly
	// destroyed any selection you had made — so copying a URL off a session was
	// impossible unless you could do it inside a two-second window. A terminal
	// nobody is typing into is identical poll after poll, which is exactly when
	// somebody is trying to select something out of it.
	const sig = JSON.stringify(r.render_grid.row_spans)
	if (sig === lastSig && pre.childElementCount) return
	lastSig = sig
	paint(pre, r.render_grid)
}

type Style = { foreground?: string; background?: string; bold?: boolean; faint?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; inverse?: boolean; invisible?: boolean; id: number }
type Span = { row: number; column: number; style_id: number; text: string }
type Grid = { rows: number; columns: number; styles: Style[]; row_spans: Span[]; terminal_foreground?: string; terminal_background?: string }

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

function paint(pre: HTMLElement, g: Grid) {
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
	el.style.maxWidth = ''
	el.style.marginInline = ''
	const advance = advanceRatio(pre)
	const usable = Math.max(200, pre.clientWidth - PAD)
	const exact = Math.min(COMFORTABLE, usable / (g.columns * advance))
	// Reflowing is only on the table when the grid cannot fit legibly, which on
	// every desktop width is never — so this branch is, in practice, the phone.
	const cramped = exact < LEGIBLE
	const reflow = wrap && cramped
	const btn = document.getElementById('screenmode')
	if (btn) btn.hidden = !cramped
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
	const headerH = document.getElementById('bar')?.getBoundingClientRect().height ?? 0
	const above = (el.firstElementChild?.getBoundingClientRect().height ?? 0) + headerH
	const below = el.lastElementChild?.getBoundingClientRect().height ?? 0
	pre.style.maxHeight = `${Math.max(200, window.innerHeight - above - below - 24)}px`
	const needed = Math.ceil(g.columns * advance * size) + PAD + 2
	if (needed < pre.clientWidth) {
		el.style.maxWidth = `${needed}px`
		el.style.marginInline = 'auto'
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
			const el = document.createElement('span')
			// inverse swaps them, which is how a selected row or a cursor is drawn
			const fg = st?.inverse ? (st?.background ?? g.terminal_background) : st?.foreground
			const bg = st?.inverse ? (st?.foreground ?? g.terminal_foreground) : st?.background
			if (fg) el.style.color = fg
			if (bg && bg !== g.terminal_background) el.style.background = bg
			if (st?.bold) el.style.fontWeight = '700'
			if (st?.faint) el.style.opacity = '0.7'
			if (st?.italic) el.style.fontStyle = 'italic'
			if (st?.underline || st?.strikethrough) el.style.textDecoration = `${st.underline ? 'underline' : ''} ${st.strikethrough ? 'line-through' : ''}`.trim()
			if (st?.invisible) el.style.visibility = 'hidden'
			// A divider is one character repeated across the whole terminal, and
			// reflowed it becomes four wrapped lines of dashes where the terminal drew
			// one — so a rule is clipped to the width instead of wrapped. It reads as
			// the line it was meant to be, and costs one row rather than four.
			if (reflow && RULE.test(sp.text)) el.style.cssText += ';display:inline-block;width:100%;white-space:nowrap;overflow:hidden;vertical-align:bottom'
			// nodes, never innerHTML: this is whatever the terminal is showing, and it
			// must not be able to become markup
			fill(el, sp.text)
			line.append(el)
			col = sp.column + [...sp.text].length
		}
		if (!spans.length) line.append('\u00a0')
		out.push(line)
	}
	pre.replaceChildren(...out)
	if (atBottom) pre.scrollTop = pre.scrollHeight
}

/** Open the terminal for a session. */
export function show(id: string, name: string) {
	openId = id
	openName = name
	el.hidden = false
	if (!token()) return askForToken('This is behind a separate password from the passcode.')
	const { input } = chrome(name)
	refresh()
	clearInterval(timer)
	timer = setInterval(refresh, 2000)
	input.focus()
}

export function close() {
	openId = null
	clearInterval(timer)
	timer = 0
	el.hidden = true
	el.innerHTML = ''
	el.style.maxWidth = ''
	el.style.marginInline = ''
	onClose()
}

export function mountTerminal(host: HTMLElement, closed: () => void) {
	el = host
	onClose = closed
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && openId) close()
	})
}

export const isOpen = () => openId !== null

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
const KEY = 'guildhall.control'

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
	el.innerHTML = ''
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
	const bar = document.createElement('div')
	bar.className = 'flex items-center gap-2 border-b border-line px-3 py-2'
	const title = document.createElement('span')
	title.className = 'font-bold text-label'
	title.textContent = name
	const live = document.createElement('span')
	live.className = 'text-[0.72rem] text-faint'
	live.textContent = 'live terminal'
	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕'
	x.className = 'ml-auto cursor-pointer rounded border-0 bg-transparent px-1 text-faint hover:text-label'
	x.addEventListener('click', close)
	bar.append(title, live, x)

	const pre = document.createElement('pre')
	pre.id = 'screen'
	// the screen is preformatted terminal output: never innerHTML, and it scrolls
	// inside its own box so a long scrollback cannot stretch the page
	// A terminal is a fixed grid and must not reflow, so it scrolls sideways.
	// The type is sized from the real column count in paint(), because a terminal
	// you have to scroll horizontally to read one line of is barely a terminal.
	pre.className = 'm-0 max-h-[60vh] overflow-auto px-3 py-2 whitespace-pre'
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
	if (r.render_grid) paint(pre, r.render_grid)
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
	// 0.6 is the advance-to-size ratio of this monospace stack.
	const usable = Math.max(200, pre.clientWidth - 24)
	const size = Math.max(6, Math.min(13, usable / (g.columns * 0.6)))
	pre.style.fontSize = `${size.toFixed(2)}px`
	pre.style.lineHeight = '1.25'

	const out: HTMLElement[] = []
	for (let r = 0; r < g.rows; r++) {
		const line = document.createElement('div')
		const spans = (rows.get(r) ?? []).sort((a, b) => a.column - b.column)
		let col = 0
		for (const sp of spans) {
			if (sp.column > col) line.append(' '.repeat(sp.column - col))
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
			// textContent, never innerHTML: this is whatever the terminal is showing
			el.textContent = sp.text
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

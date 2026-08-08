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
	return { status: res.status, ...body } as { status: number; text?: string; error?: string; ok?: boolean }
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
	pre.className = 'm-0 max-h-[60vh] overflow-auto px-3 py-2 text-[0.72rem]/[1.35] whitespace-pre text-label'
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
	const r = await api(`/api/screen?id=${encodeURIComponent(openId)}&lines=200`)
	if (r.status === 401) return askForToken('That password was not accepted.')
	if (r.status === 403) return askForToken('Control is off, or this device is not on the machine or its tailnet.')
	if (r.status === 429) return askForToken('Too many wrong tries — wait a moment.')
	const pre = document.getElementById('screen')
	if (!pre) return
	if (r.error) pre.textContent = r.error
	else if (typeof r.text === 'string') {
		const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24
		pre.textContent = r.text
		// only follow if you were already at the bottom, so reading scrollback is
		// not yanked away every two seconds
		if (atBottom) pre.scrollTop = pre.scrollHeight
	}
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

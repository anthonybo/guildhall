/**
 * Starting a session from away.
 *
 * The case this exists for: an idea arrives when you are nowhere near the
 * machine, and the only way to act on it was to remember it until you were.
 *
 * Deliberately NOT a prompt box. Tapping a project starts an empty session and
 * opens its terminal, and you type the idea in there — the same guarded path
 * every other message takes. That is worth the extra tap twice over: nothing new
 * can write to a session, and Claude Code names the session from the first
 * message exactly as it always does, so the row titles itself a moment later
 * without this needing to know anything about naming.
 *
 * Gated on the control password like typing, because starting a session is
 * strictly more powerful than typing into one.
 */
import { tap } from './dom.ts'
import { lockPage, unlockPage } from './viewport.ts'

const KEY = 'guildhall.control'
const token = () => sessionStorage.getItem(KEY) ?? ''

type Project = { dir: string; label: string; live: boolean }

let el: HTMLElement
let onPick: (dir: string) => void = () => {}
let open = false

export function mountNewSession(host: HTMLElement, picked: (dir: string) => void) {
	el = host
	onPick = picked
}

export const isOpen = () => open

export function close() {
	open = false
	el.hidden = true
	el.replaceChildren()
	unlockPage('newsession')
}

function bar(title: string) {
	const b = document.createElement('div')
	b.className = 'flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2'
	const h = document.createElement('span')
	h.className = 'font-bold text-label'
	h.textContent = title
	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕ Close'
	x.className = 'ml-auto flex min-h-11 shrink-0 cursor-pointer items-center rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot'
	// `tap`, not a click listener: a click is only delivered if press and release
	// land on the same element, and closing this reveals the session list beneath —
	// so the synthesised click has to be swallowed or it opens whichever row happens
	// to be under the finger. Exactly the bug the terminal's Close had.
	tap(x, close)
	b.append(h, x)
	return b
}

function say(host: HTMLElement, text: string, tone = 'text-faint') {
	const p = document.createElement('p')
	p.className = `m-0 px-3 py-3 text-[0.82rem]/[1.5] ${tone}`
	p.textContent = text
	host.append(p)
}

/**
 * Ask for the control password HERE, rather than sending someone elsewhere.
 *
 * The first version of this printed "open a session terminal once to enter it,
 * then come back", which is a strange thing to ask and worse than it sounds: this
 * panel sits above the terminal in the stacking order, so following the
 * instruction meant closing this, finding a row, opening its terminal, entering
 * the password there, closing that, and starting again. A panel that needs a
 * credential should collect it.
 */
function askHere(body: HTMLElement) {
	body.replaceChildren()
	const wrap = document.createElement('div')
	wrap.className = 'p-4'
	const h = document.createElement('p')
	h.className = 'mt-0 mb-2 text-label'
	h.textContent = 'Control password'
	const why = document.createElement('p')
	why.className = 'mt-0 mb-3 text-[0.78rem]/[1.45] text-faint'
	// Say where it comes from: it is read off the machine, never sent to you.
	why.textContent = 'Starting a session needs the password you set on the machine running guildhall — press ? there, then c.'
	const input = document.createElement('input')
	input.type = 'password'
	input.autocomplete = 'off'
	input.spellcheck = false
	input.placeholder = 'the password you set'
	// 16px, or iOS zooms the page the moment this is tapped.
	input.className = 'min-h-11 w-full rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label'
	const go = document.createElement('button')
	go.type = 'button'
	go.textContent = 'Unlock'
	go.className = 'mt-2 min-h-11 cursor-pointer rounded border border-gold bg-gold px-3 font-bold text-bg'
	const submit = () => {
		const v = input.value.trim()
		if (!v) return
		sessionStorage.setItem(KEY, v)
		show()
	}
	go.addEventListener('click', submit)
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') submit()
	})
	wrap.append(h, why, input, go)
	body.append(wrap)
	input.focus()
}

export async function show() {
	open = true
	el.hidden = false
	lockPage('newsession')
	el.replaceChildren(bar('Start a session'))
	const body = document.createElement('div')
	body.className = 'min-h-0 flex-1 overflow-auto overscroll-contain'
	el.append(body)
	say(body, 'Loading projects…')

	let projects: Project[] = []
	try {
		const res = await fetch('/api/projects', { headers: { 'x-guildhall-control': token() }, signal: AbortSignal.timeout(15_000) })
		if (res.status === 403) {
			body.replaceChildren()
			say(body, 'Control is off, or this device is not on the machine or its tailnet.', 'text-gold')
			return
		}
		if (res.status === 401) return askHere(body)
		projects = (await res.json()).projects ?? []
	} catch {
		body.replaceChildren()
		say(body, 'Could not reach guildhall.', 'text-hot')
		return
	}

	body.replaceChildren()
	if (!projects.length) return void say(body, 'No projects found to start in.')
	say(body, 'Pick where it runs. The session opens empty — type your idea into it and it will name itself.')

	const list = document.createElement('ul')
	list.className = 'm-0 list-none p-0'
	for (const p of projects) {
		const li = document.createElement('li')
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'flex min-h-12 w-full cursor-pointer items-center gap-2 border-0 border-b border-line bg-transparent px-3 text-left text-[0.86rem] text-label hover:bg-line/40'
		const name = document.createElement('span')
		name.className = 'truncate'
		name.textContent = p.label
		b.append(name)
		if (p.live) {
			// Worth saying: starting a second session somewhere already busy is
			// legitimate but rarely what you meant from a phone.
			const t = document.createElement('span')
			t.className = 'ml-auto shrink-0 text-[0.72rem] text-faint'
			t.textContent = 'already running'
			b.append(t)
		}
		b.addEventListener('click', () => start(p, body, b))
		li.append(b)
		list.append(li)
	}
	body.append(list)
}

async function start(p: Project, body: HTMLElement, btn: HTMLButtonElement) {
	btn.disabled = true
	const was = btn.textContent
	btn.textContent = `Starting in ${p.label}…`
	try {
		const res = await fetch('/api/spawn', {
			method: 'POST',
			headers: { 'x-guildhall-control': token(), 'content-type': 'application/json' },
			body: JSON.stringify({ dir: p.dir }),
			// Starting a session runs `claude`, which is slower than a send; the server
			// also waits to see whether a trust prompt came up before answering.
			signal: AbortSignal.timeout(30_000),
		})
		const out = await res.json().catch(() => ({ error: 'unreadable reply' }))
		if (out.error) {
			btn.disabled = false
			btn.textContent = was
			body.querySelectorAll('[data-note]').forEach((n) => n.remove())
			const n = document.createElement('p')
			n.dataset.note = '1'
			n.className = 'm-0 border-t border-hot/40 bg-hot/10 px-3 py-2 text-[0.8rem]/[1.45] text-hot'
			n.textContent = out.error
			body.prepend(n)
			return
		}
		close()
		// The row appears on the next feed tick; the caller opens its terminal once
		// it does, so the idea can go straight in.
		onPick(p.dir)
	} catch {
		btn.disabled = false
		btn.textContent = was
	}
}

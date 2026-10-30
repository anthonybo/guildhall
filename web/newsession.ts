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
import { COVERED, lockPage, unlockPage } from './viewport.ts'
import { dropEscape, holdEscape, typing } from './escape.ts'

const KEY = 'guildhall.control'
const token = () => sessionStorage.getItem(KEY) ?? ''

type Project = { dir: string; label: string; live: boolean }
/** A session with a transcript and no process — see src/data/closed.ts. */
type Closed = { id: string; cwd: string; proj: string; at: number; title: string }

/** "3m", "4h", "6d" — the same shape the table uses, so one glance reads the same way. */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.round(s / 60)}m`
	if (s < 86_400) return `${Math.round(s / 3600)}h`
	return `${Math.round(s / 86_400)}d`
}

let el: HTMLElement
let onPick: (dir: string) => void = () => {}
let open = false

export function mountNewSession(host: HTMLElement, picked: (dir: string) => void) {
	el = host
	onPick = picked
	// A terminal opening — from the keyboard, or a session started here coming up — goes
	// on top: this drawer is z-7 and would otherwise sit over it. See COVERED.
	document.addEventListener(COVERED, () => {
		if (open) close()
	})
}

export const isOpen = () => open

/** What had focus before this opened, handed back when it closes. */
let returnFocus: HTMLElement | null = null

export function close() {
	open = false
	el.hidden = true
	el.replaceChildren()
	unlockPage('newsession')
	dropEscape('newsession')
	if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true })
	returnFocus = null
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
	if (!open && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
	open = true
	el.hidden = false
	lockPage('newsession')
	// Esc closes it while it is the top thing open — see escape.ts. It had no Esc at
	// all: its ✕ was the only way out. Not while its password or new-project box has
	// text in it, which Esc on reflex would throw away.
	holdEscape('newsession', () => {
		if (typing()) return false
		close()
		return true
	})
	// "Open", not "Start": this panel now leads with the sessions you closed, and a heading
	// that only promises a new one is how a feature ends up shipped and unfindable.
	el.replaceChildren(bar('Open a session'))
	// Into the drawer, so a keyboard is where the eye is: its Close, the one control that
	// exists before the list arrives.
	el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
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

	/**
	 * The sessions you closed, offered FIRST.
	 *
	 * Closing a session on the machine used to mean losing the way back to it from
	 * anywhere else: this panel could only start an empty one, which is a different thing
	 * and drops the conversation. Reopening is the more likely intent of the two — you
	 * closed it to free the machine up, not to be done with it — so it goes at the top.
	 *
	 * Fetched separately and allowed to fail on its own: a broken transcript should not
	 * take the "start something new" list down with it.
	 */
	let closed: Closed[] = []
	let closedWhy = ''
	try {
		const res = await fetch('/api/closed', { headers: { 'x-guildhall-control': token() }, signal: AbortSignal.timeout(15_000) })
		if (res.ok) closed = (await res.json()).closed ?? []
		// A SERVER THAT PREDATES THIS FEATURE, said out loud.
		//
		// This was a bare `catch {}`, and the result was indistinguishable from having no
		// closed sessions: the panel rendered the project list and nothing hinted that half
		// of it was missing. The browser talks to whichever guildhall is serving the port,
		// and that process is not restarted by rebuilding — measured, a server three hours
		// older than the build was answering 404 here and the panel just looked unchanged.
		else if (res.status === 404) closedWhy = 'This guildhall is older than the app — restart it to reopen closed sessions.'
		else closedWhy = `Could not list closed sessions (${res.status}).`
	} catch {
		closedWhy = 'Could not list closed sessions.'
	}

	body.replaceChildren()
	body.append(newProject(body))
	if (closedWhy) say(body, closedWhy, 'text-gold')

	if (closed.length) {
		say(body, 'Reopen one you closed. It picks up the same conversation, where it left off.')
		const back = document.createElement('ul')
		back.className = 'm-0 list-none p-0'
		/**
		 * The most recent few, and the rest behind a tap.
		 *
		 * Every closed session in the last month was listed, at two lines each — twelve of
		 * them filled a phone screen, and the projects to start in sat below the fold. That
		 * was reported as "it only has resume": starting something new looked missing.
		 */
		const SHOWN = 3
		const rest: HTMLLIElement[] = []
		for (const [i, c] of closed.entries()) {
			const li = document.createElement('li')
			const b = document.createElement('button')
			b.type = 'button'
			b.className = 'flex min-h-12 w-full cursor-pointer flex-col items-start justify-center gap-0.5 border-0 border-b border-line bg-transparent px-3 py-2 text-left hover:bg-line/40'
			const top = document.createElement('span')
			top.className = 'flex w-full items-baseline gap-2'
			const name = document.createElement('span')
			name.className = 'shrink-0 text-[0.86rem] text-label'
			name.textContent = c.proj
			const when = document.createElement('span')
			when.className = 'ml-auto shrink-0 text-[0.72rem] text-faint'
			when.textContent = ago(Date.now() - c.at)
			top.append(name, when)
			// The opening prompt is what tells one closed session from another — a project
			// name alone does not, because several of them share one.
			const what = document.createElement('span')
			what.className = 'line-clamp-2 w-full text-[0.76rem]/[1.35] text-faint'
			what.textContent = c.title
			b.append(top, what)
			b.addEventListener('click', () => start({ dir: c.cwd, label: c.proj, live: false }, body, b, c.id))
			li.append(b)
			li.hidden = i >= SHOWN
			if (li.hidden) rest.push(li)
			back.append(li)
		}
		if (rest.length) {
			const li = document.createElement('li')
			const more = document.createElement('button')
			more.type = 'button'
			more.className = 'min-h-11 w-full cursor-pointer border-0 border-b border-line bg-transparent px-3 text-left text-[0.8rem] text-muted hover:bg-line/40'
			more.textContent = `Show ${rest.length} more closed`
			more.addEventListener('click', () => {
				for (const r of rest) r.hidden = false
				li.remove()
			})
			li.append(more)
			back.append(li)
		}
		body.append(back)
	}

	if (!projects.length) return
	say(body, 'Or start a session in a project you have. It opens empty — type your idea into it and it will name itself.')

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

/** A red line at the top of the panel saying why something did not start. */
function fail(body: HTMLElement, text: string) {
	body.querySelectorAll('[data-note]').forEach((n) => n.remove())
	const n = document.createElement('p')
	n.dataset.note = '1'
	n.className = 'm-0 border-t border-hot/40 bg-hot/10 px-3 py-2 text-[0.8rem]/[1.45] text-hot'
	n.textContent = text
	body.prepend(n)
}

/**
 * A brand-new project: a name, and the server makes `~/projects/<name>`, runs
 * `git init`, and opens Claude Code in it — answering the "do you trust this folder"
 * question itself, since it made the folder (see trustNew in src/control.ts).
 *
 * First in the panel because it is the one thing here with no other way to do it
 * from a phone: every other row needs the folder to exist already.
 */
function newProject(body: HTMLElement) {
	const form = document.createElement('form')
	form.className = 'flex gap-2 border-b border-line p-3'
	const input = document.createElement('input')
	input.placeholder = 'new project name'
	input.autocomplete = 'off'
	input.autocapitalize = 'off'
	input.spellcheck = false
	input.enterKeyHint = 'go'
	// 16px, or iOS zooms the page the moment this is tapped; `min-w-0`, or the button
	// is pushed off the edge (see the message box in terminal.ts).
	input.className = 'min-h-11 w-0 min-w-0 flex-1 rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label'
	const go = document.createElement('button')
	go.type = 'submit'
	go.textContent = 'Create'
	go.className = 'min-h-11 shrink-0 cursor-pointer rounded border border-gold bg-gold px-4 text-[15px] font-bold text-bg'
	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		const name = input.value.trim()
		if (!name || go.disabled) return
		go.disabled = true
		go.textContent = 'Creating…'
		try {
			const res = await fetch('/api/spawn', {
				method: 'POST',
				headers: { 'x-guildhall-control': token(), 'content-type': 'application/json' },
				body: JSON.stringify({ create: name }),
				signal: AbortSignal.timeout(30_000),
			})
			const out = await res.json().catch(() => ({ error: 'unreadable reply' }))
			if (out.error) return fail(body, out.error)
			close()
			onPick(out.dir)
		} catch {
			fail(body, 'Could not reach guildhall.')
		} finally {
			go.disabled = false
			go.textContent = 'Create'
		}
	})
	form.append(input, go)
	return form
}

async function start(p: Project, body: HTMLElement, btn: HTMLButtonElement, resume?: string) {
	btn.disabled = true
	const was = btn.textContent
	// `replaceChildren` rather than `textContent`, because a reopen button holds two lines
	// and assigning text would collapse them into one before the request even returns.
	btn.replaceChildren()
	btn.textContent = resume ? `Reopening ${p.label}…` : `Starting in ${p.label}…`
	try {
		const res = await fetch('/api/spawn', {
			method: 'POST',
			headers: { 'x-guildhall-control': token(), 'content-type': 'application/json' },
			body: JSON.stringify(resume ? { dir: p.dir, resume } : { dir: p.dir }),
			// Starting a session runs `claude`, which is slower than a send; the server
			// also waits to see whether a trust prompt came up before answering.
			signal: AbortSignal.timeout(30_000),
		})
		const out = await res.json().catch(() => ({ error: 'unreadable reply' }))
		if (out.error) {
			btn.disabled = false
			btn.textContent = was
			return fail(body, out.error)
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

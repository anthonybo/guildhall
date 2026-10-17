/** The control password form, shown in the panel when the server refuses the token. */
import { titleBar } from './termbar.ts'
import { KEY, hooks, term } from './termstate.ts'
import { settle } from './viewport.ts'

/** Ask for the token. Only reached when the server says the current one is wrong. */
export function askForToken(why: string) {
	const el = term.el
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
	clearInterval(term.timer)
	term.timer = undefined
	el.innerHTML = ''
	// the panel was sized to a terminal; a password form is not one
	el.style.maxWidth = ''
	el.style.marginInline = ''
	// A way out, first.
	//
	// Full screen on a phone, this branch had no Close button at all — so a stale or
	// wrong token produced a password form filling the display with no exit but a
	// page reload. Same trap as the blank loading state, in a different branch, and
	// found only by opening it with a bad token rather than a good one.
	el.append(titleBar(term.openName, 'password needed'))
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
	// 16px here too — the rule applies to every input, and this is the first one a
	// phone ever meets. Fixing only the message box would have left the very first
	// tap zooming the page.
	input.className = 'min-h-11 w-full rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label'
	const go = document.createElement('button')
	go.type = 'button'
	go.textContent = 'Unlock'
	go.className = 'mt-2 cursor-pointer rounded border border-gold bg-gold px-3 py-1.5 font-bold text-bg'
	const submit = () => {
		sessionStorage.setItem(KEY, input.value.trim())
		if (term.openId) hooks.show(term.openId, term.openName)
	}
	go.addEventListener('click', submit)
	input.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
	// The message box re-measures around its keyboard and this one did not, so the
	// panel could stay keyboard-height after it went away — see `messageForm` in
	// termform.ts.
	for (const ev of ['focus', 'blur'] as const) input.addEventListener(ev, settle)
	wrap.append(h, p, input, go)
	el.append(wrap)
	input.focus()
}

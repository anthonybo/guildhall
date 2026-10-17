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
 *
 * This file opens, assembles and closes the panel. Its parts live beside it:
 * termstate.ts (what they share), termbar.ts, termpass.ts (the password form),
 * termform.ts (the message box and answer keys), slashmenu.ts and termpoll.ts.
 */
import { cellAt } from './grid.ts'
import { onCellTap, paneStrip } from './panes.ts'
import { screenBar } from './termbar.ts'
import { messageForm } from './termform.ts'
import { askForToken } from './termpass.ts'
import { refresh } from './termpoll.ts'
import { KEY, OPEN, type Seat, api, hooks, repaintSoon, term, token } from './termstate.ts'
import { fullScreen, lockPage, measure, settle, unlockPage, watch } from './viewport.ts'

/**
 * Freeze the page behind the panel — but only when the panel is covering it.
 *
 * Full screen on a phone, nothing behind should move: a flick past the end of the
 * scrollback would otherwise drag the session list around underneath, and on iOS
 * the browser scrolls the page on its own initiative whenever an input takes
 * focus, which is what put the terminal halfway down the screen.
 *
 * Above 880px the panel is INLINE — part of the page, below the list. Freezing
 * the page there strands it: on a 779px window the panel starts at y=717 and its
 * input sits at y=1377, off the bottom of a document that can no longer scroll.
 * The old `overflow: hidden` had the same effect and the same excuse; it is a
 * scroll lock for an overlay, and inline is not an overlay.
 */
function holdPage() {
	if (fullScreen()) lockPage('terminal')
	else unlockPage('terminal')
}

function chrome(name: string) {
	const el = term.el
	el.innerHTML = ''
	const bar = screenBar(name, refresh)

	const pre = document.createElement('pre')
	pre.id = 'screen'
	// the screen is preformatted terminal output: never innerHTML, and it scrolls
	// inside its own box so a tall screen cannot stretch the page
	// A terminal is a fixed grid and must not reflow, so it scrolls sideways.
	// Size and height are both set in paint(), from the real grid and the real
	// window, because a terminal you have to scroll to read one line of is barely
	// a terminal.
	// `min-h-0 flex-1` so the screen takes the space between the bar and the input
	// and nothing else — without it a flex child refuses to shrink below its content
	// and pushes the input off the bottom of the phone.
	// overscroll-contain stops a flick at the end of the scrollback from dragging the
	// page behind it, which is what makes a web view feel like a web page.
	pre.className = 'm-0 min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 whitespace-pre'
	pre.textContent = 'reading…'

	const { form, input, note, menu, keys } = messageForm(pre)

	// The rest of a split tab — see panes.ts. A different pane is a different screen, so
	// the change-guards are reset and it is read now rather than at the next tick.
	const seat = term.openId ? term.seatOf(term.openId) : undefined
	const strip = paneStrip(seat?.panes, seat?.surface, (surface) => {
		term.viewing = surface
		term.jump = surface ? 'top' : 'bottom'
		term.lastTag = ''
		term.lastSig = ''
		// Dimmed until the screen asked for is the one drawn (poll() lifts it), so the
		// chat staying up for a moment reads as loading rather than as being ignored.
		pre.classList.add('opacity-40')
		refresh()
	})
	// The prompt keys sit directly above the message box, where the thumb already is.
	// They were appended first, which put them ABOVE the title bar at the very top of
	// a phone — the farthest point from the box they are used alongside.
	// A tap on another pane's screen is a click in it — folding a backlog group, opening
	// an item. Never on the chat: there a tap is for reading and selecting.
	onCellTap(pre, async (x, y) => {
		const cell = term.viewing && term.openId ? cellAt(pre, x, y) : null
		if (!cell || !term.viewing || !term.openId) return
		// Shown at once, before anything goes over the network: the row tapped lights up,
		// so a tap is visibly taken even while the screen catches up. The next repaint
		// replaces the row and the mark with it.
		const row = pre.querySelector<HTMLElement>(`[data-row="${cell.row}"]`)
		if (row) row.style.background = 'rgb(255 214 92 / 22%)'
		const r = await api('/api/click', { method: 'POST', body: JSON.stringify({ id: term.openId, pane: term.viewing, ...cell }) })
		note.textContent = r.error ?? ''
		note.hidden = !r.error
		// Read the result now. The TUI redraws within a moment of the click, and a read
		// already in flight queues this one rather than dropping it (see refresh).
		term.lastTag = ''
		refresh()
		setTimeout(refresh, 250)
	})
	el.append(...(strip ? [bar, strip] : [bar]), pre, note, menu, keys, form)
	return { pre, input }
}

/** Open the terminal for a session. */
export function show(id: string, name: string) {
	term.openId = id
	term.openName = name
	// Always the chat on opening, whatever was being looked at last time.
	term.viewing = null
	term.jump = 'bottom'
	try {
		sessionStorage.setItem(OPEN, JSON.stringify({ id, name }))
	} catch {
		// Not remembered across a reload; nothing else depends on it.
	}
	term.el.hidden = false
	holdPage()
	// Sized BEFORE the branch, not after: the password form is full screen too, and
	// putting this after the early return left that state anchored to the layout
	// viewport — the one state where you most need the input to be reachable.
	measure()
	if (!token()) return askForToken('This is behind a separate password from the passcode.')
	const { input } = chrome(name)
	refresh()
	clearInterval(term.timer)
	term.timer = setInterval(refresh, 2000)
	// Deliberately NOT focused on a phone. Focusing raises the keyboard immediately,
	// so opening a terminal to read what a session said would cost half the screen
	// before you had read a word of it. Tap the box when you actually want to type.
	if (!fullScreen()) input.focus()
}

export function close() {
	const el = term.el
	term.openId = null
	term.lastTag = ''
	try {
		sessionStorage.removeItem(OPEN)
	} catch {
		// see show()
	}
	clearInterval(term.timer)
	term.timer = undefined
	el.hidden = true
	el.innerHTML = ''
	el.style.maxWidth = ''
	el.style.marginInline = ''
	// hand the inline layout its sizing back, or a desktop panel keeps a phone's height
	el.style.height = ''
	el.style.top = ''
	el.style.bottom = ''
	// and the keyboard offset, or the panel reopens shifted down the screen with its
	// hit region somewhere else again
	el.style.transform = ''
	unlockPage('terminal')
	term.onClose()
}

hooks.show = show
hooks.close = close

export function mountTerminal(host: HTMLElement, closed: () => void, seat?: (id: string) => Seat | undefined) {
	term.el = host
	term.onClose = closed
	if (seat) term.seatOf = seat
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape' || !term.openId) return
		// Not while typing into a box with something in it. Esc is what clears or backs
		// out in a terminal, and Claude Code users press it on reflex; closing the whole
		// panel on it threw the message away. Empty the box, or click away, then Esc.
		const t = e.target
		if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value) return
		close()
	})
	watch(host, isOpen)
	// A rotation changes the width the type is sized from, and the grid does not
	// change at all — so without this the screen keeps the old size until the session
	// happens to print. Debounced because a rotation fires this repeatedly.
	let t: ReturnType<typeof setTimeout> | undefined
	addEventListener('resize', () => {
		if (!term.openId) return
		// A window dragged across 880px turns an overlay into an inline panel and back,
		// so the hold has to be re-decided rather than kept from whichever side it was
		// opened on — otherwise widening the window leaves the page frozen with a panel
		// sitting in it that is no longer covering anything.
		holdPage()
		settle()
		clearTimeout(t)
		t = setTimeout(() => {
			repaintSoon()
			refresh()
		}, 120)
	})
}

/**
 * The control grant, and one way to send with it.
 *
 * Exported because a Codex session has no terminal panel — it is not a cmux pane — so
 * the list needs to send without one. What it must NOT do is keep its own copy of the
 * password or its own fetch: one storage key, one deadline, one place that knows the
 * header's name. `api()` already carries the 20-second deadline, and a fetch without
 * one never settles on a phone changing networks.
 */
export const hasControl = () => token() !== ''
export const setControl = (v: string) => sessionStorage.setItem(KEY, v.trim())

/** Type into a session that has no panel to type into. */
export async function sendTo(id: string, text: string) {
	return api('/api/send', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id, text }),
	})
}

export const isOpen = () => term.openId !== null

/**
 * The panel that was open when the page last unloaded, if any.
 *
 * The page reloads itself when a new build lands, and does so the moment the box is
 * empty — which is right after a send. That closed the terminal you were working in,
 * from your point of view for no reason: "kicked out after sending". Read once.
 */
export function wasOpen(): { id: string; name: string } | null {
	try {
		const v = JSON.parse(sessionStorage.getItem(OPEN) ?? 'null') as { id?: unknown; name?: unknown } | null
		return v && typeof v.id === 'string' && typeof v.name === 'string' ? { id: v.id, name: v.name } : null
	} catch {
		return null
	}
}

/**
 * Whether reloading the page right now would throw away something you cannot get
 * back: a half-typed message, or a send still in the air.
 *
 * The page reloads itself when a new build lands, and that was suppressed for the
 * whole time this panel was open. The reasoning was that a reload costs the
 * control token — it does not, that lives in sessionStorage and survives — and
 * what it actually costs is whatever you had typed. So the guard is narrowed to
 * exactly that.
 *
 * The trap this closes is a nasty one: a terminal you cannot close is a terminal
 * that blocks the update containing the fix for not being able to close it. Being
 * stuck was itself what kept you stuck.
 */
export const busy = () => {
	if (!term.openId) return false
	if (term.sending) return true
	return !!(document.getElementById('ask') as HTMLInputElement | null)?.value.trim()
}

/** Reading the open session's screen, and the four answer keys that change it. */
import { paint } from './grid.ts'
import { askForToken } from './termpass.ts'
import { picture } from './termimages.ts'
import { api, term } from './termstate.ts'
import { fullScreen } from './viewport.ts'

/**
 * Press one of the four answer keys in the open session.
 *
 * Repaints immediately afterwards rather than waiting for the poll: moving a
 * caret and not seeing it move for two seconds reads as a dead button, and this
 * is the one control whose whole value is the feedback.
 */
export async function sendKey(key: string, pre: HTMLElement) {
	if (!term.openId) return
	const r = await api('/api/key', { method: 'POST', body: JSON.stringify({ id: term.openId, key }) })
	if (r.error) {
		pre.textContent = `${r.error}\n\n${pre.textContent}`
		return
	}
	// NO forced repaint here, and that was the bug.
	//
	// This called `repaintSoon()`, which throws away the ETag as well as the paint
	// signature — so every key press refetched the whole 68KB screen and rebuilt
	// every node in it, whether or not anything had moved. On a phone that reads as
	// the view tearing itself down and building itself again, which is exactly what
	// it is.
	//
	// Nothing needs forcing. Moving a caret CHANGES the screen, so the conditional
	// request returns new content on its own and paints once; if the key did
	// nothing, the server answers 304 and the view holds still — which is the
	// honest outcome and much better feedback than a flash either way.
	//
	// The short wait is for the TUI to redraw before we look. Without it the poll
	// races the terminal and fetches the frame from before the keypress.
	await new Promise((r) => setTimeout(r, 120))
	// And wait for any poll already in flight, rather than giving up.
	//
	// `refresh` returns immediately if one is running — right for a timer, wrong
	// here: a key pressed while a poll was out would show nothing until the next
	// tick two seconds later, which is indistinguishable from a key that did not
	// work. Bounded, so a stuck request cannot hold this open.
	for (let i = 0; term.polling && i < 12; i++) await new Promise((r) => setTimeout(r, 100))
	refresh()
}

export async function refresh() {
	if (!term.openId || term.sending) return
	// Queued, not dropped. A refresh asked for mid-read — after switching to another pane,
	// or after tapping one — used to return here and wait for the next two-second tick,
	// and the read already in flight was for the OLD screen. Measured as the panel
	// showing the chat for seconds after Backlog was pressed.
	if (term.polling) return void (term.again = true)
	term.polling = true
	try {
		do {
			term.again = false
			await poll()
		} while (term.again && term.openId)
	} finally {
		term.polling = false
	}
}

async function poll() {
	if (!term.openId) return
	const want = term.viewing
	const pane = want ? `&pane=${encodeURIComponent(want)}` : ''
	const r = await api(`/api/screen?id=${encodeURIComponent(term.openId)}${pane}`, term.lastTag ? { headers: { 'if-none-match': term.lastTag } } : {})
	// The pane was switched while this was in the air: it is the wrong screen. Dropped,
	// and the queued read (see refresh) fetches the right one. Its tag is dropped too, or
	// the next read would be answered "unchanged" against a screen never shown.
	if (want !== term.viewing) return void (term.lastTag = '')
	document.getElementById('screen')?.classList.remove('opacity-40')
	// Nothing has changed, so there is nothing to draw and nothing was sent.
	if (r.status === 304) return
	if (r.status === 401) return askForToken('That password was not accepted.')
	if (r.status === 403) return askForToken('Control is off, or this device is not on the machine or its tailnet.')
	if (r.status === 429) return askForToken('Too many wrong tries — wait a moment.')
	const pre = document.getElementById('screen')
	if (!pre) return
	// The tag is forgotten with the screen. Kept, the next read asked "changed since the
	// last screen?", the answer was a truthful 304, and the error stayed up over a
	// session that had long since recovered — until the chat was closed and reopened.
	if (r.error) {
		term.lastTag = ''
		term.lastSig = ''
		pre.textContent = r.error
		return
	}
	if (!r.render_grid) return
	// Repaint only when the screen actually changed.
	//
	// This used to rebuild every node twice a second regardless, which quietly
	// destroyed any selection you had made — so copying a URL off a session was
	// impossible unless you could do it inside a two-second window. A terminal
	// nobody is typing into is identical poll after poll, which is exactly when
	// somebody is trying to select something out of it.
	const sig = JSON.stringify(r.render_grid.row_spans)
	if (sig === term.lastSig && pre.childElementCount) return
	term.lastSig = sig
	// The mode button is revealed from the measurement rather than from a
	// breakpoint, so it appears exactly when it would do something — see paint().
	const btn = document.getElementById('screenmode')
	// Joining lines to fit the width (reflow.ts) is for the session's own pane on a
	// desktop: never a backlog or other pane beside it, whose layout is its own, and never
	// a phone, whose view is left exactly as it was.
	const fit = !term.viewing && !fullScreen()
	const cramped = paint(pre, r.render_grid, term.wrap, picture, fit)
	if (btn) btn.hidden = !cramped
	if (term.jump) {
		pre.scrollTop = term.jump === 'top' ? 0 : pre.scrollHeight
		term.jump = null
	}
}

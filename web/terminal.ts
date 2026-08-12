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
import { type Grid, paint } from './grid.ts'
import { fullScreen, lockPage, measure, settle, unlockPage, watch } from './viewport.ts'

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

/**
 * Force the next poll to redraw even if the session has printed nothing.
 *
 * The repaint guard compares the grid, which is right for "has the session
 * changed" and wrong for everything else, because `paint()` is also the only thing
 * that applies the LAYOUT — type size, wrapping, height. Two cases were broken in
 * the dangerous direction and both are exactly the phone-reading-an-idle-session
 * case the guard was built for:
 *
 *  - Wrapped/Exact did nothing on a quiet screen. The button relabelled itself and
 *    the text did not reflow until the session next printed.
 *  - Rotating the phone never resized the type. Before the guard the 2s poll fixed
 *    it within two seconds; after, it waited for output that may never come.
 */
function repaintSoon() {
	lastSig = ''
	// The ETag has to go too, or the conditional request reintroduces exactly the
	// bug this function exists to prevent, one layer further out. `lastSig` only
	// gets consulted if a body arrives, and an unchanged screen no longer sends
	// one — so on an idle session the server would answer 304, `poll()` would
	// return before `paint()`, and Wrapped/Exact and rotation would go back to
	// doing nothing until the session next printed. Forcing a repaint means asking
	// for the bytes to repaint FROM.
	lastTag = ''
}

let openId: string | null = null
let openName = ''
let timer = 0
let el: HTMLElement
let onClose = () => {}

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

const token = () => sessionStorage.getItem(KEY) ?? ''

/** The last screen's ETag, so an unchanged one is answered with 304 and no body.
 *  Cleared when the panel closes, or reopening a session would ask about the
 *  screen it was showing last time and be told, correctly, that nothing changed —
 *  while the panel sat empty. */
let lastTag = ''

async function api(path: string, init: RequestInit = {}) {
	// Every call gets a deadline. A fetch without one never settles — a phone
	// changing networks or a sleeping laptop leaves the promise pending forever, and
	// the send path awaits it with the button disabled, so the button stays dead and
	// pressing it "does nothing" for the rest of the session.
	try {
		const res = await fetch(path, { ...init, signal: AbortSignal.timeout(20_000), headers: { 'x-guildhall-control': token(), ...(init.headers ?? {}) } })
		// 304 has no body by definition, and asking for one gets "unreadable reply" —
		// an error message for the case where everything worked and nothing changed.
		if (res.status === 304) return { status: 304 }
		lastTag = res.headers.get('etag') ?? lastTag
		const body = await res.json().catch(() => ({ error: 'unreadable reply' }))
		return { status: res.status, ...body } as { status: number; render_grid?: Grid; error?: string; ok?: boolean; note?: string }
	} catch (e) {
		const timedOut = e instanceof DOMException && e.name === 'TimeoutError'
		return { status: 0, error: timedOut ? 'the machine did not answer in time' : 'could not reach guildhall' }
	}
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
	// A way out, first.
	//
	// Full screen on a phone, this branch had no Close button at all — so a stale or
	// wrong token produced a password form filling the display with no exit but a
	// page reload. Same trap as the blank loading state, in a different branch, and
	// found only by opening it with a bad token rather than a good one.
	el.append(titleBar(openName, 'password needed'))
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
		if (openId) show(openId, openName)
	}
	go.addEventListener('click', submit)
	input.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
	wrap.append(h, p, input, go)
	el.append(wrap)
	input.focus()
}

/**
 * Wire a button so a finger cannot miss it, whatever the layout does next.
 *
 * A `click` is only delivered if the press and the release land on the same
 * element — so anything that moves the button between them silently eats the tap,
 * and the panel is full of things that move it: the keyboard closing, the
 * viewport settling, a re-measure. That is a tap the person made, that the
 * browser correctly discarded, and it reads exactly like a dead button.
 *
 * On touch, act on `pointerdown` instead. It fires before any of that can happen,
 * and it bubbles to the panel's own re-measure AFTER this, so the press is
 * already banked by the time anything moves. Mouse and keyboard keep `click`,
 * where press-and-slide-off-to-cancel is a convention worth honouring and none of
 * this applies.
 */
function tap(el: HTMLElement, run: () => void) {
	let done = false
	const once = () => {
		if (done) return
		done = true
		run()
	}
	el.addEventListener('pointerdown', (e) => {
		const pe = e as PointerEvent
		if (pe.pointerType !== 'touch') return
		// Acting on the press means this panel is GONE before the finger lifts, so the
		// click that follows is delivered to whatever is underneath by then. Under
		// Close is the page header, where the pressroom button sits at very nearly the
		// same place — so closing the terminal opened pressroom, every time.
		//
		// Cancelling the press suppresses the compatibility mouse events it would
		// otherwise synthesise, which is the documented way to stop that click.
		pe.preventDefault()
		eatNextClick()
		once()
	})
	el.addEventListener('click', once)
}

/**
 * Swallow one click, if the browser sends it anyway.
 *
 * Belt and braces behind `preventDefault` above: not every engine agrees about
 * which compatibility events a cancelled `pointerdown` suppresses, and the cost of
 * being wrong is a button the person never aimed at. Capture phase, so it is taken
 * before it reaches whatever is now under the finger.
 *
 * Short-lived on purpose. The synthesised click follows the press within a few
 * hundred milliseconds or never comes at all, and a listener left armed longer
 * than that would eventually eat a tap somebody meant.
 */
function eatNextClick() {
	const eat = (e: Event) => {
		e.stopPropagation()
		e.preventDefault()
	}
	addEventListener('click', eat, { capture: true, once: true })
	setTimeout(() => removeEventListener('click', eat, { capture: true }), 400)
}

/**
 * The bar every state of this panel wears, including the ones that are not a
 * terminal.
 *
 * Extracted because the password branch did not have one, and full screen on a
 * phone that meant no way out. Any state this panel can be in has to carry its own
 * exit — that is the rule the missing cases kept breaking.
 */
function titleBar(name: string, subtitle: string) {
	const bar = document.createElement('div')
	bar.className = 'flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2'
	const title = document.createElement('span')
	title.className = 'truncate font-bold text-label'
	title.textContent = name
	const live = document.createElement('span')
	live.className = 'shrink-0 text-[0.72rem] text-faint'
	live.textContent = subtitle
	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕ Close'
	x.title = 'Close the terminal (Esc)'
	x.className =
		'ml-auto flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot'
	tap(x, close)
	bar.append(title, live, x)
	return bar
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
		// the grid has not changed — only how we draw it — so the guard has to be told
		repaintSoon()
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
	tap(x, close)
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
	// `min-h-0 flex-1` so the screen takes the space between the bar and the input
	// and nothing else — without it a flex child refuses to shrink below its content
	// and pushes the input off the bottom of the phone.
	// overscroll-contain stops a flick at the end of the scrollback from dragging the
	// page behind it, which is what makes a web view feel like a web page.
	pre.className = 'm-0 min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 whitespace-pre'
	pre.textContent = 'reading…'

	const form = document.createElement('form')
	form.className = 'flex gap-2 border-t border-line p-2'
	const input = document.createElement('input')
	input.id = 'ask'
	input.autocomplete = 'off'
	input.placeholder = 'Type into this session…'
	// The phone keyboard's return key says "send" and submits, instead of "return"
	// and doing nothing anybody can see.
	input.enterKeyHint = 'send'
	// Submit on Enter explicitly rather than relying on the form's implicit
	// submission. That relies on the browser finding the submit button, and it was
	// reported not working on a phone; a handler that calls requestSubmit() cannot be
	// defeated by whatever the implicit rules are doing.
	input.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
		e.preventDefault()
		form.requestSubmit()
	})
	// Re-measure around the keyboard appearing, not only when visualViewport says so.
	// Focus and blur are the two signals guaranteed to arrive; `settle` then watches
	// until the animation each one starts has actually finished, which fixed sample
	// points could not — see viewport.ts.
	for (const ev of ['focus', 'blur'] as const) input.addEventListener(ev, settle)
	// 16px, and not a pixel less. THIS is the zooming.
	//
	// iOS Safari zooms the whole page whenever you focus an input whose font-size is
	// under 16px — an accessibility behaviour, not a bug, and it cannot be turned off
	// in any way worth having. The page inherits 15px from `body`, so every tap on
	// this box zoomed the terminal in and left you to pinch back out afterwards.
	//
	// The alternatives are worse. `maximum-scale=1` is ignored by iOS on purpose, and
	// `touch-action: pan-y` does suppress it but takes pinch-zoom with it, which on a
	// view whose whole problem is small text is the wrong thing to remove.
	input.className = 'min-h-11 flex-1 rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label'
	const send = document.createElement('button')
	send.type = 'submit'
	send.textContent = 'Send'
	send.className = 'min-h-11 shrink-0 cursor-pointer rounded border border-gold bg-gold px-4 text-[15px] font-bold text-bg'
	const note = document.createElement('p')
	note.id = 'sendnote'
	note.hidden = true
	note.className = 'm-0 shrink-0 border-t border-gold/40 bg-gold/10 px-3 py-2 text-[0.78rem]/[1.4] text-gold'
	form.append(input, send)
	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		const text = input.value
		if (!text.trim() || sending) return
		input.value = ''
		// Say it is working, rather than going quiet.
		//
		// This used to only set `disabled`, which on a phone is indistinguishable from
		// a button that did not register the tap — and the report was exactly that:
		// "I clicked the send button and it did nothing". The word is the difference
		// between waiting and being ignored.
		sending = true
		send.disabled = true
		send.textContent = 'Sending…'
		// `finally`, so a throw can never leave the button disabled forever. Combined
		// with the deadline in api(), the worst case is now an error you can read
		// rather than a control that has quietly stopped working.
		let r: Awaited<ReturnType<typeof api>>
		try {
			r = await api('/api/send', { method: 'POST', body: JSON.stringify({ id: openId, text }) })
		} finally {
			sending = false
			send.disabled = false
			send.textContent = 'Send'
		}
		if (r.error) {
			pre.textContent = `${r.error}\n\n${pre.textContent}`
			input.value = text // give it back rather than losing what was typed
		}
		// A send that worked but will sit for a while says so, ONCE, above the screen.
		//
		// Shown as a banner rather than folded into the terminal text, because the
		// terminal text is about to be overwritten by the next poll and this has to
		// outlive that. The whole failure was a send that looked like nothing happened;
		// the answer is not a better send, it is telling you what happened to it.
		note.textContent = r.note ?? ''
		note.hidden = !r.note
		refresh()
		// NOT re-focused. This reply can arrive many seconds after the tap, by which
		// time the keyboard has usually been dismissed — and focusing an input raises
		// it again, from a timer, with no gesture behind it. That is what broke the
		// view: the keyboard came back up unasked, moved the viewport under a panel
		// that had already finished measuring, and left the terminal sitting halfway
		// down the screen. Whoever still has the box focused keeps it; nobody has it
		// forced back on them.
	})

	el.append(bar, pre, note, form)
	return { pre, input }
}

/**
 * A poll or a send is in flight. Neither may overlap itself, and a poll gives way
 * to a send.
 *
 * The screen is 68KB — measured, not estimated — and it was fetched every two
 * seconds by a bare `setInterval` with nothing checking whether the previous one
 * had come back. On a desktop it always had. On a phone over a tailnet it often
 * had not, so the polls stacked up, and a browser will only hold six connections
 * to one host — one of which this client permanently spends on the event stream.
 * Five outstanding screen reads is the whole budget, and the Send request then
 * queues behind them rather than being sent.
 *
 * That is the delay: not the machine, which answers a send in about 200ms, but a
 * request that had nowhere to go. Sitting on the disabled button for twenty
 * seconds and then failing was the same bug reaching its deadline.
 */
let polling = false
let sending = false

async function refresh() {
	if (!openId || polling || sending) return
	polling = true
	try {
		await poll()
	} finally {
		polling = false
	}
}

async function poll() {
	if (!openId) return
	const r = await api(`/api/screen?id=${encodeURIComponent(openId)}`, lastTag ? { headers: { 'if-none-match': lastTag } } : {})
	// Nothing has changed, so there is nothing to draw and nothing was sent.
	if (r.status === 304) return
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
	// The mode button is revealed from the measurement rather than from a
	// breakpoint, so it appears exactly when it would do something — see paint().
	const btn = document.getElementById('screenmode')
	const cramped = paint(pre, r.render_grid, el, wrap)
	if (btn) btn.hidden = !cramped
}

/** Open the terminal for a session. */
export function show(id: string, name: string) {
	openId = id
	openName = name
	el.hidden = false
	holdPage()
	// Sized BEFORE the branch, not after: the password form is full screen too, and
	// putting this after the early return left that state anchored to the layout
	// viewport — the one state where you most need the input to be reachable.
	measure()
	if (!token()) return askForToken('This is behind a separate password from the passcode.')
	const { input } = chrome(name)
	refresh()
	clearInterval(timer)
	timer = setInterval(refresh, 2000)
	// Deliberately NOT focused on a phone. Focusing raises the keyboard immediately,
	// so opening a terminal to read what a session said would cost half the screen
	// before you had read a word of it. Tap the box when you actually want to type.
	if (!fullScreen()) input.focus()
}

export function close() {
	openId = null
	lastTag = ''
	clearInterval(timer)
	timer = 0
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
	onClose()
}

export function mountTerminal(host: HTMLElement, closed: () => void) {
	el = host
	onClose = closed
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && openId) close()
	})
	watch(host, isOpen)
	// A rotation changes the width the type is sized from, and the grid does not
	// change at all — so without this the screen keeps the old size until the session
	// happens to print. Debounced because a rotation fires this repeatedly.
	let t = 0
	addEventListener('resize', () => {
		if (!openId) return
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

export const isOpen = () => openId !== null

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
	if (!openId) return false
	if (sending) return true
	return !!(document.getElementById('ask') as HTMLInputElement | null)?.value.trim()
}

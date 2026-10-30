/**
 * Keeping a full-screen panel where the phone can actually see it.
 *
 * The overlays here — the terminal and pressroom on a phone, and the terminal at every
 * width since it stopped being inline on a desktop — all have to survive the one thing
 * a touch screen does that a desktop never does: raise a keyboard over half the
 * display. This is the shared answer, because the terminal learned it the hard way and
 * pressroom had the same bug sitting in it unnoticed.
 *
 * There are two viewports on iOS and they disagree exactly when it matters. The
 * LAYOUT viewport is the box CSS lays out against and `position: fixed` anchors
 * to; the VISUAL viewport is what you can actually see and touch. The keyboard
 * shrinks the visual one and leaves the layout one alone, so a panel that fills
 * the layout viewport is taller than the screen and anchored above it: the input
 * and Close sit behind the keyboard, and taps land at coordinates that are no
 * longer where the buttons appear to be.
 *
 * `interactive-widget=resizes-content` is meant to fix this and iOS does not
 * implement it. `100dvh` handles the URL bar and knows nothing about keyboards.
 * visualViewport is the only thing that reports the truth here.
 */

/**
 * The phone layout: overlays edge to edge, and the page hidden behind them.
 *
 * The SAME query the stylesheet uses, character for character, and that matters
 * more than which form it is written in.
 *
 * What hangs off it now is layout, not whether something is an overlay: the terminal
 * is an overlay at every width (inset by a margin from 880px), so its scroll lock and
 * its keyboard sizing no longer ask this. If it ever disagrees with the CSS, the JS
 * lays out for one width while the stylesheet draws the other.
 *
 * So they must fail together or not at all. I briefly rewrote this as
 * `max-width: 879.98px` on the grounds that the range form needs Safari 16.4,
 * which is true and is beside the point: Tailwind emits `(width < 880px)` for the
 * matching `max-[880px]:` utilities, so an engine too old to parse it drops the
 * full-screen CSS too, and the pair stays consistent. Making only this side
 * portable would have introduced exactly the split it was meant to avoid.
 */
export const fullScreen = () => window.matchMedia('(width < 880px)').matches

/**
 * How much of the screen something has to eat before it counts as a keyboard.
 *
 * The gap between the two viewports from browser chrome alone is tens of pixels,
 * while a keyboard is hundreds. Anything in between is not worth moving a panel
 * for, and moving it for the URL bar was its own regression: the panel stopped
 * filling the screen and left a strip along the bottom.
 */
const KEYBOARD = 60

let savedScroll = 0

/**
 * Who is holding the page still. Named holders rather than a counter, because
 * both overlays can be open together — the terminal opens over pressroom quite
 * happily — and a counter only has to be unbalanced once to leave the page
 * frozen with nothing on top of it. A name can be released twice with no harm.
 */
const holders = new Set<string>()

/**
 * Stop the page scrolling under an overlay — the way iOS actually respects.
 *
 * `overflow: hidden` on the body is the usual advice and iOS ignores it: the
 * page kept its scroll offset and the browser went on scrolling it whenever an
 * input took focus. Measured with the terminal open over a list scrolled 500px
 * down — `document.body` was still `position: static` and `scrollY` was still
 * 500.
 *
 * That is the whole cause of the panel landing halfway down the screen. Focusing
 * the input makes iOS scroll the layout viewport to reveal it, `fixed` anchors
 * to that viewport, and the panel goes with it. Pinning the body takes the
 * browser's ability to scroll away entirely, so the two viewports keep a common
 * origin and there is nothing left to compensate for.
 *
 * The offset is kept and restored, because a lock that loses your place in the
 * list is its own small bug.
 */
export function lockPage(who: string) {
	if (!holders.size) {
		savedScroll = window.scrollY
		const s = document.body.style
		s.position = 'fixed'
		s.top = `${-savedScroll}px`
		s.left = '0'
		s.right = '0'
		s.width = '100%'
		// Hides the page under the overlay on a phone; see `html.held` in src.css.
		document.documentElement.classList.add('held')
	}
	holders.add(who)
}

export function unlockPage(who: string) {
	if (!holders.delete(who) || holders.size) return
	const s = document.body.style
	s.position = ''
	s.top = ''
	s.left = ''
	s.right = ''
	s.width = ''
	document.documentElement.classList.remove('held')
	window.scrollTo(0, savedScroll)
}

/**
 * The page behind a panel that covers it — header, room, list and footer. Not
 * #offline: it is a live status, and inert would take it out of what a screen reader
 * hears, so a connection dropping while a panel is open would go unannounced.
 */
const PAGE = 'body > :is(#bar, #room, #list, #empty, #foot)'

/** Who is covering the page, by name, as with `holders` above. */
const covering = new Set<string>()

/**
 * Take the page out of reach while a panel covers it: `inert`, so a click, a Tab or a
 * screen reader cannot get to it.
 *
 * On a desktop the terminal sits 16px in from the edges over a dimmed page, and the
 * dimming is only a shadow — measured, a click in that margin opened a list row, and
 * one on the header's pressroom button opened pressroom UNDER the terminal, where the
 * next Esc closed it unseen. Only for panels that cover the page: pressroom and the
 * new-session drawer sit beside it on a desktop and leave it usable on purpose.
 */
export function cover(who: string) {
	covering.add(who)
	// What sits on the page and is open — the settings popover, the new-session drawer,
	// a picture — closes itself on this. Left open, it was either inert under the panel
	// while still holding Esc, or above it (the drawer is z-7) while the panel held Esc.
	// Sent BEFORE the page goes inert: the picture viewer hands back what it stilled as it
	// closes, and after would undo the inert set here.
	document.dispatchEvent(new Event(COVERED))
	for (const el of document.querySelectorAll<HTMLElement>(PAGE)) el.inert = true
}

/** Sent on the document whenever a panel covers the page. */
export const COVERED = 'guildhall:covered'

export function uncover(who: string) {
	if (!covering.delete(who) || covering.size) return
	for (const el of document.querySelectorAll<HTMLElement>(PAGE)) el.inert = false
}

/** Whether a panel covers the page, so the room can stop drawing what nobody sees. */
export const covered = () => covering.size > 0

let host: HTMLElement | null = null
let showing: () => boolean = () => false

/** Hand back whatever the stylesheet says. `100dvh` is right for every case
 *  except a keyboard, so the override is removed rather than recomputed. */
function release() {
	if (!host) return
	host.style.height = ''
	host.style.bottom = ''
	host.style.transform = ''
}

/**
 * Size the panel to what can actually be seen, or get out of the way.
 *
 * The decision is the keyboard and nothing else. It used to also consider
 * `offsetTop`, and that is what wedged the view: iOS leaves `offsetTop` at a
 * stale non-zero value after the keyboard goes away, so the "keyboard is gone,
 * clear everything" branch was skipped and the panel stayed pinned to a viewport
 * that no longer existed. Nothing re-measured after that, because the viewport
 * had stopped moving and fires no events when it is still — which is why
 * rotating the phone was the only way out, and why it took a minute.
 *
 * The offset is applied with a TRANSFORM, never with `top`. This is the bug
 * behind a Close button you can see perfectly and cannot press: on iOS, moving a
 * `position: fixed` element with `top` while the visual viewport is offset repaints
 * it in the new place but leaves its hit region in the old one. The button is
 * drawn where you are aiming and the tap lands somewhere else entirely, so there
 * is no highlight, no flash, and nothing to suggest the tap was even seen — which
 * is exactly what was reported, and only ever after the keyboard had been up,
 * because that is the only time this offset is non-zero.
 *
 * A transform is part of the element's own matrix, so hit testing goes through it
 * the same way painting does and the two cannot disagree. It is also composited
 * rather than laid out, which is the cheaper of the two on a phone.
 */
export function measure() {
	if (!host) return
	const vv = window.visualViewport
	// Not only below 880px. A large iPhone in landscape is 926-956px wide and an iPad
	// wider still, and the panel is a fixed overlay there too now, so the keyboard does
	// to it exactly what it does on a phone held upright. A desktop never gets past
	// the keyboard test below.
	if (!vv || !showing()) return release()
	// A pinch-zoom shrinks the visual viewport too, by the zoom, and is not a keyboard:
	// at 1.25x on a 900px window it read as 180px of "keyboard" and squeezed the panel.
	// So above 880px the height is taken at the zoom's scale, which a keyboard leaves at
	// 1. Not below: a phone has always resized the panel on a pinch, and its behavior is
	// left exactly as it was.
	const seen = fullScreen() ? vv.height : vv.height * vv.scale
	if (window.innerHeight - seen < KEYBOARD) return release()
	// Above 880px the panel is inset from the edges (`inset-4`); keep the same margin
	// at the bottom, above the keyboard.
	const inset = parseFloat(getComputedStyle(host).top) || 0
	host.style.height = `${vv.height - inset * 2}px`
	host.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : ''
	// `inset-0` sets bottom too, which would fight an explicit height
	host.style.bottom = 'auto'
}

let raf = 0
let stable = 0
let seen = ''
let until = 0

/** Frames the geometry must agree with itself before this stops watching. */
const STEADY = 3

/** Ceiling on one settle, in ms. Long enough for a slow keyboard, short enough
 *  that a browser which never settles cannot leave this running. */
const LIMIT = 1200

/**
 * Re-measure until the viewport stops moving.
 *
 * The keyboard animates in over a few hundred milliseconds and the animation is
 * interruptible, so there is no fixed moment at which the geometry is final. The
 * previous version sampled at 0, 150, 350 and 600ms and kept whatever the last
 * one saw — if that landed mid-flight, a half-open keyboard's dimensions were
 * latched and stayed. Watching until three consecutive frames agree cannot end
 * on a transient, and a bad frame in the middle repairs itself on the next one.
 *
 * Bounded twice over: it stops as soon as the viewport is steady, and it stops
 * regardless after LIMIT. This is a rAF loop that runs for the length of a
 * keyboard animation, not a perpetual one — the thing the budget forbids.
 */
export function settle() {
	until = performance.now() + LIMIT
	stable = 0
	if (!raf) raf = requestAnimationFrame(step)
}

function step() {
	raf = 0
	const vv = window.visualViewport
	const now = vv ? `${Math.round(vv.height)}:${Math.round(vv.offsetTop)}` : ''
	measure()
	if (now === seen) stable++
	else {
		stable = 0
		seen = now
	}
	if (stable >= STEADY || performance.now() > until) return
	raf = requestAnimationFrame(step)
}

/**
 * Start watching for `el`, which is on screen whenever `open()` says so.
 *
 * `pointerdown` is the cheap insurance and it is aimed at one specific report:
 * being unable to close the panel for about a minute. If the geometry is ever
 * wrong, the first thing anyone does is tap at it — so a tap is the one signal
 * guaranteed to arrive exactly when it is needed, and re-measuring on it means
 * the attempt to press Close is itself what puts Close back where it belongs.
 */
export function watch(el: HTMLElement, open: () => boolean) {
	host = el
	showing = open
	el.addEventListener('pointerdown', measure, { passive: true })
	// The keyboard fires these and NOT `resize` on iOS, which is the whole point:
	// without them a panel never learns the screen got shorter.
	window.visualViewport?.addEventListener('resize', settle)
	window.visualViewport?.addEventListener('scroll', measure)
}

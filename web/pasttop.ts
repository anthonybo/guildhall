/**
 * Scrolling up past the top of the chat opens the conversation history.
 *
 * The screen has no scrollback to give (termbar.ts): Claude Code draws on the alternate
 * screen, so guildhall only ever has the rows the pane shows. Once lines were joined to
 * fill a desktop window those rows nearly fit — measured on a real 47-column
 * screen at 1405×913, 28px were left to scroll — and "I cannot scroll up the terminal
 * at all" was the result. Everything earlier is in the history, so going further up
 * leads there.
 *
 * Only a push made AT the top counts. Scrolling up through the screen and hitting the
 * top must not carry on into the history: a trackpad flick keeps sending wheel events
 * for a second after the fingers lift, and a phone flick runs on to the edge the same
 * way. A touch counts only if it started at the top. A wheel counts once the screen is
 * at the top and either the events paused (GAP) or one pushed harder than the last:
 * momentum only ever dies away, so a rising delta is a finger.
 *
 * The first version armed only after a pause, and on a Mac trackpad it never fired:
 * each swipe's momentum ran into the next swipe, so swiping up again and again was one
 * unbroken stream that had started below the top.
 */
const GAP = 300
/** How far past the top, in CSS px: more than one mouse-wheel notch (100), less than
 *  one short trackpad swipe. */
const WHEEL = 120
/** A pull, not a wobble: about a third of a thumb's travel on a phone. */
const PULL = 90

export function pastTop(pre: HTMLElement, open: () => void) {
	const atTop = () => pre.scrollTop <= 0
	let last = 0
	let before = 0
	let armed = false
	let pushed = 0
	pre.addEventListener(
		'wheel',
		(e) => {
			// deltaMode 1 is lines (Firefox with a mouse): about 16px each.
			const up = -e.deltaY * (e.deltaMode === 1 ? 16 : 1)
			const paused = e.timeStamp - last > GAP
			const harder = up > before
			last = e.timeStamp
			before = up
			if (up <= 0 || !atTop()) {
				armed = false
				pushed = 0
				return
			}
			// a push that fell short is not carried into the next one
			if (paused) pushed = 0
			if (paused || harder) armed = true
			if (!armed) return
			pushed += up
			if (pushed < WHEEL) return
			armed = false
			pushed = 0
			open()
		},
		{ passive: true },
	)

	let from: number | null = null
	pre.addEventListener(
		'touchstart',
		(e) => {
			from = e.touches.length === 1 && atTop() ? e.touches[0]!.clientY : null
		},
		{ passive: true },
	)
	pre.addEventListener(
		'touchmove',
		(e) => {
			if (from === null || !atTop()) return
			if (e.touches[0]!.clientY - from < PULL) return
			from = null
			open()
		},
		{ passive: true },
	)
	pre.addEventListener('touchend', () => (from = null))
	pre.addEventListener('touchcancel', () => (from = null))
}

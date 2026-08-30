/** The small helpers every module here needs, and nothing else. */

export const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T

export const rgb = (c: readonly number[]) => `rgb(${c[0]} ${c[1]} ${c[2]})`

/** A duration in words. Rounded, because "how long" is the question, not "exactly how long". */
export const ago = (ms: number) => {
	const m = Math.round(ms / 60000)
	if (m < 1) return 'now'
	if (m < 60) return `${m}m`
	const h = Math.round(m / 60)
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
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
export function tap(el: HTMLElement, run: () => void) {
	/**
	 * When this button last acted, so the click a touch synthesises afterwards is
	 * ignored — and NOTHING else is.
	 *
	 * This was a boolean, set on first use and never cleared, which made every
	 * `tap` button single-use for its whole lifetime. It went unnoticed because the
	 * only users were Close buttons on panels that are rebuilt each time they open,
	 * so the flag was always fresh. The first re-used button — a toggle — opened its
	 * row and then would not close it, and the arrow keys beside it were dead after
	 * one press each.
	 *
	 * The thing that needs de-duplicating is a GESTURE, not a button. A press and
	 * the click it synthesises arrive within a few hundred milliseconds; anything
	 * later is a person pressing again and must be allowed through.
	 */
	let actedAt = 0
	const GESTURE_MS = 700
	const fire = () => {
		actedAt = Date.now()
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
		fire()
	})
	el.addEventListener('click', () => {
		// The compatibility click for a press already handled. Later than that and it
		// is a mouse, or a second deliberate tap.
		if (Date.now() - actedAt < GESTURE_MS) return
		fire()
	})
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
 * A tap in a SCROLLING list, which neither `tap` nor a plain click can do.
 *
 * `tap` acts on `pointerdown` and cancels it, so the browser cannot scroll and the row
 * the finger first touched is chosen — a list becomes unscrollable and picks things
 * nobody meant. A plain `click` scrolls correctly and then does not fire, because a
 * click is only delivered when press and release land on the same element, and this
 * panel re-measures itself on `pointerdown` (see viewport.ts) — so the row moves out
 * from under the finger between the two halves of the tap. That is the same failure
 * written up on the Send button, in a place where the fix for it cannot be used.
 *
 * So: remember the row and where the finger landed, let the browser do whatever it
 * likes, and decide on `pointerup`.
 *
 *  - the pointer moved more than a few pixels: that was a scroll, do nothing
 *  - it did not: run, against the row REMEMBERED at pointerdown
 *
 * Remembering the row is what makes it safe. `pointerup` is listened for on the window
 * rather than the row, so it arrives even if the layout shifted, and the row that acts
 * is the one that was touched rather than whatever is under the finger by then.
 */
export function tapList(el: HTMLElement, run: () => void) {
	/** Beyond this, the finger was scrolling. Roughly a thumb's wobble. */
	const SLOP = 12
	let touched = false
	el.addEventListener(
		'pointerdown',
		(e) => {
			const pe = e as PointerEvent
			if (pe.pointerType !== 'touch') return
			touched = true
			const sx = pe.clientX
			const sy = pe.clientY
			const id = pe.pointerId
			const done = () => {
				window.removeEventListener('pointerup', up)
				window.removeEventListener('pointercancel', done)
			}
			const up = (ue: PointerEvent) => {
				done()
				if (ue.pointerId !== id) return
				if (Math.hypot(ue.clientX - sx, ue.clientY - sy) > SLOP) return
				// The compatibility click would otherwise land on whatever is under the
				// finger once this row's list has closed.
				eatNextClick()
				run()
			}
			window.addEventListener('pointerup', up)
			window.addEventListener('pointercancel', done)
		},
		// NOT cancelled: cancelling is what stops the list scrolling.
		{ passive: true },
	)
	el.addEventListener('click', () => {
		// Mouse and keyboard, which never set `touched`. A touch that got this far has
		// already acted on pointerup.
		if (touched) {
			touched = false
			return
		}
		run()
	})
}

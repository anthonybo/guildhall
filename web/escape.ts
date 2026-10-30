/**
 * Esc closes the top thing that is open, and only that.
 *
 * Each overlay used to listen for Esc on the document by itself, so one press closed
 * every one of them at once: the history and the terminal under it, or the pressroom
 * and the terminal over it. Now whatever opens holds Esc here by name, the most recent
 * holder is on top, and only it is asked — the same shape as `lockPage`'s holders in
 * viewport.ts, so holding twice moves a name to the top and dropping twice is harmless.
 *
 * The top one may decline — the terminal does while there is text in its box, because
 * Esc there is a reflex that would throw the message away — and then nothing beneath
 * it closes either. Declining means "not now", not "ask the next one".
 */

/** Return true when the Esc was used, which stops anything else seeing it. */
type Handler = () => boolean

const holders: { who: string; handler: Handler }[] = []

function onKey(e: KeyboardEvent) {
	// An Esc that ends an input method's composition belongs to the input. Safari can
	// deliver that one with `isComposing` false and the composition key code instead.
	if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229 || !holders.length) return
	if (holders[holders.length - 1]!.handler()) {
		e.preventDefault()
		e.stopImmediatePropagation()
	}
}

/** Attached on first use rather than at import, so importing this outside a browser —
 *  a test under node — does not touch a `document` that is not there. */
let listening = false

/** `who` takes Esc while it is open, on top of whatever held it before. */
export function holdEscape(who: string, handler: Handler) {
	if (!listening) {
		// Capture, so this runs before any other listener on the page can act on the key.
		document.addEventListener('keydown', onKey, true)
		listening = true
	}
	dropEscape(who)
	holders.push({ who, handler })
}

/** `who` has closed. */
export function dropEscape(who: string) {
	const at = holders.findIndex((h) => h.who === who)
	if (at !== -1) holders.splice(at, 1)
}

/**
 * Whether the focused box has text in it — the "not now" for Esc. Typing is where Esc
 * is pressed on reflex, and closing a panel on it throws away what was typed.
 */
export function typing() {
	const t = document.activeElement
	return (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value !== ''
}

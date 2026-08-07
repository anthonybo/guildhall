/**
 * Making a colour readable against the one behind it.
 *
 * The list tints every card with its own status colour, which lightens the
 * background by a different amount per band — so a text colour that is legible on
 * one card is not on another. Fixed pairs cannot solve that: the project hues are
 * also the room's carpet colours and are chosen to be distinguishable from each
 * other, not to sit at a given contrast against nine different backgrounds.
 *
 * So the pairing is computed instead. The hue is kept and only its lightness
 * moves, and only as far as it has to — `brightwater` needs a nudge from 4.18,
 * `marina` needs nothing at all.
 *
 * 4.5:1 is WCAG AA for body text. It is the floor this project has settled on
 * after dim status text turned out to be unreadable at a glance more than once.
 *
 * No node imports: this runs in the browser.
 */
import type { RGB } from './theme.ts'

const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)

/** Relative luminance, per WCAG 2.x. */
export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

/** Contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrast(a: RGB, b: RGB) {
	const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)]
	return (hi + 0.05) / (lo + 0.05)
}

/** Linear blend, matching what CSS color-mix(in srgb, …) produces. */
export const mix = (a: RGB, p: number, b: RGB): RGB => [0, 1, 2].map((i) => Math.round(a[i] * p + b[i] * (1 - p))) as RGB

const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

/**
 * `fg` moved toward white or black — whichever direction the background is not —
 * until it clears `target` against it. Returned unchanged if it already does.
 *
 * Binary search rather than a step loop: the relationship between blend fraction
 * and contrast is monotonic but not linear, and stepping either overshoots (and
 * washes the hue out) or takes far more iterations than this to land.
 */
export function readable(fg: RGB, bg: RGB, target = 4.5): RGB {
	if (contrast(fg, bg) >= target) return fg
	// away from the background: on a dark card that means lighter, and the cards
	// here are always dark — but deciding it from the background rather than
	// assuming keeps this honest if a light theme ever exists.
	const toward = luminance(bg) < 0.5 ? WHITE : BLACK
	// unreachable even at the extreme: return the extreme rather than something
	// arbitrary, so the caller still gets the most readable colour available
	if (contrast(toward, bg) < target) return toward
	let lo = 0
	let hi = 1
	for (let i = 0; i < 12; i++) {
		const m = (lo + hi) / 2
		if (contrast(mix(toward, m, fg), bg) >= target) hi = m
		else lo = m
	}
	return mix(toward, hi, fg)
}

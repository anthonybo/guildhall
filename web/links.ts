/**
 * Finding URLs in terminal output.
 *
 * Its own file, and free of the DOM, so the rules can be tested. The rules are
 * the whole difficulty: terminal text is prose, and a link at the end of a
 * sentence is followed by punctuation that is not part of it.
 */

/** Stops at whitespace and at the brackets and quotes that enclose rather than belong. */
const URL_RE = /https?:\/\/[^\s'"`<>()[\]{}]+/g

/**
 * Trailing characters to hand back to the sentence.
 *
 * `see http://willow.local/.` must not linkify the full stop, and a link inside
 * parentheses must not swallow the closing one. Applied repeatedly, so `...local/).`
 * gives back both.
 */
const TRAILING = /[.,;:!?)\]}>'"`]+$/

export type Part = { text: string; href?: string }

/**
 * Split `text` into runs, marking the ones that are links.
 *
 * Returns plain data rather than nodes so the caller decides how to render it —
 * and so this can be checked without a browser.
 */
export function linkParts(text: string): Part[] {
	const out: Part[] = []
	URL_RE.lastIndex = 0
	let at = 0
	let m: RegExpExecArray | null
	while ((m = URL_RE.exec(text))) {
		const href = m[0].replace(TRAILING, '')
		// nothing but punctuation after the scheme: not a link, leave it as prose
		if (!href || !/^https?:\/\/[^/]/.test(href)) continue
		if (m.index > at) out.push({ text: text.slice(at, m.index) })
		out.push({ text: href, href })
		at = m.index + href.length
	}
	if (at < text.length) out.push({ text: text.slice(at) })
	return out
}

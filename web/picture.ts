/**
 * Where a terminal is drawing a picture, found from its text grid. Pure: no DOM.
 *
 * The kitty graphics protocol's placeholder mode puts U+10EEEE in every cell an image
 * covers, with combining marks giving that cell's place in the image. cmux reports
 * those cells as text and nothing else. Painted as text they came out as a tall blank
 * hole on a phone, with everything after the picture apparently gone. Measured on a
 * real session: 578 placeholder cells over 12 rows, for one screenshot preview.
 */

export const PLACEHOLDER = '\u{10EEEE}'

export type Picture = {
	/** First and last row the picture covers. */
	top: number
	bottom: number
	/** First and last column it covers. */
	left: number
	right: number
	/** The file name printed just above it, when there is one. */
	name: string | null
	/** The style of its cells. The protocol puts the image's id in their text color, so
	 *  this is what still identifies the picture once its name has scrolled off the top. */
	style: number
}

type Span = { row: number; column: number; text: string; style_id: number }

/** Image files by name, as Claude Code prints one under a Read: `w-all.png`. */
const FILE = /[\w@%+=,.-]+\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)\b/gi

/** Every picture on the screen, top to bottom. Consecutive rows of placeholders are one
 *  picture; a row with none ends it. */
export function pictures(spans: Span[], rows: number): Picture[] {
	const cols = new Map<number, [number, number]>()
	const text = new Map<number, string>()
	const style = new Map<number, number>()
	for (const sp of spans) {
		text.set(sp.row, (text.get(sp.row) ?? '') + sp.text)
		if (!sp.text.startsWith(PLACEHOLDER)) continue
		if (!style.has(sp.row)) style.set(sp.row, sp.style_id)
		const width = [...sp.text].filter((ch) => ch === PLACEHOLDER).length
		const at = cols.get(sp.row)
		const lo = Math.min(at?.[0] ?? sp.column, sp.column)
		const hi = Math.max(at?.[1] ?? 0, sp.column + Math.max(1, width) - 1)
		cols.set(sp.row, [lo, hi])
	}
	const out: Picture[] = []
	for (let r = 0; r < rows; r++) {
		const c = cols.get(r)
		if (!c) continue
		const last = out.at(-1)
		if (last && last.bottom === r - 1) {
			last.bottom = r
			last.left = Math.min(last.left, c[0])
			last.right = Math.max(last.right, c[1])
			continue
		}
		// The name is on the line above, or the one above that when a blank row sits
		// between. The last file name on the line, if a line names several.
		let name: string | null = null
		for (const above of [r - 1, r - 2]) {
			const hits = (text.get(above) ?? '').match(FILE)
			if (hits) {
				name = hits.at(-1)!
				break
			}
		}
		out.push({ top: r, bottom: r, left: c[0], right: c[1], name, style: style.get(r) ?? 0 })
	}
	return out
}

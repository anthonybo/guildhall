/**
 * Project nameplates, drawn as images rather than as terminal text.
 *
 * A terminal cell is about twice as tall as it is wide, so one glyph per row
 * spaces a name across twice its own length and no font can close that gap. This
 * draws the name into a pixel grid instead and rotates it, which is what the
 * research settled on: three controlled studies put rotated text 14-33% faster to
 * read than stacked, and the gap is widest for lowercase, which is what project
 * names are. The geometric reason is the one that matters here — a long name
 * rotated compresses letter SPACING, which readers tolerate; stacked it
 * compresses x-HEIGHT, which is the worst thing to shrink.
 *
 * Bottom-to-top, following Imhof's rule for labelling vertical features on maps.
 * No study finds a direction preference, so convention decides.
 *
 * The fonts are X11 misc-fixed, which is public domain ("Public domain font.
 * Share and enjoy." is the entire upstream licence), converted from BDF by
 * tools/bdf2ts.ts. 6x13 is the largest that fits the longest real project name in
 * the space available: 16 characters at 6px advance is 96px against 102 available.
 *
 * IMPORTANT: never supersample a plate. kitty and Ghostty bilinear-filter
 * graphics-protocol images, so authoring at 2x or 3x and letting the terminal
 * scale down averages 1px stems into grey. Build at exactly the box size and
 * transmit 1:1, and the filter stops mattering.
 */
import type { RGB } from './theme.ts'
import type { Grid } from './characters.ts'

export const F6x13 = { w: 6, h: 13, g: {
	a: '00000000001c021e22261a0000',
	b: '00002020203c222222223c0000',
	c: '00000000001c222020221c0000',
	d: '00000202021e222222221e0000',
	e: '00000000001c223e20221c0000',
	f: '00000c1210103c101010100000',
	g: '00000000001c2222221e02221c',
	h: '00002020202c32222222220000',
	i: '000000080018080808081c0000',
	j: '00000004000c04040404242418',
	k: '00002020202428302824220000',
	l: '000018080808080808081c0000',
	m: '0000000000342a2a2a2a220000',
	n: '00000000002c32222222220000',
	o: '00000000001c222222221c0000',
	p: '00000000003c2222223c202020',
	q: '00000000001e2222221e020202',
	r: '00000000002c32202020200000',
	s: '00000000001c221804221c0000',
	t: '00000010103c101010120c0000',
	u: '000000000022222222261a0000',
	v: '00000000002222221414080000',
	w: '000000000022222a2a2a140000',
	x: '00000000002214080814220000',
	y: '0000000000222222261a02221c',
	z: '00000000003e040810203e0000',
	0: '00000814222222222214080000',
	1: '000008182808080808083e0000',
	2: '00001c222202040810203e0000',
	3: '00003e0204081c0202221c0000',
	4: '000004040c1414243e04040000',
	5: '00003e20202c320202221c0000',
	6: '00001c2220203c2222221c0000',
	7: '00003e02040408081010100000',
	8: '00001c2222221c2222221c0000',
	9: '00001c2222221e0202221c0000',
	'-': '0000000000003e000000000000',
	'_': '00000000000000000000003e00',
	'.': '000000000000000000081c0800',
} }

export const F6x10 = { w: 6, h: 10, g: {
	a: '0000001c021e221e0000',
	b: '0020202c3222322c0000',
	c: '0000001c2220221c0000',
	d: '0002021a2622261a0000',
	e: '0000001c223e201c0000',
	f: '000c12103c1010100000',
	g: '0000001e22221e02221c',
	h: '0020202c322222220000',
	i: '000800180808081c0000',
	j: '0002000602020212120c',
	k: '00202022243824220000',
	l: '001808080808081c0000',
	m: '000000342a2a2a220000',
	n: '0000002c322222220000',
	o: '0000001c2222221c0000',
	p: '0000002c3222322c2020',
	q: '0000001a2622261a0202',
	r: '0000002c322020200000',
	s: '0000001c201c023c0000',
	t: '0010103c1010120c0000',
	u: '000000222222261a0000',
	v: '00000022221414080000',
	w: '00000022222a2a140000',
	x: '00000022140814220000',
	y: '0000002222261a02221c',
	z: '0000003e0408103e0000',
	0: '00081422222214080000',
	1: '000818280808083e0000',
	2: '001c22020c10203e0000',
	3: '003e02040c02221c0000',
	4: '00040c14243e04040000',
	5: '003e202c3202221c0000',
	6: '000c10202c32221c0000',
	7: '003e0204040810100000',
	8: '001c22221c22221c0000',
	9: '001c22261a0204180000',
	'-': '000000003e0000000000',
	'_': '00000000000000003e00',
	'.': '000000000000081c0800',
} }

export const F5x8 = { w: 5, h: 8, g: {
	a: '0000000e12120e00',
	b: '0010101c12121c00',
	c: '0000000608080600',
	d: '0002020e12120e00',
	e: '0000000c16180c00',
	f: '00040a081c080800',
	g: '0000000c120e020c',
	h: '0010101c12121200',
	i: '0004000c04040e00',
	j: '0002000202020a04',
	k: '001010121c121200',
	l: '000c040404040e00',
	m: '0000001a15151500',
	n: '0000001c12121200',
	o: '0000000c12120c00',
	p: '0000001c121c1010',
	q: '0000000e120e0202',
	r: '000000141a101000',
	s: '000000060c020c00',
	t: '0008081c080a0400',
	u: '0000001212120e00',
	v: '0000000a0a0a0400',
	w: '0000001115150a00',
	x: '000000120c0c1200',
	y: '00000012120e120c',
	z: '0000001e04081e00',
	0: '00040a0a0a0a0400',
	1: '00040c0404040e00',
	2: '000c12020c101e00',
	3: '001e040c02120c00',
	4: '00040c141e040400',
	5: '001e101c02120c00',
	6: '000c101c12120c00',
	7: '001e020404080800',
	8: '000c120c12120c00',
	9: '000c12120e020c00',
	'-': '000000001e000000',
	'_': '000000000000001e',
	'.': '0000000000040e04',
} }

export const F4x6 = { w: 4, h: 6, g: {
	a: '00060a0a0600',
	b: '080c0a0a0c00',
	c: '000608080600',
	d: '02060a0a0600',
	e: '00040a0c0600',
	f: '02040e040400',
	g: '00060a06020c',
	h: '080c0a0a0a00',
	i: '04000c040e00',
	j: '02000202020c',
	k: '080a0c0a0a00',
	l: '0c0404040e00',
	m: '000a0e0a0a00',
	n: '000c0a0a0a00',
	o: '00040a0a0400',
	p: '000c0a0c0808',
	q: '00060a0a0602',
	r: '000a0c080800',
	s: '00060c020c00',
	t: '040e04040200',
	u: '000a0a0a0600',
	v: '000a0a0a0400',
	w: '000a0a0e0a00',
	x: '000a04040a00',
	y: '000a0a06020c',
	z: '000e02040e00',
	0: '040a0e0a0400',
	1: '040c04040e00',
	2: '040a02040e00',
	3: '0e0204020c00',
	4: '0a0a0e020200',
	5: '0e080c020c00',
	6: '06080c0a0400',
	7: '0e0204080800',
	8: '060a040a0c00',
	9: '040a06020c00',
	'-': '00000e000000',
	'_': '00000000000e',
	'.': '000000000400',
} }


type Font = { w: number; h: number; g: Record<string, string> }

function rowBits(f: Font, ch: string, y: number) {
	const s = f.g[ch]
	if (!s) return 0
	return parseInt(s.slice(y * 2, y * 2 + 2), 16)
}

/** Ink mask of a word laid out horizontally: [w, h, bits[y][x]] */
function word(f: Font, s: string) {
	const w = s.length * f.w
	const px: boolean[][] = Array.from({ length: f.h }, () => new Array<boolean>(w).fill(false))
	for (let i = 0; i < s.length; i++)
		for (let y = 0; y < f.h; y++) {
			const b = rowBits(f, s[i], y)
			for (let x = 0; x < f.w; x++) if (b & (1 << (f.w - 1 - x))) px[y][i * f.w + x] = true
		}
	return { w, h: f.h, px }
}

/** Rotated nameplate: the word reads bottom-to-top in a wpx x hpx image. */
export function plate(f: Font, s: string, wpx: number, hpx: number, bg: RGB, ink: RGB, border?: RGB, scale = 1): Grid {
	const grid: (RGB | null)[][] = Array.from({ length: hpx }, () => new Array<RGB | null>(wpx).fill(bg))
	if (border) {
		for (let x = 0; x < wpx; x++) { grid[0][x] = border; grid[hpx - 1][x] = border }
		for (let y = 0; y < hpx; y++) { grid[y][0] = border; grid[y][wpx - 1] = border }
	}
	const m = word(f, s)
	// rotate CCW: source (x,y) -> dest (y, W-1-x); text runs up the image.
	// `scale` enlarges each source pixel into a square block, so the word grows
	// with the terminal's font instead of staying a hairline in a large plate.
	const dw = m.h * scale
	const dh = m.w * scale
	const ox = Math.floor((wpx - dw) / 2)
	const oy = Math.floor((hpx - dh) / 2)
	for (let y = 0; y < m.h; y++)
		for (let x = 0; x < m.w; x++) {
			if (!m.px[y][x]) continue
			for (let j = 0; j < scale; j++)
				for (let i = 0; i < scale; i++) {
					const dx = ox + y * scale + j
					const dy = oy + (m.w - 1 - x) * scale + i
					if (dx >= 0 && dy >= 0 && dx < wpx && dy < hpx) grid[dy][dx] = ink
				}
		}
	return { w: wpx, h: hpx, grid }
}

/** Largest first. `plate` picks the biggest that fits the box and the name. */
export const LADDER: Font[] = [F6x13, F6x10, F5x8, F4x6]

/** Ink rows actually used by a font, so the band can be measured not assumed. */
function band(f: Font) {
	let top = f.h
	let bot = -1
	for (const s of Object.values(f.g))
		for (let y = 0; y < f.h; y++) {
			if (!parseInt(s.slice(y * 2, y * 2 + 2), 16)) continue
			if (y < top) top = y
			if (y > bot) bot = y
		}
	return bot < top ? f.h : bot - top + 1
}

/**
 * How many characters are worth keeping before thickness starts winning.
 *
 * Measured against the real project list: at ten, eight of the ten names stay
 * whole and only `draftingroom` and `iptv-epg-matcher` are cut. At eight, seven
 * of the ten are cut, which is too many to tell the room apart at a glance.
 *
 * A preference, not a floor. A strip too short for ten gets a shorter name rather
 * than a thinner one — see the scale rule below, which outranks this.
 */
const MIN_CHARS = 10

/**
 * Three, not two. On a 15x33 cell the strip is 45px across and doubling a 6x13
 * band uses 22px of it, leaving the word floating in a wide coloured bar — which
 * is exactly the "could be bigger" the plates kept drawing. Tripling fills 33px
 * and still holds eleven characters.
 *
 * The ceiling only binds the growth step below, since the floor is pinned by
 * MIN_CHARS long before this. Four is where a stem reaches 4px against unchanged
 * letterform detail — past that a pixel font stops reading as a typeface and
 * starts reading as blocks, which is why 6x10 at 5x measures thicker than 6x13 at
 * 4x and still looks worse.
 */
const MAX_SCALE = 4

/** '.' rather than '…': the font has no ellipsis, and an absent glyph draws as a
 *  blank, which reads as the name simply stopping rather than continuing. */
const cut = (text: string, room: number) => (text.length > room ? text.slice(0, room - 1) + '.' : text)

/**
 * Font, text, and how many times to enlarge each pixel.
 *
 * The scale is the part that was missing. A plate is authored at the box's real
 * size, and that box grows with the terminal's font — so on a large font the
 * strip was wide and tall while the glyphs stayed 6x13 actual pixels, leaving a
 * thin hairline word floating in a big coloured bar. Scaling is by whole numbers
 * only, so a pixel font stays a pixel font instead of turning to mush.
 *
 * Pick by what ends up on screen, not by which font is nominally largest. In a
 * 24px strip 6x13 fits once — an 11px band of 1px stems — while 6x10 fits twice,
 * an 18px band of 2px stems. The doubled smaller font wins, and not marginally:
 * kitty and Ghostty bilinear-filter these images, so a 1px stem averages to grey
 * and a 2px one survives. That is the whole difference between a word and a
 * smudge, which is why thickness outranks letterform quality here.
 */
export function choose(text: string, wpx: number, hpx: number) {
	type Pick = { font: Font; scale: number; room: number; ink: number }
	const cands: Pick[] = []
	for (const font of LADDER) {
		// +3, not +2: a keyline each side and at least one pixel of margin. The
		// smallest font's band is exactly 6px, which "fits" a one-column strip with
		// nothing to spare — and at that size it is a grey smear rather than a word,
		// so an exact fit has to count as no fit.
		const fits = Math.min(MAX_SCALE, Math.floor((wpx - 3) / band(font)))
		for (let scale = 1; scale <= fits; scale++) cands.push({ font, scale, room: Math.floor(hpx / (font.w * scale)), ink: band(font) * scale })
	}
	// On a tie the taller font, which has the better letterforms at equal height.
	const thickest = (a: Pick, b: Pick) => b.ink - a.ink || b.font.h - a.font.h || b.room - a.room
	const widest = (a: Pick, b: Pick) => b.room - a.room || b.ink - a.ink || b.font.h - a.font.h

	// Fewer than four letters identifies nothing, so those are not options at all.
	const usable = cands.filter((c) => c.room >= 4)
	const thick = usable.filter((c) => c.scale >= 2)
	// The size every plate in the room is guaranteed. Chosen without reference to
	// this particular name, so a row of plates shares a floor rather than each one
	// sizing itself and the row looking ragged.
	const floor =
		// Enough letters to read: spend what is left on thickness.
		thick.filter((c) => c.room >= MIN_CHARS).sort(thickest)[0] ??
		// Not enough letters at any size. Every option here is already 2px-stemmed,
		// so thickness has stopped being the scarce thing and length starts to pay.
		thick.sort(widest)[0] ??
		// The strip is too narrow to double anything. 1:1 is a hairline that kitty's
		// filter greys out, but a faint name still beats no name.
		usable.sort(thickest)[0]
	// Nothing legible fits. Draw no plate rather than a smear — RimWorld's rule.
	if (!floor) return null

	// A short name need not stop at the floor. The floor is set by the length every
	// plate must survive, so a name well under it leaves most of its strip empty —
	// which reads as a small word in a big bar however thick the strokes are.
	// Bounded to one step above the floor: `marina` can physically take 5x where
	// `borrowyard` takes 3x, and that much variation stops looking like a size and
	// starts looking like emphasis the room does not mean. Growth is allowed only
	// while the whole name still fits, so this never trades letters for size — it
	// only spends room that would otherwise go unused.
	// Same font as the floor, never merely a thicker one: letting the font vary put
	// three typefaces in one row of plates, which reads as a rendering fault rather
	// than as one name having more space. Only the scale is allowed to move.
	const grown = thick.filter((c) => c.font === floor.font && c.scale > floor.scale && c.scale <= floor.scale + 1 && c.room >= text.length).sort(thickest)[0]
	const pick = grown ?? floor
	return { font: pick.font, text: cut(text, pick.room), scale: pick.scale }
}

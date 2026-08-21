/**
 * Workstation monitors, generated rather than drawn from art.
 *
 * A desk tile is only 4x4 canvas pixels, so a monitor painted into the canvas is
 * four pixels and invisible. Sent as an image instead, the same tile renders at
 * font resolution — about 32x34 real pixels — which is enough for a bezel, a
 * stand, and a few lines of code on the screen.
 */
import type { RGB } from './png.ts'
import type { Grid } from './characters.ts'

const W = 16
const H = 24 // screen on top, desk surface with keyboard and mug below

const CASE: RGB = [46, 48, 62]
const CASE_LIT: RGB = [72, 76, 96]
const BASE: RGB = [38, 40, 52]
const DARK: RGB = [22, 24, 32]
/** Syntax-ish colours, so a lit screen reads as code rather than as a block. */
const CODE: RGB[] = [
	[126, 220, 190],
	[150, 190, 255],
	[240, 200, 120],
	[230, 140, 170],
	[170, 210, 140],
]

/** A 3x5 pixel font — the smallest that stays legible once the workstation image
 *  is drawn at font resolution. */
const DIGITS: Record<string, string[]> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '010', '010', '010'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111'],
	'?': ['111', '001', '011', '000', '010'],
	'★': ['101', '111', '010', '111', '101'],
}

const cache = new Map<string, Grid>()

/**
 * `activity` shifts the line lengths so consecutive frames differ — a session
 * that is working has a screen that visibly changes. `off` screens are dark and
 * static, which is what makes an unoccupied desk read as unoccupied.
 */
export type Kind = 'edit' | 'read' | 'run' | 'search' | 'agent' | 'think'

/** Screen tint by tool class, so the whole room is readable at a glance. */
export const TINT: Record<Kind, RGB> = {
	edit: [120, 170, 255],
	read: [110, 220, 235],
	run: [250, 180, 90],
	search: [200, 160, 250],
	agent: [160, 235, 150],
	think: [150, 160, 190],
}

/**
 * The mug, which is the one thing on a desk that carried no meaning.
 *
 * Two Claude sessions and a Codex session in the same project sit as three identical
 * workers in the same pod, and until now nothing in the room told them apart at rest —
 * the label prefix only appears on a session that is urgent or selected. Both of the
 * obvious channels were already taken: the sprite badge IS the level tier, and the
 * screen tint IS the tool class, so putting a third meaning on either would break the
 * property that makes the room readable at a glance.
 *
 * A mug is decorative, always present, and per-desk. A different mug reads as somebody
 * else's desk, which is exactly the fact being conveyed.
 */
const MUG: Record<string, RGB> = {
	claude: [226, 118, 96],
	codex: [110, 186, 196],
}

export function monitor(lit: boolean, frame: number, seed = 0, kind: Kind = 'think', agent?: string): Grid {
	const key = `${lit ? 1 : 0}:${lit ? frame % 4 : 0}:${seed % 8}:${kind}:${agent ?? ''}`
	const hit = cache.get(key)
	if (hit) return hit
	const grid: (RGB | null)[][] = Array.from({ length: H }, () => new Array<RGB | null>(W).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = c
	}
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
	}

	// desk surface under the screen, with the things a desk actually has on it
	const WOOD: RGB = [138, 96, 62]
	const WOOD_DK: RGB = [104, 70, 44]
	box(0, 16, W, 8, WOOD)
	box(0, 16, W, 1, [168, 122, 82])
	box(0, 23, W, 1, WOOD_DK)
	// stand and base
	box(7, 12, 2, 3, BASE)
	box(5, 15, 6, 1, CASE)
	// keyboard
	box(3, 18, 9, 3, [58, 62, 78])
	box(4, 19, 7, 1, [92, 98, 118])
	// mug — its colour is which harness this desk belongs to
	const mug = MUG[agent ?? 'claude'] ?? MUG.claude!
	box(13, 18, 3, 3, mug)
	put(12, 19, mug)
	// a small stack of paper where the badge used to sit
	box(0, 19, 3, 2, [236, 234, 226])
	// bezel
	box(1, 1, 14, 11, lit ? CASE_LIT : CASE)
	box(2, 2, 12, 9, DARK)

	if (lit) {
		// four ragged code lines; the ragging advances with the frame
		const lens = [9, 6, 11, 7]
		for (let i = 0; i < 4; i++) {
			const y = 3 + i * 2
			const wob = ((frame + i * 3 + seed) % 5) - 2
			const len = Math.max(2, Math.min(11, lens[i] + wob))
			const indent = i === 1 || i === 3 ? 3 : 2
			for (let x = 0; x < len && indent + x < 13; x++) put(indent + x, y, i === 0 ? TINT[kind] : CODE[(i + seed) % CODE.length])
		}
		// caret, blinking on alternate frames
		if (frame % 2 === 0) put(3, 9, [250, 250, 250])
	} else {
		// a faint reflection so an idle screen still looks like glass
		for (let x = 3; x < 11; x++) put(x, 3, [40, 44, 58])
	}
	const g: Grid = { w: W, h: H, grid }
	cache.set(key, g)
	return g
}

const badges = new Map<string, Grid>()

/**
 * The level badge, as its own one-tile image. It lives beside the desk rather
 * than on it: a seated occupant covers the desk surface, and a badge you cannot
 * see while someone is working is the wrong way round.
 */
export function badge(level: number, tier: RGB, face = ''): Grid {
	const key = level + ':' + tier.join('') + ':' + face
	const hit = badges.get(key)
	if (hit) return hit
	const grid: (RGB | null)[][] = Array.from({ length: 16 }, () => new Array<RGB | null>(16).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < 16 && y < 16) grid[y][x] = c
	}
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
	}
	const CARD: RGB = [238, 236, 228]
	const EDGE: RGB = [90, 92, 102]
	box(7, 0, 2, 2, EDGE)
	box(2, 2, 12, 13, EDGE)
	box(3, 3, 10, 3, tier)
	box(3, 6, 10, 8, CARD)
	const INK: RGB = [40, 42, 54]
	if (face) {
		const glyph = DIGITS[face] ?? DIGITS['0']
		glyph.forEach((r, y) => [...r].forEach((c, x) => c === '1' && put(6 + x, 8 + y, INK)))
	} else {
		// two digits fit: the card is ten pixels wide inside, a digit is three, so
		// 3+1+3 leaves a margin. Levels are open-ended now and mostly two digits.
		const text = String(Math.max(1, Math.min(99, level)))
		const startX = text.length > 1 ? 4 : 6
		;[...text].forEach((ch, i) => {
			const glyph = DIGITS[ch] ?? DIGITS['0']
			glyph.forEach((r, y) => [...r].forEach((c, x) => c === '1' && put(startX + i * 4 + x, 8 + y, INK)))
		})
	}
	const g: Grid = { w: 16, h: 16, grid }
	badges.set(key, g)
	return g
}

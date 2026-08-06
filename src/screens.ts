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
const H = 16

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

const cache = new Map<string, Grid>()

/**
 * `activity` shifts the line lengths so consecutive frames differ — a session
 * that is working has a screen that visibly changes. `off` screens are dark and
 * static, which is what makes an unoccupied desk read as unoccupied.
 */
export type Kind = 'edit' | 'read' | 'run' | 'search' | 'agent' | 'think'

/** Screen tint by tool class, so the whole room is readable at a glance. */
const TINT: Record<Kind, RGB> = {
	edit: [120, 170, 255],
	read: [110, 220, 235],
	run: [250, 180, 90],
	search: [200, 160, 250],
	agent: [160, 235, 150],
	think: [150, 160, 190],
}

export function monitor(lit: boolean, frame: number, seed = 0, kind: Kind = 'think'): Grid {
	const key = `${lit ? 1 : 0}:${lit ? frame % 4 : 0}:${seed % 8}:${kind}`
	const hit = cache.get(key)
	if (hit) return hit
	const grid: (RGB | null)[][] = Array.from({ length: H }, () => new Array<RGB | null>(W).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = c
	}
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
	}

	// stand and base, so it reads as a monitor and not a floating rectangle
	box(7, 12, 2, 2, BASE)
	box(5, 14, 6, 1, CASE)
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

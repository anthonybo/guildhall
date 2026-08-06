/**
 * Office worker sprites.
 *
 * The sheets are `char_0..5.png` from pixel-agents (MIT — see
 * assets/characters/LICENSE-pixel-agents.txt). Each is 112x96 laid out as three
 * direction rows (down, up, right) of seven 16x32 frames; left is the mirror of
 * right. Within a row: frames 0-2 are the walk cycle, 3-4 typing, 5-6 reading.
 *
 * A 16x32 frame is exactly one tile wide and two tall, which is what makes these
 * scale properly against the desks — the earlier creature tiles were square,
 * had no transparency, and had no notion of facing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePNG, type Image, type RGB } from './png.ts'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/characters')

export const FRAME_W = 16
export const FRAME_H = 32
const FRAMES_PER_ROW = 7
const ROWS = ['down', 'up', 'right'] as const

export type Facing = 'down' | 'up' | 'right' | 'left'
export type Pose = 'walk' | 'typing' | 'reading'
export type Grid = { w: number; h: number; grid: (RGB | null)[][] }

const POSE_FRAMES: Record<Pose, number[]> = {
	walk: [0, 1, 2, 1], // 3 drawn frames make a 4-step cycle
	typing: [3, 4],
	reading: [5, 6],
}

const sheets: Image[] = []
export function loadSheets() {
	if (sheets.length) return sheets.length
	const files = fs
		.readdirSync(DIR)
		.filter((f) => /^char_\d+\.png$/.test(f))
		.sort()
	for (const f of files) sheets.push(decodePNG(path.join(DIR, f)))
	return sheets.length
}

export const paletteCount = () => (sheets.length ? sheets.length : loadSheets())

/** Pull one frame out of a sheet as a grid of pixels, transparent where alpha is low. */
function extract(img: Image, rowIdx: number, frame: number, flip: boolean): Grid {
	const x0 = frame * FRAME_W
	const y0 = rowIdx * FRAME_H
	const grid: (RGB | null)[][] = []
	for (let y = 0; y < FRAME_H; y++) {
		const row: (RGB | null)[] = []
		for (let x = 0; x < FRAME_W; x++) {
			const sx = flip ? x0 + (FRAME_W - 1 - x) : x0 + x
			const i = ((y0 + y) * img.w + sx) * 4
			row.push(img.rgba[i + 3] < 128 ? null : [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]])
		}
		grid.push(row)
	}
	return { w: FRAME_W, h: FRAME_H, grid }
}

/** Rotate hue so two sessions on the same sheet are still told apart. */
function hueRotate(g: Grid, deg: number): Grid {
	if (!deg) return g
	const a = (deg * Math.PI) / 180
	const c = Math.cos(a)
	const s = Math.sin(a)
	// standard luma-preserving hue rotation matrix
	const m = [
		0.213 + c * 0.787 - s * 0.213,
		0.715 - c * 0.715 - s * 0.715,
		0.072 - c * 0.072 + s * 0.928,
		0.213 - c * 0.213 + s * 0.143,
		0.715 + c * 0.285 + s * 0.14,
		0.072 - c * 0.072 - s * 0.283,
		0.213 - c * 0.213 - s * 0.787,
		0.715 - c * 0.715 + s * 0.715,
		0.072 + c * 0.928 + s * 0.072,
	]
	const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
	return {
		w: g.w,
		h: g.h,
		grid: g.grid.map((row) =>
			row.map((p) =>
				p
					? ([
							clamp(p[0] * m[0] + p[1] * m[1] + p[2] * m[2]),
							clamp(p[0] * m[3] + p[1] * m[4] + p[2] * m[5]),
							clamp(p[0] * m[6] + p[1] * m[7] + p[2] * m[8]),
						] as RGB)
					: null,
			),
		),
	}
}

/** Box-downscale a frame to the size the office actually draws at. */
export function shrink(g: Grid, w: number, h: number): Grid {
	if (w === g.w && h === g.h) return g
	const out: (RGB | null)[][] = []
	const sx = g.w / w
	const sy = g.h / h
	for (let y = 0; y < h; y++) {
		const row: (RGB | null)[] = []
		for (let x = 0; x < w; x++) {
			const tally = new Map<number, number>()
			let opaque = 0
			let total = 0
			for (let yy = Math.floor(y * sy); yy < Math.max(Math.ceil((y + 1) * sy), Math.floor(y * sy) + 1); yy++) {
				for (let xx = Math.floor(x * sx); xx < Math.max(Math.ceil((x + 1) * sx), Math.floor(x * sx) + 1); xx++) {
					if (yy >= g.h || xx >= g.w) continue
					total++
					const p = g.grid[yy][xx]
					if (!p) continue
					opaque++
					const k = (p[0] << 16) | (p[1] << 8) | p[2]
					tally.set(k, (tally.get(k) ?? 0) + 1)
				}
			}
			if (!total || opaque * 2 < total || !tally.size) {
				row.push(null)
				continue
			}
			// dominant colour, not an average — averaging turns pixel art to mud
			let best = 0
			let bestN = -1
			for (const [k, n] of tally) if (n > bestN) ((bestN = n), (best = k))
			row.push([(best >> 16) & 255, (best >> 8) & 255, best & 255])
		}
		out.push(row)
	}
	return { w, h, grid: out }
}

const cache = new Map<string, Grid>()

/**
 * One animation frame, at native 16x32. `step` indexes into the pose's cycle.
 */
/**
 * Stamp a small badge onto the torso, like a name tag pinned to a shirt. It is
 * composited into the sprite rather than drawn beside it, so it travels with the
 * character and can never collide with anything.
 */
function pinBadge(g: Grid, colour: RGB): Grid {
	const grid = g.grid.map((row) => [...row])
	// the torso band, below the head and above the legs
	const top = Math.round(g.h * 0.58)
	for (let y = top; y < Math.min(g.h, top + 6); y++) {
		const row = grid[y]
		const first = row.findIndex((c) => c)
		const last = row.reduce((acc, c, i) => (c ? i : acc), -1)
		if (first < 0 || last - first < 3) continue
		// one pixel in from the wearer's left, two by two
		const x = first + 1
		for (let dy = 0; dy < 2; dy++)
			for (let dx = 0; dx < 2; dx++) {
				const r = grid[y + dy]
				if (r && r[x + dx]) r[x + dx] = colour
			}
		return { w: g.w, h: g.h, grid }
	}
	return { w: g.w, h: g.h, grid }
}

export function frameOf(palette: number, hueShift: number, facing: Facing, pose: Pose, step: number, badge?: RGB): Grid {
	loadSheets()
	const key = `${palette}:${hueShift}:${facing}:${pose}:${step}:${badge?.join('') ?? ''}`
	const hit = cache.get(key)
	if (hit) return hit
	const sheet = sheets[palette % sheets.length]
	const cycle = POSE_FRAMES[pose]
	const frame = cycle[step % cycle.length]
	const rowIdx = ROWS.indexOf(facing === 'left' ? 'right' : facing)
	let g = hueRotate(extract(sheet, rowIdx < 0 ? 0 : rowIdx, frame, facing === 'left'), hueShift)
	if (badge) g = pinBadge(g, badge)
	cache.set(key, g)
	return g
}

/**
 * Give every session a visually distinct look: walk the sheets first, and only
 * once they are exhausted start rotating hue. Assigning by index rather than by
 * hashing avoids the collisions a hash guarantees well before you run out.
 */
export function assignLooks(ids: string[]) {
	const n = paletteCount()
	const out = new Map<string, { palette: number; hueShift: number }>()
	ids.forEach((id, i) => {
		out.set(id, { palette: i % n, hueShift: Math.floor(i / n) * 55 })
	})
	return out
}

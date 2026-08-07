/**
 * Compositing the room into a pixel buffer.
 *
 * The terminal stacks four layers to draw the office — the half-block canvas,
 * then furniture, workstations, badges and finally people — and every one of them
 * is already a grid of RGB values. So the same stack produces a plain RGBA buffer,
 * which is what both the documentation renderer and the browser need. Neither one
 * has a terminal to place kitty images into.
 *
 * No node imports, on purpose: this runs in a browser.
 */
import type { Canvas } from './canvas.ts'
import type { Grid } from './characters.ts'
import { frameOf } from './characters.ts'
import { badge, monitor } from './screens.ts'
import { PROP_SIZE, prop } from './props.ts'
import { LOOK, tierOf, type RGB } from './theme.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, PLATE_COLS, PLATE_ROWS, TILE, type Placed } from './office/model.ts'
import { choose, plate } from './nameplate.ts'

const INK: RGB = [32, 34, 46]
const NIGHT: RGB = [26, 28, 40]

/** What the compositor needs from an Office, so tests can pass a plain object. */
export type Scene = {
	plates: { x: number; y: number; proj: string; colour: RGB }[]
	monitors: { x: number; y: number; lit: boolean; seed: number; kind: RGB extends never ? never : any }[]
	badges: { x: number; y: number; level: number; asking: boolean }[]
	props: { kind: keyof typeof PROP_SIZE; x: number; y: number }[]
}

export type Buffer2D = { rgba: Uint8ClampedArray; w: number; h: number }

/**
 * `sx` is pixels per terminal column, `sy` per row. At 4 and 8 a 16x32 character
 * sprite lands 1:1 with no resampling, which is the sharpest this can be; larger
 * multiples of those stay sharp too.
 */
export function renderRoom(cv: Canvas, scene: Scene, placed: Placed[], sx: number, sy: number, frame = 2): Buffer2D {
	const w = cv.w * sx
	const h = cv.rows * sy
	const rgba = new Uint8ClampedArray(w * h * 4)

	const put = (x0: number, y0: number, bw: number, bh: number, c: RGB) => {
		for (let y = y0; y < y0 + bh; y++) {
			if (y < 0 || y >= h) continue
			for (let x = x0; x < x0 + bw; x++) {
				if (x < 0 || x >= w) continue
				const i = (y * w + x) * 4
				rgba[i] = c[0]
				rgba[i + 1] = c[1]
				rgba[i + 2] = c[2]
				rgba[i + 3] = 255
			}
		}
	}

	/** Nearest-neighbour into a box, which is what the terminal does to an image. */
	const stamp = (g: Grid, x0: number, y0: number, boxW: number, boxH: number) => {
		for (let y = 0; y < boxH; y++) {
			const gy = Math.min(g.h - 1, Math.floor((y * g.h) / boxH))
			for (let x = 0; x < boxW; x++) {
				const gx = Math.min(g.w - 1, Math.floor((x * g.w) / boxW))
				const c = g.grid[gy][gx]
				if (!c) continue // transparent: the floor shows through
				const px = x0 + x
				const py = y0 + y
				if (px < 0 || py < 0 || px >= w || py >= h) continue
				const i = (py * w + px) * 4
				rgba[i] = c[0]
				rgba[i + 1] = c[1]
				rgba[i + 2] = c[2]
				rgba[i + 3] = 255
			}
		}
	}

	// one canvas pixel is one column wide and half a row tall
	for (let y = 0; y < cv.h; y++) {
		for (let x = 0; x < cv.w; x++) {
			const c = cv.get(x, y)
			if (c) put(x * sx, y * (sy / 2), sx, sy / 2, c)
		}
	}
	for (const pr of scene.props) {
		const size = PROP_SIZE[pr.kind]
		stamp(prop(pr.kind), pr.x * sx, pr.y * sx, size.w * TILE * sx, ((size.h * TILE) / 2) * sy)
	}
	for (const m of scene.monitors) {
		stamp(monitor(m.lit, frame, m.seed, m.kind), m.x * sx, m.y * sx, MON_COLS * sx, MON_ROWS * sy)
	}
	// Nameplates. Authored at the box size like everything else here; the caller
	// picks sx/sy large enough for the font's ink band to fit across two columns.
	for (const p of scene.plates) {
		const pick = choose(p.proj, PLATE_COLS * sx, PLATE_ROWS * sy)
		if (pick) stamp(plate(pick.font, pick.text, PLATE_COLS * sx, PLATE_ROWS * sy, p.colour, INK, NIGHT), p.x * sx, p.y * sx, PLATE_COLS * sx, PLATE_ROWS * sy)
	}
	for (const b of scene.badges) {
		const tint = b.asking ? LOOK.needs.color : tierOf(b.level).color
		stamp(badge(b.level, tint, b.asking ? '?' : ''), b.x * sx, b.y * sx, TILE * sx, (TILE / 2) * sy)
	}
	for (const p of placed) {
		const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color)
		stamp(g, p.x * sx, p.y * sx, CHAR_W * sx, (CHAR_H / 2) * sy)
	}
	return { rgba, w, h }
}

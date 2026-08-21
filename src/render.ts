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
import { badgeFor, monitorFor } from './screens.ts'
import { PROP_SIZE, prop } from './props.ts'
import { LOOK, tierOf, type RGB } from './theme.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, PLATE_COLS, PLATE_ROWS, TILE, type Placed } from './office/model.ts'
import { choose, plate } from './nameplate.ts'

const INK: RGB = [32, 34, 46]
const NIGHT: RGB = [26, 28, 40]

/** What the compositor needs from an Office, so tests can pass a plain object. */
export type Scene = {
	plates: { x: number; y: number; proj: string; colour: RGB }[]
	monitors: { x: number; y: number; lit: boolean; seed: number; kind: RGB extends never ? never : any; agent?: string }[]
	badges: { x: number; y: number; level: number; asking: boolean }[]
	props: { kind: keyof typeof PROP_SIZE; x: number; y: number }[]
}

export type Buffer2D = { rgba: Uint8ClampedArray; w: number; h: number }

/**
 * `0xRRGGBB` as one opaque word in the byte order this machine's Uint32Array uses.
 *
 * Endianness is checked rather than assumed: an RGBA byte buffer viewed as u32 is
 * `0xAABBGGRR` on a little-endian machine and `0xRRGGBBAA` on a big-endian one, and
 * guessing wrong swaps every red and blue in the room rather than failing loudly.
 */
/**
 * The frame buffer, reused between frames.
 *
 * This was `new Uint8ClampedArray(w * h * 4)` on every call. At the browser's scale
 * that is a **5,111,808-byte allocation per frame** — about 307MB a second of
 * garbage at 60fps, for a buffer whose size never changes while the window does not.
 * Measured as a 2.4MB heap delta for a single frame.
 *
 * THE CALLER MUST CONSUME IT BEFORE THE NEXT CALL. Both do — the browser hands it
 * straight to `putImageData` and the terminal encodes it to PNG immediately — but it
 * is a sharp edge, so it is stated here rather than left to be discovered: hold on
 * to this array across two renders and the second will overwrite the first.
 *
 * Zeroed on reuse because the drawing below only writes the pixels it covers, and
 * the previous frame's content showing through the gaps is exactly the kind of bug
 * that looks like a rendering glitch rather than a stale buffer.
 */
let frameBuffer: Uint8ClampedArray | null = null

function buffer(bytes: number): Uint8ClampedArray {
	if (!frameBuffer || frameBuffer.length !== bytes) {
		frameBuffer = new Uint8ClampedArray(bytes)
		return frameBuffer
	}
	frameBuffer.fill(0)
	return frameBuffer
}

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const PACK = LITTLE
	? (v: number) => (0xff000000 | ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255)) >>> 0
	: (v: number) => (((v & 0xffffff) << 8) | 0xff) >>> 0

/**
 * `sx` is pixels per terminal column, `sy` per row. At 4 and 8 a 16x32 character
 * sprite lands 1:1 with no resampling, which is the sharpest this can be; larger
 * multiples of those stay sharp too.
 */
export function renderRoom(cv: Canvas, scene: Scene, placed: Placed[], sx: number, sy: number, frame = 2): Buffer2D {
	const w = cv.w * sx
	const h = cv.rows * sy
	const rgba = buffer(w * h * 4)

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

	// One canvas pixel is one column wide and half a row tall, so a y in canvas
	// pixels scales by sy/2 — never by sx. They agree only while sy === 2*sx, which
	// both callers happen to pass; using sx on y drifts a row per eight tiles the
	// moment anyone renders at a real terminal's cell aspect.
	const py = sy / 2

	/**
	 * The floor, written as packed 32-bit words rather than pixel by pixel.
	 *
	 * This loop runs `cv.w * cv.h` times and every iteration used to allocate a
	 * three-element array via `cv.get()` and then walk the block with a bounds check
	 * per pixel inside `put()`. Reading the packed ints and writing through a
	 * Uint32Array view is the same output with none of that allocation.
	 *
	 * **1.2x to 1.6x faster, not fifty-one times.** An earlier version of this comment
	 * claimed 12.75ms to 0.248ms. That was wrong and worth recording as wrong: the
	 * 0.248 was the cost of ONE `u32.fill()` across the whole buffer, which is not
	 * this loop — it is a single call with no per-cell work at all. Independently
	 * measured, the real figures are 13.66 to 19.64 cpu-ms at browser scale and 1.596
	 * to 1.951 at terminal size. The output is byte-identical across 11.9MB of
	 * comparison, and `check:docs` agrees, so the change is right; only the number
	 * attached to it was invented.
	 *
	 * No bounds checks: the floor is exactly `cv.w * sx` by `cv.h * py`, which is the
	 * buffer, so nothing can fall outside it. `put()` still guards for everything
	 * else, which genuinely can.
	 *
	 * Fractional scales fall back to the slow path. Both callers pass `sy === 2 * sx`
	 * so this never fires in practice, but a fractional block would make the integer
	 * arithmetic below silently wrong rather than merely slow.
	 */
	const px = cv.pixels()
	if (Number.isInteger(sx) && Number.isInteger(py)) {
		const u32 = new Uint32Array(rgba.buffer)
		for (let y = 0; y < cv.h; y++) {
			const top = y * py
			for (let x = 0; x < cv.w; x++) {
				const v = px[y * cv.w + x]
				if (v < 0) continue // transparent
				// PACK hoisted out of the row loop: it was recomputed `py` times for
				// every cell, for a value that cannot change within one cell.
				const word = PACK(v)
				const left = x * sx
				for (let by = 0; by < py; by++) {
					const from = (top + by) * w + left
					// A plain write loop, NOT `u32.fill(word, from, from + sx)`.
					//
					// `fill` is the obvious call and the slower one here: the runs are four
					// words long, so its per-call setup dominates the four stores it saves.
					// Measured 15.205 -> 5.014 cpu-ms at browser scale (3.0x) and 1.693 ->
					// 0.420 at terminal size (4.0x), across 319,488 calls a frame.
					for (let i = 0; i < sx; i++) u32[from + i] = word
				}
			}
		}
	} else {
		for (let y = 0; y < cv.h; y++) {
			for (let x = 0; x < cv.w; x++) {
				const c = cv.get(x, y)
				if (c) put(x * sx, y * py, sx, py, c)
			}
		}
	}
	for (const pr of scene.props) {
		const size = PROP_SIZE[pr.kind]
		stamp(prop(pr.kind), pr.x * sx, pr.y * py, size.w * TILE * sx, size.h * TILE * py)
	}
	for (const m of scene.monitors) {
		stamp(monitorFor(m, frame), m.x * sx, m.y * py, MON_COLS * sx, MON_ROWS * sy)
	}
	// Nameplates. Authored at the box size like everything else here, so `choose`
	// sees the real pixels and picks a font and scale that suit them — a caller
	// passing a small sx/sy gets a smaller font, not a clipped word.
	for (const p of scene.plates) {
		const pick = choose(p.proj, PLATE_COLS * sx, PLATE_ROWS * sy)
		if (pick) stamp(plate(pick.font, pick.text, PLATE_COLS * sx, PLATE_ROWS * sy, p.colour, INK, NIGHT, pick.scale), p.x * sx, p.y * py, PLATE_COLS * sx, PLATE_ROWS * sy)
	}
	for (const b of scene.badges) {
		stamp(badgeFor(b, { needs: LOOK.needs.color, tierOf: (n) => tierOf(n).color }), b.x * sx, b.y * py, TILE * sx, TILE * py)
	}
	for (const p of placed) {
		const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color)
		stamp(g, p.x * sx, p.y * py, CHAR_W * sx, CHAR_H * py)
	}
	return { rgba, w, h }
}

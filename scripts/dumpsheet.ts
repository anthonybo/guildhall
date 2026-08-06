/** Blow up a character sheet with a frame grid so the layout can be eyeballed. */
import fs from 'node:fs'
import { decodePNG } from '../src/png.ts'
import { encodePNG } from '../src/kitty.ts'
const img = decodePNG('assets/characters/char_0.png')
const S = 6
const W = img.w * S
const H = img.h * S
const out = new Uint8ClampedArray(W * H * 4)
for (let y = 0; y < H; y++)
	for (let x = 0; x < W; x++) {
		const sx = (x / S) | 0
		const sy = (y / S) | 0
		const i = (sy * img.w + sx) * 4
		const o = (y * W + x) * 4
		const grid = sx % 16 === 0 || sy % 32 === 0
		out[o + 3] = 255
		if (img.rgba[i + 3] < 128) {
			const c = ((x >> 3) + (y >> 3)) % 2 ? 70 : 45
			out[o] = out[o + 1] = out[o + 2] = c
		} else {
			out[o] = img.rgba[i]
			out[o + 1] = img.rgba[i + 1]
			out[o + 2] = img.rgba[i + 2]
		}
		if (grid) {
			out[o] = 230
			out[o + 1] = 40
			out[o + 2] = 40
		}
	}
fs.writeFileSync('/tmp/sheet.png', encodePNG(out, W, H))
console.log(`sheet ${img.w}x${img.h} -> /tmp/sheet.png ${W}x${H} (frames 16x32, rows down/up/right)`)

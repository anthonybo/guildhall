// PNG reading and pixel-art scaling. No dependencies beyond node's zlib.
import fs from 'node:fs'
import zlib from 'node:zlib'

export type RGB = [number, number, number]
export type Sprite = { w: number; h: number; grid: (RGB | null)[][]; native: { w: number; h: number } }
export type Image = { w: number; h: number; rgba: Uint8ClampedArray }
export type Box = { x: number; y: number; w: number; h: number }

/** Decode an 8-bit, non-interlaced PNG (greyscale/rgb/palette/alpha) to RGBA. */
export function decodePNG(file: string): Image {
	const buf = fs.readFileSync(file)
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a png: ${file}`)
	let pos = 8
	let w = 0
	let h = 0
	let depth = 0
	let ctype = 0
	let interlace = 0
	let palette: Buffer | null = null
	let trns: Buffer | null = null
	const idat: Buffer[] = []
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos)
		const type = buf.toString('ascii', pos + 4, pos + 8)
		const data = buf.subarray(pos + 8, pos + 8 + len)
		if (type === 'IHDR') {
			w = data.readUInt32BE(0)
			h = data.readUInt32BE(4)
			depth = data[8]
			ctype = data[9]
			interlace = data[12]
		} else if (type === 'PLTE') palette = data
		else if (type === 'tRNS') trns = data
		else if (type === 'IDAT') idat.push(data)
		else if (type === 'IEND') break
		pos += 12 + len
	}
	if (interlace) throw new Error(`interlaced png unsupported: ${file}`)
	if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`unsupported bit depth ${depth}: ${file}`)
	const CH = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype]
	if (!CH) throw new Error(`unsupported colour type ${ctype}: ${file}`)

	// Palette and greyscale images may pack several pixels into one byte, so the
	// scanline is measured in bits and the filter works on whole bytes.
	const bitsPerPixel = depth * CH
	const stride = Math.ceil((w * bitsPerPixel) / 8)
	const fbpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
	const raw = zlib.inflateSync(Buffer.concat(idat))
	const out = Buffer.alloc(h * stride)
	for (let y = 0; y < h; y++) {
		const ft = raw[y * (stride + 1)]
		const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
		const cur = out.subarray(y * stride, (y + 1) * stride)
		const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
		for (let i = 0; i < stride; i++) {
			const a = i >= fbpp ? cur[i - fbpp] : 0
			const b = prior ? prior[i] : 0
			const c = prior && i >= fbpp ? prior[i - fbpp] : 0
			let v = src[i]
			if (ft === 1) v += a
			else if (ft === 2) v += b
			else if (ft === 3) v += (a + b) >> 1
			else if (ft === 4) {
				const p = a + b - c
				const pa = Math.abs(p - a)
				const pb = Math.abs(p - b)
				const pc = Math.abs(p - c)
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
			}
			cur[i] = v & 255
		}
	}

	const maxVal = (1 << depth) - 1
	const sample = (y: number, x: number, ch: number) => {
		if (depth === 8) return out[y * stride + x * CH + ch]
		if (depth === 16) return out[y * stride + (x * CH + ch) * 2] // high byte is plenty
		const bit = (x * CH + ch) * depth
		const byte = out[y * stride + (bit >> 3)]
		return (byte >> (8 - depth - (bit & 7))) & maxVal
	}
	const scale = (v: number) => Math.round((v * 255) / maxVal)

	const rgba = new Uint8ClampedArray(w * h * 4)
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let r = 0
			let g = 0
			let b = 0
			let a = 255
			if (ctype === 2) [r, g, b] = [sample(y, x, 0), sample(y, x, 1), sample(y, x, 2)]
			else if (ctype === 6) [r, g, b, a] = [sample(y, x, 0), sample(y, x, 1), sample(y, x, 2), sample(y, x, 3)]
			else if (ctype === 0) r = g = b = scale(sample(y, x, 0))
			else if (ctype === 4) {
				r = g = b = sample(y, x, 0)
				a = sample(y, x, 1)
			} else if (palette) {
				const idx = sample(y, x, 0)
				r = palette[idx * 3]
				g = palette[idx * 3 + 1]
				b = palette[idx * 3 + 2]
				if (trns && idx < trns.length) a = trns[idx]
			}
			rgba.set([r, g, b, a], (y * w + x) * 4)
		}
	}
	return { w, h, rgba }
}

/** Tightest box around non-transparent pixels, so padding never eats resolution. */
export function alphaBounds(img: Image, threshold = 8): Box {
	let x0 = img.w
	let y0 = img.h
	let x1 = -1
	let y1 = -1
	for (let y = 0; y < img.h; y++) {
		for (let x = 0; x < img.w; x++) {
			if (img.rgba[(y * img.w + x) * 4 + 3] > threshold) {
				if (x < x0) x0 = x
				if (y < y0) y0 = y
				if (x > x1) x1 = x
				if (y > y1) y1 = y
			}
		}
	}
	if (x1 < 0) return { x: 0, y: 0, w: img.w, h: img.h }
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * Downscale by taking the most common opaque colour in each source block.
 * Averaging blends neighbouring palette entries into mud and softens the hard
 * edges that make a small sprite readable; the mode keeps both intact.
 */
export function resamplePixelArt(img: Image, box: Box, dw: number, dh: number) {
	const grid: (RGB | null)[][] = []
	const sx = box.w / dw
	const sy = box.h / dh
	for (let y = 0; y < dh; y++) {
		const row: (RGB | null)[] = []
		const ay0 = box.y + y * sy
		const ay1 = box.y + (y + 1) * sy
		for (let x = 0; x < dw; x++) {
			const ax0 = box.x + x * sx
			const ax1 = box.x + (x + 1) * sx
			const tally = new Map<number, number>()
			let opaque = 0
			let total = 0
			for (let yy = Math.floor(ay0); yy < Math.max(Math.ceil(ay1), Math.floor(ay0) + 1); yy++) {
				for (let xx = Math.floor(ax0); xx < Math.max(Math.ceil(ax1), Math.floor(ax0) + 1); xx++) {
					if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue
					total++
					const i = (yy * img.w + xx) * 4
					if (img.rgba[i + 3] < 128) continue
					opaque++
					const key = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2]
					tally.set(key, (tally.get(key) ?? 0) + 1)
				}
			}
			// a mostly-empty block stays empty, which keeps silhouettes tight
			if (!total || opaque * 2 < total || !tally.size) {
				row.push(null)
				continue
			}
			let best = 0
			let bestN = -1
			for (const [k, n] of tally) if (n > bestN) ((bestN = n), (best = k))
			row.push([(best >> 16) & 255, (best >> 8) & 255, best & 255])
		}
		grid.push(row)
	}
	return { w: dw, h: dh, grid }
}

const cache = new Map<string, Sprite>()

/**
 * Load a sprite trimmed to its art and scaled to `targetH`.
 * targetH of 0, or anything at or above native, leaves it at native size —
 * these are pixel art and upscaling by a non-integer factor destroys them.
 */
export function loadSprite(file: string, targetH = 0): Sprite {
	const key = `${file}@${targetH}`
	const hit = cache.get(key)
	if (hit) return hit
	const img = decodePNG(file)
	const box = alphaBounds(img)
	const dh = !targetH || targetH >= box.h ? box.h : targetH
	const dw = dh === box.h ? box.w : Math.max(1, Math.round((box.w / box.h) * dh))
	const s = { ...resamplePixelArt(img, box, dw, dh), native: { w: box.w, h: box.h } }
	cache.set(key, s)
	return s
}

/** Render a sprite as upper-half-block rows: fg is the top pixel, bg the bottom. */
export function spriteRows(sp: Sprite): string[] {
	const R = '\x1b[0m'
	const lines: string[] = []
	for (let y = 0; y < sp.h; y += 2) {
		let out = ''
		for (let x = 0; x < sp.w; x++) {
			const t = sp.grid[y][x]
			const b = y + 1 < sp.h ? sp.grid[y + 1][x] : null
			if (!t && !b) out += ' '
			else if (!t) out += `\x1b[49m\x1b[38;2;${b![0]};${b![1]};${b![2]}m▄${R}`
			else if (!b) out += `\x1b[49m\x1b[38;2;${t[0]};${t[1]};${t[2]}m▀${R}`
			else out += `\x1b[48;2;${b[0]};${b[1]};${b[2]}m\x1b[38;2;${t[0]};${t[1]};${t[2]}m▀${R}`
		}
		lines.push(out)
	}
	return lines
}

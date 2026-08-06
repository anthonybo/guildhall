/**
 * Real images in the terminal, via the kitty graphics protocol.
 *
 * A terminal cell is one pixel wide when you draw with half blocks, which is why
 * block-drawn sprites are mushy. This sends actual PNG data instead, so a sprite
 * is limited by the font size rather than by the character grid.
 *
 * Ghostty (which cmux embeds), kitty and WezTerm implement it. Everything else
 * falls back to half blocks.
 */
import zlib from 'node:zlib'
import type { RGB } from './png.ts'

const ESC = '\x1b'

/* ── PNG encoding (the protocol's f=100 payload) ── */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c >>> 0
	}
	return t
})()

function crc32(buf: Buffer) {
	let c = 0xffffffff
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(td))
	return Buffer.concat([len, td, crc])
}

export function encodePNG(rgba: Uint8ClampedArray, w: number, h: number) {
	const raw = Buffer.alloc(h * (w * 4 + 1))
	const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length)
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0 // filter: none
		src.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8
	ihdr[9] = 6 // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

/** Nearest-neighbour upscale — the only filter that preserves pixel art. */
export function upscale(grid: (RGB | null)[][], factor: number) {
	const w = grid[0].length * factor
	const h = grid.length * factor
	const rgba = new Uint8ClampedArray(w * h * 4)
	for (let y = 0; y < h; y++) {
		const sy = (y / factor) | 0
		for (let x = 0; x < w; x++) {
			const c = grid[sy][(x / factor) | 0]
			if (!c) continue
			const i = (y * w + x) * 4
			rgba[i] = c[0]
			rgba[i + 1] = c[1]
			rgba[i + 2] = c[2]
			rgba[i + 3] = 255
		}
	}
	return { rgba, w, h }
}

/** Terminals that implement the protocol. Identity, not font probing — the
 *  glyphs and the image support both come from the terminal, not the font. */
export function supportsImages() {
	if (process.env.GUILDHALL_NO_IMAGES) return false
	if (process.env.KITTY_WINDOW_ID) return true
	const p = (process.env.TERM_PROGRAM ?? '').toLowerCase()
	return p === 'ghostty' || p === 'kitty' || p === 'wezterm'
}

/** Send image data once and keep it resident under `id`; place it later by id. */
export function transmit(id: number, png: Buffer) {
	const b64 = png.toString('base64')
	const SIZE = 4096 // the protocol caps one escape's payload at 4096 base64 bytes
	let out = ''
	for (let i = 0; i < b64.length; i += SIZE) {
		const piece = b64.slice(i, i + SIZE)
		const more = i + SIZE < b64.length ? 1 : 0
		const head = i === 0 ? `a=t,f=100,i=${id},q=2,m=${more}` : `m=${more}`
		out += `${ESC}_G${head};${piece}${ESC}\\`
	}
	return out
}

/**
 * Put an already-transmitted image at the cursor, sized to cols x rows cells.
 * C=1 leaves the cursor where it was, so placements never disturb text layout.
 * z=1 keeps sprites above the drawn background, which is opaque text cells.
 */
export function place(id: number, cols: number, rows: number, placement: number, z = 1) {
	return `${ESC}_Ga=p,i=${id},p=${placement},c=${cols},r=${rows},z=${z},C=1,q=2${ESC}\\`
}

/** Drop every visible placement but keep the transmitted images cached. */
export const clearPlacements = () => `${ESC}_Ga=d,d=a,q=2${ESC}\\`
/** Drop placements and free the images — used on exit. */
export const clearAll = () => `${ESC}_Ga=d,d=A,q=2${ESC}\\`

export const cursorTo = (row: number, col: number) => `\x1b[${row};${col}H`
/** DEC 2026: batch a whole frame so the terminal never shows a half-drawn one. */
export const SYNC_START = '\x1b[?2026h'
export const SYNC_END = '\x1b[?2026l'

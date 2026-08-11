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
	// Force it on regardless of what launched us. The benchmark needs this: it keys
	// on TERM_PROGRAM, which is unset under a GUI git client, a CI runner, tmux or
	// VS Code's terminal — so `npm run bench` there silently measured the half-block
	// path that production never takes, which is the exact failure the bench flag was
	// changed to avoid, arriving from the other direction. A gate that measures a
	// different renderer depending on who invoked it is not a gate.
	if (process.env.GUILDHALL_FORCE_IMAGES) return true
	if (process.env.KITTY_WINDOW_ID) return true
	const p = (process.env.TERM_PROGRAM ?? '').toLowerCase()
	return p === 'ghostty' || p === 'kitty' || p === 'wezterm'
}

/**
 * Ask the terminal to report when its surface becomes visible or hidden (DEC
 * 2033) and to send in-band size reports (DEC 2048).
 *
 * A cmux tab switch and a move to another display are exactly the two moments
 * images go missing, and neither raises SIGWINCH. 2033 fires on the first and
 * 2048 on the second, which turns a guess on a timer into an actual event.
 */
/** `CSI 16 t` asks for the cell size; see CELL_REPORT below for why we want it. */
export const WATCH_ON = '\x1b[?2033h\x1b[?2048h\x1b[?1004h\x1b[16t'
export const WATCH_OFF = '\x1b[?2033l\x1b[?2048l\x1b[?1004l'

/**
 * Replies these modes produce.
 *
 * 2033 is the correct signal but cmux's libghostty fork does not implement it —
 * DECRQM answers `\x1b[?2033;0$y`, meaning unrecognised, and `\x1b[?998n` is never
 * answered. Focus reporting (1004) is supported there and `\x1b[I` is the only
 * byte a workspace switch-back produces, so it is the practical trigger. Focus-out
 * is deliberately not a trigger: it is edge-triggered and a switch away from an
 * already-unfocused surface emits nothing at all.
 */
export const BECAME_VISIBLE = /\x1b\[\?999;1n/
export const FOCUS_IN = /\x1b\[I/
/** Consumed so it never reaches the key handler, but not a reason to re-send. */
export const FOCUS_OUT = /\x1b\[O/
export const SIZE_REPORT = /\x1b\[48;(\d+);(\d+);(\d+);(\d+)t/

/**
 * The size of one cell, in real pixels.
 *
 * Needed because a nameplate has to be authored at exactly the size the terminal
 * will draw it: kitty and Ghostty bilinear-filter images, so anything authored
 * larger gets averaged on the way down and 1px strokes wash out to grey. Two
 * sources, both already reaching us — the in-band size report (mode 2048) carries
 * rows, cols and the pixel size of the whole surface, and `CSI 16 t` asks for the
 * cell directly.
 */
export const CELL_REPORT = /\x1b\[6;(\d+);(\d+)t/

/** A typical monospace cell, used until the terminal says otherwise. */
export const DEFAULT_CELL = { w: 8, h: 17 }

/** Read a cell size out of either report, or null if the text is neither. */
export function cellFrom(s: string) {
	const c = CELL_REPORT.exec(s)
	if (c) return { w: Number(c[2]), h: Number(c[1]) }
	const m = /\x1b\[48;(\d+);(\d+);(\d+);(\d+)t/.exec(s)
	if (!m) return null
	const [rows, cols, hpx, wpx] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
	if (!rows || !cols || !hpx || !wpx) return null
	return { w: Math.round(wpx / cols), h: Math.round(hpx / rows) }
}
/** A placement naming an image the terminal no longer holds. Only ever seen when
 *  the command was not silenced with q=2. */
export const IMAGE_GONE = /\x1b_G[^\x1b]*;ENOENT[^\x1b]*\x1b\\/

/** Send image data once and keep it resident under `id`; place it later by id. */
export function transmit(id: number, png: Buffer) {
	const b64 = png.toString('base64')
	const SIZE = 4096 // the protocol caps one escape's payload at 4096 base64 bytes
	let out = ''
	for (let i = 0; i < b64.length; i += SIZE) {
		const piece = b64.slice(i, i + SIZE)
		const more = i + SIZE < b64.length ? 1 : 0
		// q=1: silent on success, but a quota or memory failure still reports
		const head = i === 0 ? `a=t,f=100,i=${id},q=1,m=${more}` : `m=${more}`
		out += `${ESC}_G${head};${piece}${ESC}\\`
	}
	return out
}

/**
 * Put an already-transmitted image at the cursor, sized to cols x rows cells.
 * C=1 leaves the cursor where it was, so placements never disturb text layout.
 * z=1 keeps sprites above the drawn background, which is opaque text cells.
 */
export function place(id: number, cols: number, rows: number, placement: number, z = 1, loud = false) {
	// One placement per frame goes out loud. If the terminal has dropped its image
	// store it answers ENOENT, which is the only direct signal that this happened;
	// the rest stay silent so a wipe does not return sixty-odd error replies.
	const q = loud ? 1 : 2
	return `${ESC}_Ga=p,i=${id},p=${placement},c=${cols},r=${rows},z=${z},C=1,q=${q}${ESC}\\`
}

/** Drop every visible placement but keep the transmitted images cached. */
export const clearPlacements = () => `${ESC}_Ga=d,d=a,q=2${ESC}\\`
/** Drop placements and free the images — used on exit. */
export const clearAll = () => `${ESC}_Ga=d,d=A,q=2${ESC}\\`

export const cursorTo = (row: number, col: number) => `\x1b[${row};${col}H`
/** DEC 2026: batch a whole frame so the terminal never shows a half-drawn one. */
export const SYNC_START = '\x1b[?2026h'
export const SYNC_END = '\x1b[?2026l'

/**
 * Split terminal replies out of a stdin chunk.
 *
 * Reports and keystrokes arrive on the same stream, so the reply regexes are
 * applied first and whatever survives is typing. A reply can straddle two reads,
 * so an incomplete trailing escape is returned in `rest` to be prepended next
 * time rather than delivered as a bare ESC plus garbage.
 *
 * `lost` is true when the terminal said an image is missing, or when the surface
 * became visible again, or when it reported a new size — all three mean the image
 * layer may need re-sending.
 */
export function demux(input: string) {
	let s = input
	let lost = false
	for (const re of [FOCUS_OUT]) {
		for (;;) {
			const m = re.exec(s)
			if (!m) break
			s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
		}
	}
	for (const re of [IMAGE_GONE, BECAME_VISIBLE, SIZE_REPORT, CELL_REPORT, FOCUS_IN]) {
		for (;;) {
			const m = re.exec(s)
			if (!m) break
			s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
			lost = true
		}
	}
	// A trailing escape that has not terminated yet is held for the next chunk.
	// Termination follows ECMA-48: CSI takes parameter bytes 0x30-0x3F and
	// intermediates 0x20-0x2F, then any final byte 0x40-0x7E — so `~` ends a
	// sequence just as a letter does, and testing for letters alone wedged
	// bracketed paste. APC runs to ESC \\.
	const cut = s.lastIndexOf(ESC)
	if (cut >= 0) {
		const tail = s.slice(cut)
		const done =
			/^\x1b_[\s\S]*\x1b\\$/.test(tail) || // APC, terminated
			/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]$/.test(tail) || // CSI, terminated
			/^\x1b[O][\x40-\x7e]$/.test(tail) || // SS3 function key
			/^\x1b(?![[O])[\x30-\x7e]$/.test(tail) || // a bare two-byte escape, but `[` and `O` introduce more
			// A lone ESC is the Escape key, not the start of something. Holding it
			// meant Escape never arrived until another key followed — and worse, the
			// held byte then prefixed that key, so `ESC` then `?` reached the handler
			// as one unrecognised two-byte string and both were swallowed. Terminals
			// write a sequence in one go, so an ESC alone at the end of a read is a
			// keypress; the cost of being wrong is one stray Escape.
			tail === ESC
		// never hold indefinitely: an escape we do not understand must still reach
		// the key handler rather than silently eating everything typed after it
		if (!done && tail.length < 32) return { keys: s.slice(0, cut), rest: tail, lost }
	}
	return { keys: s, rest: '', lost }
}

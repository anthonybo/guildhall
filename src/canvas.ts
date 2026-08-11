/**
 * A pixel canvas that renders through the terminal's character grid.
 *
 * Two vertical pixels share one cell via the upper-half-block glyph — the top
 * pixel becomes the foreground colour and the bottom one the background. Text
 * written with `text()` replaces whole cells, so labels always sit on top.
 */
import { R, type RGB } from './theme.ts'

type Cell = { ch: string; fg: RGB | null; bg: RGB | null; bold?: boolean }

export class Canvas {
	w: number
	h: number
	rows: number
	private px: Int32Array
	private overlay: (Cell | null)[][]

	constructor(w: number, h: number) {
		this.w = w
		this.h = h + (h % 2)
		this.rows = this.h / 2
		this.px = new Int32Array(this.w * this.h)
		this.overlay = Array.from({ length: this.rows }, () => new Array<Cell | null>(this.w).fill(null))
	}

	clear(c?: RGB) {
		this.px.fill(c ? (c[0] << 16) | (c[1] << 8) | c[2] : -1)
		for (const r of this.overlay) r.fill(null)
	}

	set(x: number, y: number, c: RGB) {
		x |= 0
		y |= 0
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
		this.px[y * this.w + x] = (c[0] << 16) | (c[1] << 8) | c[2]
	}

	get(x: number, y: number): RGB | null {
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null
		const v = this.px[y * this.w + x]
		return v < 0 ? null : [(v >> 16) & 255, (v >> 8) & 255, v & 255]
	}

	/**
	 * The packed pixels, for a caller that walks all of them.
	 *
	 * `get()` allocates a three-element array per pixel, which is the right shape for
	 * reading one and the wrong shape for reading ten thousand: the room's floor loop
	 * did exactly that every frame and spent 12.75ms of a 16.7ms budget on it, most
	 * of it in allocation. Bulk readers take the ints and unpack them themselves —
	 * `0xRRGGBB`, negative meaning transparent.
	 */
	pixels(): Int32Array {
		return this.px
	}

	rect(x: number, y: number, w: number, h: number, c: RGB) {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c)
	}

	/** Blend a colour over what is already there — used for zone carpets. */
	tint(x: number, y: number, w: number, h: number, c: RGB, amount: number) {
		for (let j = 0; j < h; j++) {
			for (let i = 0; i < w; i++) {
				const base = this.get(x + i, y + j)
				if (!base) continue
				this.set(x + i, y + j, [
					base[0] + (c[0] - base[0]) * amount,
					base[1] + (c[1] - base[1]) * amount,
					base[2] + (c[2] - base[2]) * amount,
				] as RGB)
			}
		}
	}

	outline(x: number, y: number, w: number, h: number, c: RGB) {
		for (let i = 0; i < w; i++) {
			this.set(x + i, y, c)
			this.set(x + i, y + h - 1, c)
		}
		for (let j = 0; j < h; j++) {
			this.set(x, y + j, c)
			this.set(x + w - 1, y + j, c)
		}
	}

	blit(x: number, y: number, sp: { w: number; h: number; grid: (RGB | null)[][] }) {
		for (let j = 0; j < sp.h; j++)
			for (let i = 0; i < sp.w; i++) {
				const c = sp.grid[j][i]
				if (c) this.set(x + i, y + j, c)
			}
	}

	/** The text cell at a position, if one was written there.
	 *
	 *  Needed by the documentation renderer, which composites the pixel layer as a
	 *  raster and re-draws these as real glyphs on top — a nameplate flattened into
	 *  half blocks is unreadable at any size. */
	cellAt(col: number, row: number): Cell | null {
		return this.overlay[row]?.[col] ?? null
	}

	text(col: number, row: number, s: string, f: RGB | null, b: RGB | null, bold = false) {
		if (row < 0 || row >= this.rows) return
		for (const [i, ch] of [...s].entries()) {
			const c = col + i
			if (c < 0 || c >= this.w) continue
			this.overlay[row][c] = { ch, fg: f, bg: b, bold }
		}
	}

	render(): string[] {
		const lines: string[] = []
		for (let r = 0; r < this.rows; r++) {
			let out = ''
			let cf = -2
			let cb = -2
			// bold is a single cell attribute, tracked like the colours so it is only
			// emitted on change — a vertical nameplate is one glyph per row, and a
			// regular-weight glyph at that spacing reads as scattered dots
			let cbold = false
			const ov = this.overlay[r]
			const t0 = r * 2 * this.w
			const b0 = (r * 2 + 1) * this.w
			for (let x = 0; x < this.w; x++) {
				const o = ov[x]
				let top: number
				let bot: number
				let ch: string
				if (o) {
					top = o.fg ? (o.fg[0] << 16) | (o.fg[1] << 8) | o.fg[2] : -1
					bot = o.bg ? (o.bg[0] << 16) | (o.bg[1] << 8) | o.bg[2] : -1
					ch = o.ch
				} else {
					top = this.px[t0 + x]
					bot = this.px[b0 + x]
					ch = top < 0 && bot < 0 ? ' ' : '▀'
				}
				if (top !== cf) {
					out += top < 0 ? '\x1b[39m' : `\x1b[38;2;${(top >> 16) & 255};${(top >> 8) & 255};${top & 255}m`
					cf = top
				}
				if (bot !== cb) {
					out += bot < 0 ? '\x1b[49m' : `\x1b[48;2;${(bot >> 16) & 255};${(bot >> 8) & 255};${bot & 255}m`
					cb = bot
				}
				const wantBold = !!o?.bold
				if (wantBold !== cbold) {
					out += wantBold ? '\x1b[1m' : '\x1b[22m'
					cbold = wantBold
				}
				out += ch
			}
			lines.push(out + R)
		}
		return lines
	}
}

/**
 * The town. Each project is a building; each live session is a creature living
 * there. The background is drawn into a pixel canvas rendered with half blocks,
 * and the creatures are returned as placements so the caller can draw them as
 * real images where the terminal supports it.
 */
import { C, LOOK, ROOFS, R, fg, bg, type RGB } from './theme.ts'
import { cut, RANK, type Session } from './data.ts'

type Cell = { ch: string; fg: RGB | null; bg: RGB | null }

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
	rect(x: number, y: number, w: number, h: number, c: RGB) {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c)
	}
	blit(x: number, y: number, sp: { w: number; h: number; grid: (RGB | null)[][] }) {
		for (let j = 0; j < sp.h; j++)
			for (let i = 0; i < sp.w; i++) {
				const c = sp.grid[j][i]
				if (c) this.set(x + i, y + j, c)
			}
	}
	text(col: number, row: number, s: string, f: RGB | null, b: RGB | null) {
		if (row < 0 || row >= this.rows) return
		for (const [i, ch] of [...s].entries()) {
			const c = col + i
			if (c < 0 || c >= this.w) continue
			this.overlay[row][c] = { ch, fg: f, bg: b }
		}
	}
	render(): string[] {
		const lines: string[] = []
		for (let r = 0; r < this.rows; r++) {
			let out = ''
			let cf = -2
			let cb = -2
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
				out += ch
			}
			lines.push(out + R)
		}
		return lines
	}
}

const rnd = (seed: number) => {
	let s = seed >>> 0
	return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)
}
const hash = (s: string) => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

function drawGrass(cv: Canvas, x: number, y: number, w: number, h: number, seed: number) {
	cv.rect(x, y, w, h, C.grass)
	const r = rnd(seed)
	for (let i = 0; i < (w * h) / 14; i++) {
		const px = x + ((r() * w) | 0)
		const py = y + ((r() * h) | 0)
		const c = r() < 0.5 ? C.grassDk : C.grassLt
		cv.set(px, py, c)
		if (r() < 0.4) cv.set(px + 1, py, c)
	}
}

function drawPath(cv: Canvas, x: number, y: number, w: number, h: number, seed: number) {
	cv.rect(x, y, w, h, C.path)
	const r = rnd(seed)
	for (let i = 0; i < (w * h) / 18; i++) cv.set(x + ((r() * w) | 0), y + ((r() * h) | 0), C.pathDk)
	for (let i = 0; i < w; i++) {
		cv.set(x + i, y, C.pathEdge)
		cv.set(x + i, y + h - 1, C.pathEdge)
	}
}

function drawBuilding(cv: Canvas, x: number, y: number, w: number, h: number, roof: RGB) {
	const roofH = Math.max(4, Math.round(h * 0.42))
	const dark: RGB = [Math.max(0, roof[0] - 52), Math.max(0, roof[1] - 52), Math.max(0, roof[2] - 52)]
	for (let j = 0; j < roofH; j++) {
		const inset = j === 0 ? 2 : 0
		cv.rect(x - 2 + inset, y + j, w + 4 - inset * 2, 1, j === 0 ? dark : roof)
	}
	cv.rect(x - 2, y + roofH - 1, w + 4, 1, dark)
	const wy = y + roofH
	const wh = h - roofH
	cv.rect(x, wy, w, wh, C.wall)
	cv.rect(x, wy + wh - 1, w, 1, C.wallSh)
	const dw = Math.max(5, Math.round(w * 0.22))
	const dh = Math.max(6, wh - 2)
	const dx = x + ((w - dw) >> 1)
	const dy = wy + wh - dh
	cv.rect(dx, dy, dw, dh, C.door)
	cv.rect(dx, dy, dw, 1, C.doorDk)
	cv.set(dx + dw - 2, dy + (dh >> 1), [246, 220, 120])
	const ww = Math.max(3, Math.round(w * 0.16))
	if (dx - x > ww + 2) {
		cv.rect(x + 2, wy + 2, ww, ww, C.windowFrame)
		cv.rect(x + 3, wy + 3, ww - 2, ww - 2, C.window)
		cv.rect(x + w - 2 - ww, wy + 2, ww, ww, C.windowFrame)
		cv.rect(x + w - 1 - ww, wy + 3, ww - 2, ww - 2, C.window)
	}
	return { doorX: dx + (dw >> 1), doorY: dy + dh }
}

function drawTree(cv: Canvas, x: number, y: number) {
	cv.rect(x + 3, y + 8, 2, 3, C.trunk)
	for (let j = 0; j < 8; j++) {
		const inset = j < 2 || j > 6 ? 2 : 0
		cv.rect(x + inset, y + j, 8 - inset * 2, 1, j < 3 ? C.tree : C.treeDk)
	}
	cv.rect(x + 2, y + 1, 3, 2, [80, 160, 88])
}

export type Placement = { s: Session; tile: string; x: number; y: number }
type Lot = {
	proj: string
	members: Session[]
	x: number
	y: number
	bx: number
	by: number
	yardY: number
	signX: number
	signY: number
	roof: RGB
	seed: number
	shown: Session[]
	indoors: number
}

type Actor = { x: number; y: number; wander: number; bob: number; moving: boolean }

export class Town {
	w: number
	h: number
	t = 0
	lotW = 0
	lotH = 0
	bldW = 0
	bldH = 0
	spriteH = 16
	hiddenLots = 0
	lots: Lot[] = []
	private actors = new Map<string, Actor>()

	constructor(w: number, h: number) {
		this.w = w
		this.h = h
	}

	/**
	 * Change the canvas the town is drawn into without discarding the creatures.
	 * Rebuilding the Town instead would reset every position, which reads as all
	 * of them teleporting at once.
	 */
	resize(w: number, h: number) {
		this.w = w
		this.h = h
	}

	layout(sessions: Session[]) {
		const byProj = new Map<string, Session[]>()
		for (const s of sessions) {
			const arr = byProj.get(s.proj) ?? []
			arr.push(s)
			byProj.set(s.proj, arr)
		}
		// When there is not room for every project, keep the ones with the most
		// going on: urgency first, then how many sessions are actually awake.
		let lots = [...byProj.entries()]
			.map(([proj, members]) => {
				members.sort((a, b) => RANK[a.state] - RANK[b.state] || a.stale - b.stale)
				return { proj, members, awake: members.filter((m) => m.state !== 'parked').length }
			})
			.sort(
				(a, b) =>
					RANK[a.members[0].state] - RANK[b.members[0].state] || b.awake - a.awake || a.proj.localeCompare(b.proj),
			)

		// One project per band, full width, house on the left and its creatures on
		// the path beside it. A grid of square lots wastes the horizontal room and
		// leaves each project space for only one creature.
		const cols = Math.max(1, Math.min(lots.length, Math.floor(this.w / 64)))
		const minLotH = 20
		const maxRows = Math.max(1, Math.floor((this.h - 2) / minLotH))
		this.hiddenLots = Math.max(0, lots.length - maxRows * cols)
		if (this.hiddenLots) lots = lots.slice(0, maxRows * cols)
		const rows = Math.ceil(lots.length / cols)
		this.lotW = Math.floor(this.w / cols)
		this.lotH = Math.floor((this.h - 2) / rows)
		this.bldH = Math.max(11, Math.min(22, this.lotH - 12))
		this.bldW = Math.max(16, Math.min(34, Math.round(this.lotW * 0.3)))
		const yard = this.lotH - 6
		this.spriteH = Math.max(12, Math.min(22, yard - this.bldH + 6))

		const seen = new Set<string>()
		this.lots = lots.map((lot, i) => {
			const x = (i % cols) * this.lotW
			const y = 2 + Math.floor(i / cols) * this.lotH
			// only sessions that are actually live get a body; parked ones are
			// indoors, which keeps the cast small enough to draw them big
			const outside = lot.members.filter((m) => m.state !== 'parked')
			const slotW = this.spriteH + 3
			const yardX = x + this.bldW + 8
			const slots = Math.max(1, Math.floor((x + this.lotW - 2 - yardX) / slotW))
			const shown = outside.slice(0, slots)
			const L: Lot = {
				...lot,
				x,
				y,
				bx: x + 4,
				by: y + 2,
				yardY: y + this.lotH - this.spriteH - 4,
				signX: Math.max(x + 1, x + 4 + ((this.bldW - Math.min(this.bldW, 13)) >> 1)),
				signY: y + 2 + this.bldH - 4,
				roof: ROOFS[hash(lot.proj) % ROOFS.length],
				seed: hash(lot.proj),
				shown,
				indoors: lot.members.length - shown.length,
			}
			shown.forEach((m, j) => {
				seen.add(m.id)
				;(m as any).homeX = yardX + j * slotW
				;(m as any).lot = L
				if (!this.actors.has(m.id))
					this.actors.set(m.id, { x: (m as any).homeX, y: L.yardY, wander: 0, bob: hash(m.id) % 7, moving: false })
			})
			return L
		})
		for (const id of [...this.actors.keys()]) if (!seen.has(id)) this.actors.delete(id)
	}

	tick() {
		this.t++
		for (const lot of this.lots) {
			for (const s of lot.shown) {
				const a = this.actors.get(s.id)
				if (!a) continue
				const home = (s as any).homeX as number
				let tx = home
				let ty = lot.yardY
				if (s.state === 'working' || s.state === 'shell') {
					tx = lot.bx + (this.bldW >> 1) - 8
					ty = lot.by + this.bldH - 2
				} else if (s.state === 'needs') {
					ty = lot.yardY - (this.t % 12 < 6 ? 2 : 0) // hop for attention
				} else if (this.t % 50 === 0 && Math.random() < 0.5) {
					a.wander = ((Math.random() * 18 - 9) | 0)
				}
				if (s.state === 'done') tx = home + a.wander
				const dx = tx - a.x
				if (Math.abs(dx) > 0.8) {
					a.x += Math.min(1.1, Math.abs(dx)) * Math.sign(dx)
					a.moving = true
				} else {
					a.x = tx
					a.moving = false
				}
				const dy = ty - a.y
				a.y += Math.abs(dy) > 0.8 ? Math.min(0.9, Math.abs(dy)) * Math.sign(dy) : dy
			}
		}
	}

	/** Draw the background and return where each creature should be placed. */
	draw(cv: Canvas): Placement[] {
		cv.clear(C.grass)
		for (const lot of this.lots) {
			drawGrass(cv, lot.x, lot.y, this.lotW, this.lotH, lot.seed)
			drawPath(cv, lot.x + 2, lot.y + this.lotH - 6, this.lotW - 4, 5, lot.seed + 1)
			drawBuilding(cv, lot.bx, lot.by, this.bldW, this.bldH, lot.roof)
			if (this.lotW > 70) drawTree(cv, lot.x + this.lotW - 11, lot.y + this.lotH - 17)
			// sign board hung on the wall, clamped so it never runs off the canvas
			const sw = Math.min(this.bldW, 13)
			cv.rect(lot.signX, lot.signY, sw, 6, C.sign)
			cv.rect(lot.signX, lot.signY, sw, 1, C.signPost)
		}
		const out: Placement[] = []
		for (const lot of this.lots) {
			for (const s of lot.shown) {
				const a = this.actors.get(s.id)
				if (!a) continue
				const bob = a.moving || s.state === 'working' ? ((this.t + a.bob) % 12 < 6 ? -1 : 0) : 0
				// images land on cell boundaries, so keep y even to avoid shimmer
				const y = (Math.round(a.y + bob) >> 1) << 1
				out.push({ s, tile: s.creature, x: Math.round(a.x), y })
			}
		}
		return out
	}

	/** Signs, name tags and speech bubbles, laid out so none of them overprint. */
	overlay(cv: Canvas, placements: Placement[], selected?: string) {
		for (const lot of this.lots) {
			const row = Math.floor(lot.signY / 2)
			cv.text(lot.signX, row, cut(lot.proj, Math.min(this.bldW, 13)), C.ink, C.sign)
			const counts: Record<string, number> = {}
			for (const m of lot.members) counts[m.state] = (counts[m.state] ?? 0) + 1
			const bits: string[] = []
			for (const k of ['needs', 'working', 'shell', 'done'] as const)
				if (counts[k]) bits.push(`${counts[k]} ${LOOK[k].label}`)
			if (counts.parked) bits.push(`${counts.parked} asleep inside`)
			const tone = counts.needs ? LOOK.needs.color : counts.working ? LOOK.working.color : C.muted
			cv.text(lot.x + 2, Math.floor(lot.y / 2), cut(bits.join(' · '), this.lotW - 4), tone, C.night)
		}

		const taken = new Map<number, [number, number][]>()
		const place = (row: number, col: number, len: number) => {
			const used = taken.get(row) ?? []
			let c = Math.max(0, Math.min(this.w - len, col))
			for (let guard = 0; guard < 40; guard++) {
				const hit = used.find((r) => c < r[1] && c + len > r[0])
				if (!hit) break
				c = hit[1] + 1
				if (c + len > this.w) return null
			}
			used.push([c, c + len])
			taken.set(row, used)
			return c
		}

		for (const p of [...placements].sort((a, b) => a.x - b.x)) {
			const s = p.s
			const look = LOOK[s.state]
			const spW = 16
			const spRows = Math.ceil(this.spriteH / 2)
			// tag under the feet: the cmux tab is what you act on, so lead with it
			const tagRow = Math.floor(p.y / 2) + spRows
			const sel = s.id === selected
			const tag = ` ${look.glyph}${s.tab ? ` ⌘${s.tab}` : ''} ${cut(s.title, 20)} `
			const tc = place(tagRow, p.x - 2, tag.length)
			if (tc !== null) cv.text(tc, tagRow, tag, sel ? C.gold : look.color, C.night)
			// bubble above the head: every creature outdoors has something to say
			if (!s.doing) continue
			const txt = ` ${cut(s.doing, Math.max(14, this.lotW - 6))} `
			const row = Math.floor(p.y / 2) - 1
			const bc = place(row, p.x + (spW >> 1) - (txt.length >> 1), txt.length)
			if (bc === null) continue
			const urgent = s.state === 'needs'
			const bgc = urgent ? look.color : C.paper
			cv.text(bc, row, txt, urgent ? C.paper : C.ink, bgc)
			cv.text(Math.max(0, p.x + (spW >> 1)), row + 1, '▘', bgc, null)
		}
	}
}

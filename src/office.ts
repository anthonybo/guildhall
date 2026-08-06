/**
 * The office: one shared room, on a tile grid, where every live session sits at
 * a desk and works.
 *
 * The model follows pixel-agents (MIT, pixel-agents-hq/pixel-agents), which
 * solves the problem our first attempt had. Movement is not a drift toward an x
 * coordinate — desks define seats, a session is assigned one, and it walks there
 * tile by tile along a BFS path. Idling is a bounded excursion (a few moves with
 * long pauses, then back to the desk for a rest) rather than continuous
 * wandering, which is what makes a room full of characters read as purposeful.
 */
import { C, LOOK, ROOFS, type RGB } from './theme.ts'
import { cut, RANK, type Session, type State } from './data.ts'
import { Canvas } from './canvas.ts'

/**
 * 6px tiles. The whole room has to fit in roughly 60-90 canvas pixels of height,
 * so the tile has to be small enough for three or four desk rows to exist —
 * otherwise there are fewer seats than sessions and people end up standing.
 */
export const TILE = 6

/* ── timing, in seconds; the loop feeds real dt so these are wall-clock ── */
const WALK_TILES_PER_SEC = 2.6
const TYPE_FRAME_SEC = 0.3
const WALK_FRAME_SEC = 0.15
const WANDER_PAUSE_MIN = 2
const WANDER_PAUSE_MAX = 20
const WANDER_MOVES_MIN = 3
const WANDER_MOVES_MAX = 6
const SEAT_REST_MIN = 45
const SEAT_REST_MAX = 150
const DONE_BUBBLE_SEC = 6

type Kind = 'void' | 'floor' | 'wall' | 'desk'
export type Dir = 'up' | 'down' | 'left' | 'right'

type Seat = { id: string; col: number; row: number; facing: Dir; zone: string; taken: string | null }
type Zone = { proj: string; color: RGB; cols: [number, number]; rows: [number, number] }

export type Character = {
	id: string
	state: 'idle' | 'walk' | 'type'
	dir: Dir
	x: number
	y: number
	col: number
	row: number
	path: { col: number; row: number }[]
	progress: number
	frame: number
	frameTimer: number
	wanderTimer: number
	wanderCount: number
	wanderLimit: number
	seatTimer: number
	seatId: string | null
	bubble: 'permission' | 'done' | null
	bubbleTimer: number
	hueShift: number
}

export type Placed = { s: Session; ch: Character; tile: string; x: number; y: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1))
const hash = (s: string) => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

export class Office {
	cols = 0
	rows = 0
	w = 0
	h = 0
	seats = new Map<string, Seat>()
	zones: Zone[] = []
	chars = new Map<string, Character>()
	hiddenCount = 0
	private grid: Kind[][] = []
	private walkable: { col: number; row: number }[] = []
	private geom = ''

	/** Rebuild the room only when the canvas size changes; characters persist. */
	fit(wPx: number, hPx: number) {
		const cols = Math.max(12, Math.floor(wPx / TILE))
		const rows = Math.max(8, Math.floor(hPx / TILE))
		const key = `${cols}x${rows}`
		if (key === this.geom) return
		this.geom = key
		this.cols = cols
		this.rows = rows
		this.w = wPx
		this.h = hPx
		this.build()
	}

	/**
	 * A floor plan of desk rows with aisles between them. Each desk row is a band
	 * of desk tiles with the seats on the row below, facing up into the desk.
	 */
	private build() {
		this.grid = Array.from({ length: this.rows }, () => new Array<Kind>(this.cols).fill('floor'))
		for (let c = 0; c < this.cols; c++) {
			this.grid[0][c] = 'wall'
			this.grid[this.rows - 1][c] = 'wall'
		}
		for (let r = 0; r < this.rows; r++) {
			this.grid[r][0] = 'wall'
			this.grid[r][this.cols - 1] = 'wall'
		}
		this.seats.clear()
		// Bands of (desk row, seat row) with a walking aisle after each pair. One
		// desk per tile with a gap between, so a band seats as many as it can.
		let n = 0
		for (let r = 2; r < this.rows - 2; r += 3) {
			const seatRow = r + 1
			if (seatRow >= this.rows - 1) break
			for (let c = 2; c < this.cols - 2; c += 2) {
				this.grid[r][c] = 'desk'
				const id = `s${n++}`
				this.seats.set(id, { id, col: c, row: seatRow, facing: 'up', zone: '', taken: null })
			}
		}
		this.walkable = []
		for (let r = 0; r < this.rows; r++)
			for (let c = 0; c < this.cols; c++) if (this.grid[r][c] === 'floor') this.walkable.push({ col: c, row: r })
	}

	private isWalkable(col: number, row: number) {
		if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false
		const t = this.grid[row][col]
		return t === 'floor'
	}

	/** BFS on a 4-connected grid. Excludes the start tile, includes the end. */
	private findPath(sc: number, sr: number, ec: number, er: number) {
		if (sc === ec && sr === er) return []
		if (!this.isWalkable(ec, er)) return []
		const key = (c: number, r: number) => `${c},${r}`
		const prev = new Map<string, string>()
		const seen = new Set([key(sc, sr)])
		let queue = [{ col: sc, row: sr }]
		while (queue.length) {
			const next: typeof queue = []
			for (const cur of queue) {
				for (const [dc, dr] of [
					[0, -1],
					[1, 0],
					[0, 1],
					[-1, 0],
				]) {
					const c = cur.col + dc
					const r = cur.row + dr
					const k = key(c, r)
					if (seen.has(k) || !this.isWalkable(c, r)) continue
					seen.add(k)
					prev.set(k, key(cur.col, cur.row))
					if (c === ec && r === er) {
						// walk the chain back to the start
						const out: { col: number; row: number }[] = []
						let at = k
						while (at !== key(sc, sr)) {
							const [pc, pr] = at.split(',').map(Number)
							out.push({ col: pc, row: pr })
							at = prev.get(at)!
						}
						return out.reverse()
					}
					next.push({ col: c, row: r })
				}
			}
			queue = next
		}
		return []
	}

	/** Assign seats, grouped so a project's sessions sit together. */
	assign(sessions: Session[]) {
		const byProj = new Map<string, Session[]>()
		for (const s of sessions) {
			const arr = byProj.get(s.proj) ?? []
			arr.push(s)
			byProj.set(s.proj, arr)
		}
		const projects = [...byProj.entries()]
			.map(([proj, members]) => {
				members.sort((a, b) => RANK[a.state] - RANK[b.state] || a.stale - b.stale)
				return { proj, members }
			})
			.sort((a, b) => RANK[a.members[0].state] - RANK[b.members[0].state] || b.members.length - a.members.length)

		// seats in reading order, handed out in contiguous runs per project
		const ordered = [...this.seats.values()].sort((a, b) => a.row - b.row || a.col - b.col)
		for (const seat of ordered) {
			seat.taken = null
			seat.zone = ''
		}
		this.zones = []
		const live = new Set<string>()
		let cursor = 0
		this.hiddenCount = 0
		for (const { proj, members } of projects) {
			const take = ordered.slice(cursor, cursor + members.length)
			if (!take.length) {
				this.hiddenCount += members.length
				continue
			}
			this.hiddenCount += members.length - take.length
			const color = ROOFS[hash(proj) % ROOFS.length]
			this.zones.push({
				proj,
				color,
				cols: [Math.min(...take.map((s) => s.col)), Math.max(...take.map((s) => s.col)) + 1],
				rows: [Math.min(...take.map((s) => s.row)) - 1, Math.max(...take.map((s) => s.row))],
			})
			members.slice(0, take.length).forEach((m, i) => {
				const seat = take[i]
				seat.taken = m.id
				seat.zone = proj
				live.add(m.id)
				let ch = this.chars.get(m.id)
				if (!ch) {
					// new arrivals walk in from the doorway rather than popping into a chair
					const door = { col: 1, row: this.rows - 2 }
					ch = {
						id: m.id,
						state: 'idle',
						dir: 'up',
						x: door.col * TILE + TILE / 2,
						y: door.row * TILE + TILE / 2,
						col: door.col,
						row: door.row,
						path: [],
						progress: 0,
						frame: 0,
						frameTimer: 0,
						wanderTimer: rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX),
						wanderCount: 0,
						wanderLimit: randInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX),
						seatTimer: 0,
						seatId: seat.id,
						bubble: null,
						bubbleTimer: 0,
						// repeated palettes get a hue shift so two sessions on the same
						// creature are still told apart
						hueShift: 0,
					}
					this.chars.set(m.id, ch)
				}
				ch.seatId = seat.id
			})
			cursor += take.length
		}
		for (const id of [...this.chars.keys()]) if (!live.has(id)) this.chars.delete(id)
	}

	/** Advance the simulation by dt seconds. Nothing here draws. */
	update(dt: number, sessions: Session[]) {
		const byId = new Map(sessions.map((s) => [s.id, s]))
		for (const ch of this.chars.values()) {
			const s = byId.get(ch.id)
			if (!s) continue
			const active = s.state === 'working' || s.state === 'shell'
			this.updateBubble(ch, s, dt)
			ch.frameTimer += dt

			switch (ch.state) {
				case 'type': {
					if (ch.frameTimer >= TYPE_FRAME_SEC) {
						ch.frameTimer -= TYPE_FRAME_SEC
						ch.frame ^= 1
					}
					if (!active) {
						if (ch.seatTimer > 0) {
							ch.seatTimer -= dt
							break
						}
						ch.state = 'idle'
						ch.frame = 0
						ch.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX)
						ch.wanderCount = 0
						ch.wanderLimit = randInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX)
					}
					break
				}
				case 'idle': {
					ch.frame = 0
					if (active) {
						if (!this.walkToSeat(ch)) {
							ch.state = 'type'
							ch.frameTimer = 0
						}
						break
					}
					ch.wanderTimer -= dt
					if (ch.wanderTimer > 0) break
					ch.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX)
					// budget spent: go back and sit down for a while
					if (ch.wanderCount >= ch.wanderLimit && this.walkToSeat(ch)) break
					const target = this.walkable[Math.floor(Math.random() * this.walkable.length)]
					if (!target) break
					const path = this.findPath(ch.col, ch.row, target.col, target.row)
					if (path.length) {
						ch.path = path
						ch.progress = 0
						ch.state = 'walk'
						ch.frame = 0
						ch.wanderCount++
					}
					break
				}
				case 'walk': {
					if (ch.frameTimer >= WALK_FRAME_SEC) {
						ch.frameTimer -= WALK_FRAME_SEC
						ch.frame = (ch.frame + 1) % 4
					}
					this.step(ch, dt)
					if (ch.path.length === 0) {
						ch.x = ch.col * TILE + TILE / 2
						ch.y = ch.row * TILE + TILE / 2
						const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined
						const atSeat = seat && seat.col === ch.col && seat.row === ch.row
						if (atSeat) {
							ch.state = 'type'
							ch.dir = seat!.facing
							ch.frame = 0
							ch.frameTimer = 0
							if (!active) {
								ch.seatTimer = rand(SEAT_REST_MIN, SEAT_REST_MAX)
								ch.wanderCount = 0
								ch.wanderLimit = randInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX)
							}
						} else if (active) {
							if (!this.walkToSeat(ch)) ch.state = 'type'
						} else {
							ch.state = 'idle'
						}
					}
					break
				}
			}
		}
	}

	/** A session that needs you keeps its bubble; one that just finished gets a beat. */
	private updateBubble(ch: Character, s: Session, dt: number) {
		if (s.state === 'needs') {
			ch.bubble = 'permission'
			ch.bubbleTimer = 0
			return
		}
		if (ch.bubble === 'permission') ch.bubble = null
		if (s.state === 'done' && s.stale < DONE_BUBBLE_SEC * 1000) {
			if (ch.bubble !== 'done') {
				ch.bubble = 'done'
				ch.bubbleTimer = DONE_BUBBLE_SEC
			}
		}
		if (ch.bubble === 'done') {
			ch.bubbleTimer -= dt
			if (ch.bubbleTimer <= 0) ch.bubble = null
		}
	}

	private walkToSeat(ch: Character) {
		const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined
		if (!seat) return false
		if (seat.col === ch.col && seat.row === ch.row) {
			ch.state = 'type'
			ch.dir = seat.facing
			ch.frameTimer = 0
			return true
		}
		const path = this.findPath(ch.col, ch.row, seat.col, seat.row)
		if (!path.length) return false
		ch.path = path
		ch.progress = 0
		ch.state = 'walk'
		ch.frame = 0
		return true
	}

	/** Slide toward the next tile in the path, then commit to it. */
	private step(ch: Character, dt: number) {
		const next = ch.path[0]
		if (!next) return
		ch.dir = next.col > ch.col ? 'right' : next.col < ch.col ? 'left' : next.row > ch.row ? 'down' : 'up'
		ch.progress += dt * WALK_TILES_PER_SEC
		while (ch.progress >= 1 && ch.path.length) {
			ch.progress -= 1
			const t = ch.path.shift()!
			ch.col = t.col
			ch.row = t.row
		}
		const from = { x: ch.col * TILE + TILE / 2, y: ch.row * TILE + TILE / 2 }
		const ahead = ch.path[0]
		if (ahead) {
			const to = { x: ahead.col * TILE + TILE / 2, y: ahead.row * TILE + TILE / 2 }
			ch.x = from.x + (to.x - from.x) * ch.progress
			ch.y = from.y + (to.y - from.y) * ch.progress
		} else {
			ch.x = from.x
			ch.y = from.y
		}
	}

	/** Draw the room; return where each creature goes so images can be placed. */
	draw(cv: Canvas, sessions: Session[], spriteH: number): Placed[] {
		const byId = new Map(sessions.map((s) => [s.id, s]))
		cv.clear(C.floorDark)
		// floor, then the project zones as tinted carpet
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				const k = this.grid[r][c]
				const x = c * TILE
				const y = r * TILE
				if (k === 'wall') {
					cv.rect(x, y, TILE, TILE, C.wallStone)
					cv.rect(x, y, TILE, 1, C.wallLip)
				} else {
					cv.rect(x, y, TILE, TILE, (r + c) % 2 ? C.floor : C.floorAlt)
				}
			}
		}
		for (const z of this.zones) {
			const x = z.cols[0] * TILE - 2
			const y = z.rows[0] * TILE - 2
			const w = (z.cols[1] - z.cols[0]) * TILE + 4
			const h = (z.rows[1] - z.rows[0] + 1) * TILE + 4
			cv.tint(x, y, w, h, z.color, 0.22)
			cv.outline(x, y, w, h, z.color)
		}
		// desks last so they sit on top of the carpet
		const lit = new Set<string>()
		for (const seat of this.seats.values()) {
			if (!seat.taken) continue
			const s = byId.get(seat.taken)
			// a monitor is only on when its occupant is actually working
			if (s && (s.state === 'working' || s.state === 'shell')) lit.add(`${seat.col},${seat.row - 1}`)
		}
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				if (this.grid[r][c] !== 'desk') continue
				const isLeft = this.grid[r][c - 1] !== 'desk'
				drawDesk(cv, c * TILE, r * TILE, isLeft, lit.has(`${c},${r}`) || lit.has(`${c - 1},${r}`))
			}
		}

		const out: Placed[] = []
		for (const ch of [...this.chars.values()].sort((a, b) => a.y - b.y)) {
			const s = byId.get(ch.id)
			if (!s) continue
			// sitting sinks into the chair; walking gets a one-pixel bob
			const sink = ch.state === 'type' ? 2 : 0
			const bob = ch.state === 'walk' ? (ch.frame % 2 ? -1 : 0) : ch.state === 'type' ? (ch.frame ? -1 : 0) : 0
			const x = Math.round(ch.x - 8)
			const y = Math.round(ch.y + TILE / 2 - spriteH + sink + bob)
			out.push({ s, ch, tile: s.creature, x, y: y & ~1 })
		}
		return out
	}

	/** Labels and bubbles, packed so two neighbours never overprint. */
	overlay(cv: Canvas, placed: Placed[], selected?: string, showAll = true) {
		for (const z of this.zones) {
			const row = Math.floor((z.rows[0] * TILE - 4) / 2)
			cv.text(z.cols[0] * TILE - 1, Math.max(0, row), ` ${cut(z.proj, 16)} `, z.color, C.night)
		}
		const taken = new Map<number, [number, number][]>()
		const claim = (row: number, col: number, len: number) => {
			const used = taken.get(row) ?? []
			let c = Math.max(0, Math.min(cv.w - len, col))
			for (let g = 0; g < 40; g++) {
				const hit = used.find((r) => c < r[1] && c + len > r[0])
				if (!hit) break
				c = hit[1] + 1
				if (c + len > cv.w) return null
			}
			used.push([c, c + len])
			taken.set(row, used)
			return c
		}
		// urgent first, so if space runs out it is the quiet ones that lose a label
		const priority = [...placed].sort((a, b) => RANK[a.s.state] - RANK[b.s.state] || a.x - b.x)
		for (const p of priority) {
			const s = p.s
			const look = LOOK[s.state]
			const sel = s.id === selected
			const urgent = s.state === 'needs'
			// a parked session has nothing to say, and saying nothing frees the room
			// for the ones that do
			if (s.state === 'parked' && !sel) continue
			if (!showAll && !urgent && !sel) continue
			const row = Math.floor(p.y / 2) - 1
			// short here on purpose; the table below carries the full sentence
			const text = ` ${look.glyph}${s.tab ? `⌘${s.tab}` : ''} ${cut(s.doing || s.title, sel ? 34 : 20)} `
			const col = claim(row, p.x - 4, text.length)
			if (col === null) continue
			const bgc = urgent ? look.color : sel ? C.gold : C.paper
			cv.text(col, row, text, C.ink, bgc)
			cv.text(Math.max(0, p.x + 6), row + 1, '▾', bgc, null)
		}
	}
}

/** A desk seen from above: worktop with a monitor that lights up when in use. */
function drawDesk(cv: Canvas, x: number, y: number, _left: boolean, lit: boolean) {
	cv.rect(x, y, TILE, TILE, C.deskTop)
	cv.rect(x, y, TILE, 1, C.deskEdge)
	cv.rect(x, y + TILE - 1, TILE, 1, C.deskEdge)
	cv.rect(x + 1, y + 1, TILE - 2, TILE - 3, C.monitorCase)
	cv.rect(x + 2, y + 2, TILE - 4, TILE - 5, lit ? C.screenOn : C.screenOff)
}

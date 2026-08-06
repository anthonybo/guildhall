/**
 * The office: one shared room where working sessions sit at desks and everyone
 * else does something social.
 *
 * The simulation model comes from pixel-agents (MIT), but three things here are
 * deliberately different, each for a measured reason:
 *
 *  - Desks sit BELOW their seat and the occupant faces down. A character is one
 *    tile wide and two tall, so a desk placed above a seat is completely hidden
 *    by whoever sits in it.
 *  - Seats are claimed once and held. Re-deriving them each poll made ~48% of
 *    seated frames land on someone else's chair, and let two characters share a
 *    tile.
 *  - Not-working sessions leave their desk for a kitchen, a couch, a ping-pong
 *    table or a conversation. The reference has no such system; its idle agents
 *    just wander to random floor tiles and come back.
 */
import { C, LOOK, ROOFS, type RGB } from './theme.ts'
import { cut, RANK, type Session } from './data.ts'
import { Canvas } from './canvas.ts'
import type { Facing, Pose } from './characters.ts'
import { PROP_SIZE, type PropKind } from './props.ts'

/** 4px tiles: a tile is TILE/2 terminal rows, so TILE must stay even or image
 *  placements drift half a tile against the drawn grid. At 4 a worker renders
 *  ~32x68 real pixels, matching the reference's 32x64. */
export const TILE = 4
export const CHAR_W = TILE
export const CHAR_H = TILE * 2
/** The typing frames have no legs — 6 of 32 source rows are empty padding — so
 *  seated characters shift down by that fraction to put the body on the seat. */
export const SIT_SINK = Math.round((CHAR_H * 6) / 32)

const WALK_TILES_PER_SEC = 3
const TYPE_FRAME_SEC = 0.3
const WALK_FRAME_SEC = 0.15
const IDLE_PAUSE_MIN = 2
const IDLE_PAUSE_MAX = 12
const SEAT_REST_MIN = 20
const SEAT_REST_MAX = 60
const DONE_BUBBLE_SEC = 8
const CHAT_RADIUS = 10
const MAX_RUN = 6 // widest desk pod before a project spills into a second one

type Kind = 'void' | 'floor' | 'wall' | 'desk' | 'solid'
export type Dir = Facing
type SpotKind = 'desk' | 'kitchen' | 'pingpong' | 'couch' | 'talk' | 'window'
type Posture = 'sit' | 'stand'

type Spot = {
	id: string
	kind: SpotKind
	group: string
	col: number
	row: number
	facing: Dir
	posture: Posture
	zone: string | null
	taken: string | null
}

type Activity = { kind: SpotKind; spotId: string | null; partner: string | null; timer: number }

export type Character = {
	id: string
	state: 'idle' | 'walk' | 'type' | 'act'
	dir: Dir
	x: number
	y: number
	col: number
	row: number
	path: { col: number; row: number }[]
	progress: number
	frame: number
	frameTimer: number
	idleTimer: number
	seatTimer: number
	seatId: string | null
	activity: Activity | null
	wasWorking: boolean
	bubble: 'permission' | 'done' | 'chat' | null
	bubbleTimer: number
}

export type Placed = { s: Session; ch: Character; facing: Dir; pose: Pose; step: number; x: number; y: number }

type Pod = { proj: string; c0: number; c1: number; seatRow: number; deskRow: number; monitorRow: number }

const DWELL: Record<SpotKind, [number, number]> = {
	desk: [0, 0],
	kitchen: [8, 20],
	pingpong: [30, 90],
	couch: [40, 120],
	talk: [15, 45],
	window: [10, 30],
}

/** Facilities as data: spots are walkable, blocked tiles are the furniture. */
const FACILITIES: Record<
	string,
	{
		w: number
		h: number
		kind: SpotKind
		spots: [number, number, Dir, Posture][]
		/** furniture drawn as an image; `under` means the occupant sits on it */
		props: { kind: PropKind; dc: number; dr: number; under?: boolean }[]
	}
> = {
	kitchen: {
		w: 3,
		h: 2,
		kind: 'kitchen',
		spots: [
			[0, 0, 'down', 'stand'],
			[1, 0, 'down', 'stand'],
			[2, 0, 'down', 'stand'],
		],
		props: [{ kind: 'kitchen', dc: 0, dr: 1 }],
	},
	pingpong: {
		w: 4,
		h: 1,
		kind: 'pingpong',
		spots: [
			[0, 0, 'right', 'stand'],
			[3, 0, 'left', 'stand'],
		],
		props: [{ kind: 'pingpong', dc: 1, dr: 0 }],
	},
	couch: {
		w: 2,
		h: 2,
		kind: 'couch',
		spots: [
			[0, 0, 'down', 'sit'],
			[1, 0, 'down', 'sit'],
		],
		// the couch is UNDER its occupants; a low table sits in front of it
		props: [
			{ kind: 'couch', dc: 0, dr: 0, under: true },
			{ kind: 'lowtable', dc: 0, dr: 1 },
		],
	},
	talk: {
		w: 2,
		h: 1,
		kind: 'talk',
		spots: [
			[0, 0, 'right', 'stand'],
			[1, 0, 'left', 'stand'],
		],
		props: [],
	},
}
/** First to go when the room runs out of bands. */
const DROP_ORDER = ['couch', 'pingpong', 'kitchen'] as const

export class Office {
	cols = 0
	rows = 0
	spots = new Map<string, Spot>()
	chars = new Map<string, Character>()
	pods: Pod[] = []
	hiddenCount = 0
	dropped: string[] = []
	/** where to place a monitor image this frame, and whether it is lit */
	monitors: { x: number; y: number; lit: boolean; seed: number }[] = []
	/** static furniture image placements, in canvas pixels */
	props: { kind: PropKind; x: number; y: number }[] = []
	/** cell rows covered by an image; kitty draws images over text, so labels
	 *  must not be placed on these or they end up hidden behind furniture */
	private imageRows = new Set<number>()
	private grid: Kind[][] = []
	private zoneOf: (string | null)[][] = []
	private walkable: { col: number; row: number }[] = []
	private seatTiles = new Set<string>()
	/** tile -> the character heading there or resting on it */
	private dest = new Map<string, string>()
	private signature = ''
	/** last row belonging to a desk band; downtime happens below this */
	private workBottom = 0
	/** rally phase, advanced by update() so the ball moves with real time */
	private ballT = 0

	constructor(private rng: () => number = Math.random) {}

	private rand(a: number, b: number) {
		return a + this.rng() * (b - a)
	}
	private randInt(a: number, b: number) {
		return Math.floor(this.rand(a, b + 1))
	}

	/* ───────────────────── floor plan ───────────────────── */

	/**
	 * The plan is a function of the population, not just the viewport — otherwise
	 * it can only tile the room uniformly and every project looks the same.
	 */
	private plan(cols: number, rows: number, projects: { name: string; seats: number }[]) {
		this.cols = cols
		this.rows = rows
		this.grid = Array.from({ length: rows }, () => new Array<Kind>(cols).fill('floor'))
		this.zoneOf = Array.from({ length: rows }, () => new Array<string | null>(cols).fill(null))
		for (let c = 0; c < cols; c++) {
			this.grid[0][c] = 'wall'
			this.grid[rows - 1][c] = 'wall'
		}
		for (let r = 0; r < rows; r++) {
			this.grid[r][0] = 'wall'
			this.grid[r][cols - 1] = 'wall'
		}
		this.spots.clear()
		this.seatTiles.clear()
		this.pods = []
		this.props = []
		this.hiddenCount = 0
		this.dropped = []

		// Row 1 is a gutter: it carries each front-row occupant's head and status
		// label, so nothing may ever be placed there.
		// A band is [monitor, worktop, seat, aisle]. The occupant faces UP into the
		// desk: a character is two tiles tall, so it covers the worktop and its own
		// seat, leaving the monitor row clear above its head — which is the only
		// arrangement where you see both the worker's back and their screen.
		const bandRows: number[] = []
		for (let r = 1; r + 3 < rows - 1; r += 4) bandRows.push(r)

		// desk pods, at most two per band (left-anchored then right-anchored)
		const wishlist: { proj: string; seats: number }[] = []
		for (const p of projects) {
			let left = p.seats
			while (left > 0) {
				const take = Math.min(MAX_RUN, left)
				wishlist.push({ proj: p.name, seats: take })
				left -= take
			}
		}
		let band = 0
		let n = 0
		for (let i = 0; i < wishlist.length; ) {
			if (band >= bandRows.length) break
			const monitorRow = bandRows[band]
			const deskRow = monitorRow + 1
			const seatRow = monitorRow + 2
			let lo = 2
			let hi = cols - 3
			for (let side = 0; side < 2 && i < wishlist.length; side++) {
				const want = wishlist[i]
				if (hi - lo + 1 < want.seats + (side === 0 ? 2 : 0)) break
				const c0 = side === 0 ? lo : hi - want.seats + 1
				const c1 = c0 + want.seats - 1
				for (let c = c0; c <= c1; c++) {
					this.grid[deskRow][c] = 'desk'
					const id = `d${n++}`
					this.spots.set(id, {
						id,
						kind: 'desk',
						group: want.proj,
						col: c,
						row: seatRow,
						facing: 'up',
						posture: 'sit',
						zone: want.proj,
						taken: null,
					})
					this.seatTiles.add(`${c},${seatRow}`)
					for (const r of [monitorRow, deskRow, seatRow]) this.zoneOf[r][c] ??= want.proj
				}
				this.pods.push({ proj: want.proj, c0, c1, seatRow, deskRow, monitorRow })
				if (side === 0) lo = c1 + 3
				else hi = c0 - 1
				i++
			}
			band++
		}
		// any project that could not be seated is reported, never silently dropped
		for (let i = 0; i < wishlist.length; i++) {
			const seated = this.pods.filter((p) => p.proj === wishlist[i].proj).reduce((a, p) => a + (p.c1 - p.c0 + 1), 0)
			const wanted = wishlist.filter((w) => w.proj === wishlist[i].proj).reduce((a, w) => a + w.seats, 0)
			if (seated < wanted && !this.dropped.includes(wishlist[i].proj)) this.hiddenCount += wanted - seated
			if (seated < wanted) this.dropped.push(wishlist[i].proj)
		}
		this.dropped = []

		// social bands, anchored to the bottom so the gap becomes a corridor
		const socialBands = bandRows.slice(band).slice(-2)
		let wish = ['kitchen', 'pingpong', 'couch']
		while (socialBands.length * 2 < wish.length - 1 && DROP_ORDER.some((d) => wish.includes(d))) {
			const drop = DROP_ORDER.find((d) => wish.includes(d))!
			wish = wish.filter((w) => w !== drop)
			this.dropped.push(drop)
		}
		let sb = 0
		for (let i = 0; i < wish.length && sb < socialBands.length; ) {
			const row = socialBands[sb]
			let lo = 2
			let hi = cols - 3
			for (let side = 0; side < 2 && i < wish.length; side++) {
				const f = FACILITIES[wish[i]]
				if (!f || hi - lo + 1 < f.w + (side === 0 ? 2 : 0) || row + f.h > rows - 1) {
					i++
					side--
					if (i >= wish.length) break
					continue
				}
				const c0 = side === 0 ? lo : hi - f.w + 1
				this.place(f, c0, row, `${wish[i]}@${row}`)
				if (side === 0) lo = c0 + f.w + 2
				else hi = c0 - 1
				i++
			}
			sb++
		}
		// A conversation costs no furniture, so it always gets somewhere to happen —
		// beside the water cooler, which is what makes it read as a gathering spot
		// rather than two people stopped in the middle of an empty floor.
		const corridor = socialBands.length ? socialBands[0] - 2 : rows - 3
		// The talk area must be BELOW every desk band. Anything inside the work zone
		// puts idle people on top of a workstation, which destroys the one signal
		// that matters: whoever is at a desk is working.
		this.workBottom = this.pods.length ? Math.max(...this.pods.map((p) => p.seatRow)) + 1 : 1
		const workBottom = this.workBottom + 1
		let talkRow = -1
		for (let r = Math.max(workBottom, corridor); r < rows - 1 && talkRow < 0; r++)
			if ([2, 3].every((c) => this.grid[r][c] === 'floor' && !this.seatTiles.has(`${c},${r}`))) talkRow = r

		if (talkRow >= 0 && cols > 8) {
			;[
				[2, 'right'],
				[3, 'left'],
			].forEach(([c, facing], k) => {
				const id = `talk@${talkRow}:${k}`
				this.spots.set(id, {
					id,
					kind: 'talk',
					group: `talk@${talkRow}`,
					col: c as number,
					row: talkRow,
					facing: facing as Dir,
					posture: 'stand',
					zone: null,
					taken: null,
				})
				this.seatTiles.add(`${c},${talkRow}`)
			})
		}
		// a window on the wall is a free loiter spot and costs no band
		if (corridor > 1 && corridor < rows - 1) {
			const id = `w0`
			this.spots.set(id, {
				id,
				kind: 'window',
				group: 'window',
				col: cols - 2,
				row: corridor,
				facing: 'right',
				posture: 'stand',
				zone: null,
				taken: null,
			})
		}
		// decor, so the room reads as an office rather than a grid of desks
		if (cols > 14) {
			this.props.push({ kind: 'plant', x: 1 * TILE, y: 1 * TILE })
			this.props.push({ kind: 'plant', x: (cols - 2) * TILE, y: 1 * TILE })
			this.grid[1][1] = 'solid'
			this.grid[1][cols - 2] = 'solid'
			this.props.push({ kind: 'whiteboard', x: 3 * TILE, y: 0 })
			this.props.push({ kind: 'shelf', x: (cols - 4) * TILE, y: 0 })
			const cr = socialBands.length ? socialBands[0] - 2 : rows - 3
			if (cr > 1 && cr < rows - 2) {
				this.props.push({ kind: 'cooler', x: 1 * TILE, y: cr * TILE })
				this.grid[cr][1] = 'solid'
			}
		}

		this.walkable = []
		for (let r = 0; r < rows; r++)
			for (let c = 0; c < cols; c++) if (this.grid[r][c] === 'floor') this.walkable.push({ col: c, row: r })
	}

	private place(f: (typeof FACILITIES)[string], c0: number, r0: number, group: string) {
		for (const pr of f.props) {
			this.props.push({ kind: pr.kind, x: (c0 + pr.dc) * TILE, y: (r0 + pr.dr) * TILE })
			if (pr.under) continue // you can stand on a couch; you cannot stand on a counter
			const size = PROP_SIZE[pr.kind]
			for (let dr = 0; dr < size.h; dr++)
				for (let dc = 0; dc < size.w; dc++) {
					const c = c0 + pr.dc + dc
					const r = r0 + pr.dr + dr
					if (r > 0 && r < this.rows - 1 && c > 0 && c < this.cols - 1) this.grid[r][c] = 'solid'
				}
		}
		f.spots.forEach(([dc, dr, facing, posture], k) => {
			const id = `${group}:${k}`
			this.spots.set(id, {
				id,
				kind: f.kind,
				group,
				col: c0 + dc,
				row: r0 + dr,
				facing,
				posture,
				zone: null,
				taken: null,
			})
			this.seatTiles.add(`${c0 + dc},${r0 + dr}`)
		})
	}

	/* ───────────────────── walkability & paths ───────────────────── */

	/** A spot tile is walkable only by whoever holds it, so nobody stands in
	 *  someone else's chair — the reference's withOwnSeatUnblocked, inlined. */
	/** Is this tile open floor, ignoring who owns it? Used by reachability tests. */
	isOpen(col: number, row: number) {
		if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false
		return this.grid[row][col] === 'floor'
	}

	private isWalkable(col: number, row: number, own?: string) {
		if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false
		if (this.grid[row][col] !== 'floor') return false
		const k = `${col},${row}`
		return !this.seatTiles.has(k) || k === own
	}

	private findPath(sc: number, sr: number, ec: number, er: number, own?: string) {
		if (sc === ec && sr === er) return []
		if (!this.isWalkable(ec, er, own)) return []
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
					if (seen.has(k) || !this.isWalkable(c, r, own)) continue
					seen.add(k)
					prev.set(k, key(cur.col, cur.row))
					if (c === ec && r === er) {
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

	/* ───────────────────── population ───────────────────── */

	/** Re-plan only when the viewport or the project mix actually changes. */
	fit(wPx: number, hPx: number, sessions: Session[]) {
		const cols = Math.max(12, Math.min(Math.floor(wPx / TILE), Math.floor(wPx / TILE)))
		const rows = Math.max(8, Math.floor(hPx / TILE))
		const byProj = new Map<string, number>()
		for (const s of sessions) byProj.set(s.proj, (byProj.get(s.proj) ?? 0) + 1)
		const projects = [...byProj.entries()]
			.map(([name, seats]) => ({ name, seats }))
			.sort((a, b) => b.seats - a.seats || a.name.localeCompare(b.name))
		const sig = `${cols}x${rows}|${projects.map((p) => `${p.name}:${p.seats}`).join(',')}`
		if (sig === this.signature) return
		this.signature = sig
		this.plan(cols, rows, projects)
		this.relocate()
	}

	/** After a re-plan, put everybody somewhere legal or they are stranded forever. */
	private relocate() {
		for (const ch of this.chars.values()) {
			const seat = ch.seatId ? this.spots.get(ch.seatId) : undefined
			if (seat) {
				ch.col = seat.col
				ch.row = seat.row
			} else if (!this.isWalkable(ch.col, ch.row)) {
				const t = this.walkable[Math.floor(this.rng() * this.walkable.length)]
				if (t) {
					ch.col = t.col
					ch.row = t.row
				}
			}
			ch.x = ch.col * TILE + TILE / 2
			ch.y = ch.row * TILE + TILE / 2
			ch.path = []
			ch.progress = 0
			this.release(ch)
			this.unreserve(ch)
			this.reserve(ch, ch.col, ch.row)
			if (ch.state === 'walk') ch.state = 'idle'
		}
	}

	/** Claim and release. Existing claims are never disturbed — that stickiness
	 *  is what stops characters being re-targeted onto occupied chairs. */
	assign(sessions: Session[]) {
		const byId = new Map(sessions.map((s) => [s.id, s]))
		for (const [id, ch] of [...this.chars]) {
			if (byId.has(id)) continue
			const st = ch.seatId ? this.spots.get(ch.seatId) : undefined
			if (st?.taken === id) st.taken = null
			this.release(ch)
			this.unreserve(ch)
			this.chars.delete(id)
		}
		for (const spot of this.spots.values()) if (spot.taken && !this.chars.has(spot.taken)) spot.taken = null
		for (const ch of this.chars.values()) if (ch.seatId && !this.spots.has(ch.seatId)) ch.seatId = null

		const desks = [...this.spots.values()].filter((s) => s.kind === 'desk').sort((a, b) => a.row - b.row || a.col - b.col)
		const newcomers = sessions
			.filter((s) => !this.chars.has(s.id) || !this.chars.get(s.id)!.seatId)
			.sort((a, b) => RANK[a.state] - RANK[b.state] || a.id.localeCompare(b.id))
		for (const s of newcomers) {
			const seat = this.claimDesk(s, desks)
			if (!seat) continue
			seat.taken = s.id
			const existing = this.chars.get(s.id)
			if (existing) existing.seatId = seat.id
			else this.chars.set(s.id, this.spawn(s, seat))
		}
		this.hiddenCount = sessions.filter((s) => !this.chars.get(s.id)?.seatId).length
	}

	/** Nearest free desk to the project's existing cluster, never evicting anyone. */
	private claimDesk(s: Session, desks: Spot[]) {
		const free = desks.filter((d) => !d.taken)
		if (!free.length) return null
		const mine = free.filter((d) => d.zone === s.proj)
		if (mine.length) return mine[0]
		const cluster = desks.filter((d) => d.taken && d.zone === s.proj)
		if (!cluster.length) return free[0]
		let best = free[0]
		let bestD = Infinity
		for (const f of free) {
			const d = Math.min(...cluster.map((m) => Math.abs(m.col - f.col) + Math.abs(m.row - f.row)))
			if (d < bestD) {
				best = f
				bestD = d
			}
		}
		return best
	}

	/** Born in the chair, working — the reference does the same, and starting at
	 *  a doorway meant nobody was at a desk for the first minute. */
	private spawn(s: Session, seat: Spot): Character {
		return {
			id: s.id,
			state: 'type',
			dir: seat.facing,
			x: seat.col * TILE + TILE / 2,
			y: seat.row * TILE + TILE / 2,
			col: seat.col,
			row: seat.row,
			path: [],
			progress: 0,
			frame: 0,
			frameTimer: 0,
			idleTimer: 0,
			seatTimer: 0,
			seatId: seat.id,
			activity: null,
			wasWorking: true,
			bubble: null,
			bubbleTimer: 0,
		}
	}

	/* ───────────────────── simulation ───────────────────── */

	/** Blocked on your approval is still mid-turn, so it stays at the desk. */
	private atDesk = (s: Session) => s.state === 'working' || s.state === 'shell' || s.state === 'needs'

	update(dt: number, sessions: Session[]) {
		this.ballT += dt * 1.6
		const byId = new Map(sessions.map((s) => [s.id, s]))
		let wantChat = 0
		for (const ch of this.chars.values()) {
			const s = byId.get(ch.id)
			if (!s) continue
			const working = this.atDesk(s)
			this.bubbleFor(ch, s, dt)
			// the turn ending is an edge, and it has to clear the current plan
			if (ch.wasWorking && !working) {
				ch.seatTimer = -1
				ch.path = []
				ch.progress = 0
			}
			ch.wasWorking = working
			ch.frameTimer += dt

			switch (ch.state) {
				case 'type': {
					if (ch.frameTimer >= TYPE_FRAME_SEC) {
						ch.frameTimer -= TYPE_FRAME_SEC
						ch.frame ^= 1
					}
					if (working) break
					if (ch.seatTimer > 0) {
						ch.seatTimer -= dt
						break
					}
					ch.seatTimer = 0
					ch.state = 'idle'
					ch.frame = 0
					ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX)
					break
				}
				case 'act': {
					if (ch.frameTimer >= TYPE_FRAME_SEC) {
						ch.frameTimer -= TYPE_FRAME_SEC
						ch.frame ^= 1
					}
					// returning to work always wins, checked before any timer
					if (working) {
						this.release(ch)
						if (!this.walkToSeat(ch)) ch.state = 'type'
						break
					}
					const act = ch.activity
					if (!act) {
						ch.state = 'idle'
						break
					}
					if (act.partner) {
						const p = this.chars.get(act.partner)
						const ps = p ? byId.get(p.id) : undefined
						if (!p || !ps || this.atDesk(ps)) {
							this.release(ch)
							ch.state = 'idle'
							ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX)
							break
						}
						// only count down once both of them have arrived
						if (p.state !== 'act') break
					}
					act.timer -= dt
					if (act.timer <= 0) {
						this.release(ch)
						ch.state = 'idle'
						ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX)
					}
					break
				}
				case 'idle': {
					ch.frame = 0
					if (ch.seatTimer < 0) ch.seatTimer = 0
					if (working) {
						this.release(ch)
						if (!this.walkToSeat(ch)) {
							ch.state = 'type'
							ch.frameTimer = 0
						}
						break
					}
					ch.idleTimer -= dt
					if (ch.idleTimer > 0) break
					ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX)
					if (this.rng() < 0.3) {
						wantChat++
						break // the broker pairs us up after this loop
					}
					if (this.goToSpot(ch)) break
					// nothing free: drift to a tile nobody else has claimed
					const open = this.freeTiles()
					const t = open[Math.floor(this.rng() * open.length)]
					if (t) this.walkTo(ch, t.col, t.row)
					break
				}
				case 'walk': {
					if (ch.frameTimer >= WALK_FRAME_SEC) {
						ch.frameTimer -= WALK_FRAME_SEC
						ch.frame = (ch.frame + 1) % 4
					}
					// a session that starts a turn mid-walk turns around at once
					if (working) {
						const seat = ch.seatId ? this.spots.get(ch.seatId) : undefined
						const last = ch.path[ch.path.length - 1]
						if (seat && (!last || last.col !== seat.col || last.row !== seat.row)) {
							this.release(ch)
							this.walkToSeat(ch)
						}
					}
					this.step(ch, dt)
					if (ch.path.length) break
					ch.x = ch.col * TILE + TILE / 2
					ch.y = ch.row * TILE + TILE / 2
					const seat = ch.seatId ? this.spots.get(ch.seatId) : undefined
					if (seat && seat.col === ch.col && seat.row === ch.row) {
						ch.state = 'type'
						ch.dir = seat.facing
						ch.frame = 0
						ch.frameTimer = 0
						// a turn that just ended must not earn a long nap
						ch.seatTimer = ch.seatTimer < 0 ? 0 : this.rand(SEAT_REST_MIN, SEAT_REST_MAX)
						break
					}
					const act = ch.activity
					const spot = act?.spotId ? this.spots.get(act.spotId) : undefined
					if (act && spot && spot.col === ch.col && spot.row === ch.row) {
						ch.state = 'act'
						ch.dir = spot.facing
						ch.frame = 0
						break
					}
					if (act?.partner) {
						const p = this.chars.get(act.partner)
						if (p) ch.dir = Math.abs(p.col - ch.col) >= Math.abs(p.row - ch.row) ? (p.col > ch.col ? 'right' : 'left') : p.row > ch.row ? 'down' : 'up'
						ch.state = 'act'
						break
					}
					ch.state = 'idle'
					break
				}
			}
		}
		if (wantChat >= 2) this.brokerChats(byId)
	}

	private bubbleFor(ch: Character, s: Session, dt: number) {
		if (s.state === 'needs') {
			ch.bubble = 'permission'
			return
		}
		if (ch.bubble === 'permission') ch.bubble = null
		if (ch.activity?.partner) {
			ch.bubble = 'chat'
			return
		}
		if (ch.bubble === 'chat') ch.bubble = null
		if (s.state === 'done' && s.stale < DONE_BUBBLE_SEC * 1000 && ch.bubble !== 'done') {
			ch.bubble = 'done'
			ch.bubbleTimer = DONE_BUBBLE_SEC
		}
		if (ch.bubble === 'done') {
			ch.bubbleTimer -= dt
			if (ch.bubbleTimer <= 0) ch.bubble = null
		}
	}

	/** One teardown for every exit, so no claim or pairing can leak. */
	private release(ch: Character) {
		const act = ch.activity
		if (!act) return
		if (act.spotId) {
			const sp = this.spots.get(act.spotId)
			if (sp?.taken === ch.id) sp.taken = null
		}
		if (act.partner) {
			const p = this.chars.get(act.partner)
			if (p?.activity?.partner === ch.id) {
				if (p.activity.spotId) {
					const sp = this.spots.get(p.activity.spotId)
					if (sp?.taken === p.id) sp.taken = null
				}
				p.activity = null
				if (p.state === 'act') p.state = 'idle'
			}
		}
		ch.activity = null
	}

	/** Prefer a facility someone is already at, which is what makes a group read
	 *  as a group without any explicit socialising logic. */
	private goToSpot(ch: Character) {
		const free = [...this.spots.values()].filter((s) => s.kind !== 'desk' && !s.taken)
		if (!free.length) return false
		const busyGroups = new Set([...this.spots.values()].filter((s) => s.taken && s.kind !== 'desk').map((s) => s.group))
		const scored = free
			.map((s) => ({
				s,
				score: (busyGroups.has(s.group) ? -1000 : 0) + Math.abs(s.col - ch.col) + Math.abs(s.row - ch.row),
			}))
			.sort((a, b) => a.score - b.score)
		for (const { s } of scored) {
			s.taken = ch.id
			ch.activity = { kind: s.kind, spotId: s.id, partner: null, timer: this.rand(...DWELL[s.kind]) }
			if (this.walkTo(ch, s.col, s.row, `${s.col},${s.row}`)) return true
			s.taken = null
			ch.activity = null
		}
		return false
	}

	/** Deterministic id-ordered pairing: two idle characters stand and talk. */
	private brokerChats(byId: Map<string, Session>) {
		const waiting = [...this.chars.values()]
			.filter((c) => c.state === 'idle' && !c.activity && !this.atDesk(byId.get(c.id)!))
			.sort((a, b) => a.id.localeCompare(b.id))
		for (let i = 0; i < waiting.length; i++) {
			const a = waiting[i]
			if (a.activity) continue
			for (let j = i + 1; j < waiting.length; j++) {
				const b = waiting[j]
				if (b.activity) continue
				if (Math.abs(a.col - b.col) + Math.abs(a.row - b.row) > CHAT_RADIUS) continue
				const dur = this.rand(...DWELL.talk)
				// prefer the room's talk area so a conversation happens somewhere,
				// rather than two people standing in the middle of an empty floor
				const area = [...this.spots.values()].filter((s) => s.kind === 'talk' && !s.taken)
				if (area.length >= 2) {
					const [s0, s1] = area
					s0.taken = a.id
					s1.taken = b.id
					a.activity = { kind: 'talk', spotId: s0.id, partner: b.id, timer: dur }
					b.activity = { kind: 'talk', spotId: s1.id, partner: a.id, timer: dur }
					if (this.walkTo(a, s0.col, s0.row, `${s0.col},${s0.row}`) && this.walkTo(b, s1.col, s1.row, `${s1.col},${s1.row}`)) break
					this.release(a)
					this.release(b)
				}
				const pair = this.findTalkPair(a, b)
				if (!pair) continue
				a.activity = { kind: 'talk', spotId: null, partner: b.id, timer: dur }
				b.activity = { kind: 'talk', spotId: null, partner: a.id, timer: dur }
				this.walkTo(a, pair[0].col, pair[0].row)
				this.walkTo(b, pair[1].col, pair[1].row)
				break
			}
		}
	}

	/** Two side-by-side free floor tiles near the midpoint of the pair. */
	private findTalkPair(a: Character, b: Character) {
		const mc = Math.round((a.col + b.col) / 2)
		const mr = Math.round((a.row + b.row) / 2)
		let best: [{ col: number; row: number }, { col: number; row: number }] | null = null
		let bestD = Infinity
		for (const t of this.freeTiles()) {
			const d = Math.abs(t.col - mc) + Math.abs(t.row - mr)
			if (d >= bestD) continue
			const right = { col: t.col + 1, row: t.row }
			if (!this.isWalkable(right.col, right.row)) continue
			if (this.dest.has(`${right.col},${right.row}`)) continue
			best = [t, right]
			bestD = d
		}
		return best
	}

	private walkToSeat(ch: Character) {
		const seat = ch.seatId ? this.spots.get(ch.seatId) : undefined
		if (!seat) return false
		if (seat.col === ch.col && seat.row === ch.row) {
			ch.state = 'type'
			ch.dir = seat.facing
			ch.frameTimer = 0
			ch.seatTimer = 0
			return true
		}
		return this.walkTo(ch, seat.col, seat.row, `${seat.col},${seat.row}`)
	}

	/**
	 * Reserve a destination tile. Two characters may pass through each other while
	 * walking — the reference allows that too — but they must never come to rest
	 * on the same tile, so the target is claimed before the path is taken.
	 */
	private reserve(ch: Character, col: number, row: number) {
		const k = `${col},${row}`
		const holder = this.dest.get(k)
		if (holder && holder !== ch.id) return false
		this.unreserve(ch)
		this.dest.set(k, ch.id)
		return true
	}

	private unreserve(ch: Character) {
		for (const [k, id] of this.dest) if (id === ch.id) this.dest.delete(k)
	}

	/** Free floor that nobody else is heading to or standing on. */
	private freeTiles() {
		const open = this.walkable.filter((t) => {
			const k = `${t.col},${t.row}`
			return !this.dest.get(k) && !this.seatTiles.has(k)
		})
		// keep downtime out of the work zone; walking THROUGH it is still fine
		const social = open.filter((t) => t.row > this.workBottom)
		return social.length ? social : open
	}

	private walkTo(ch: Character, col: number, row: number, own?: string) {
		if (!this.reserve(ch, col, row)) return false
		const path = this.findPath(ch.col, ch.row, col, row, own)
		if (!path.length) {
			this.unreserve(ch)
			return false
		}
		ch.path = path
		ch.progress = 0
		ch.state = 'walk'
		ch.frame = 0
		return true
	}

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
		if (!ch.path.length) ch.progress = 0
		const from = { x: ch.col * TILE + TILE / 2, y: ch.row * TILE + TILE / 2 }
		const ahead = ch.path[0]
		if (ahead) {
			ch.x = from.x + (ahead.col * TILE + TILE / 2 - from.x) * ch.progress
			ch.y = from.y + (ahead.row * TILE + TILE / 2 - from.y) * ch.progress
		} else {
			ch.x = from.x
			ch.y = from.y
		}
	}

	/* ───────────────────── drawing ───────────────────── */

	draw(cv: Canvas, sessions: Session[]): Placed[] {
		const byId = new Map(sessions.map((s) => [s.id, s]))
		cv.clear(C.floorDark)
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				const x = c * TILE
				const y = r * TILE
				switch (this.grid[r][c]) {
					case 'wall':
						cv.rect(x, y, TILE, TILE, C.wallStone)
						cv.rect(x, y, TILE, 1, C.wallLip)
						break
					case 'desk':
						break // drawn below, after the carpets
					default:
						cv.rect(x, y, TILE, TILE, (r + c) % 2 ? C.floor : C.floorAlt)
				}
			}
		}
		// project carpet: one scalar per tile, so two projects can never overlap
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				const z = this.zoneOf[r][c]
				if (!z) continue
				const col = ROOFS[hash(z) % ROOFS.length]
				cv.tint(c * TILE, r * TILE, TILE, TILE, col, 0.2)
				// edge only where the neighbour differs, which gives a pod-shaped rug
				if (this.zoneOf[r - 1]?.[c] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE + i, r * TILE, col)
				if (this.zoneOf[r + 1]?.[c] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE + i, r * TILE + TILE - 1, col)
				if (this.zoneOf[r][c - 1] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE, r * TILE + i, col)
				if (this.zoneOf[r][c + 1] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE + TILE - 1, r * TILE + i, col)
			}
		}
		this.monitors = []
		const lit = new Set<string>()
		for (const sp of this.spots.values()) {
			if (sp.kind !== 'desk' || !sp.taken) continue
			const s = byId.get(sp.taken)
			if (s && this.atDesk(s)) lit.add(`${sp.col},${sp.row}`)
		}
		// a monitor stands on the row above its worktop, clear of its occupant
		for (const pod of this.pods)
			for (let c = pod.c0; c <= pod.c1; c++) {
				this.monitors.push({ x: c * TILE, y: pod.monitorRow * TILE, lit: lit.has(`${c},${pod.seatRow}`), seed: c + pod.monitorRow })
				for (let i = 0; i < TILE / 2; i++) this.imageRows.add(((pod.monitorRow * TILE) >> 1) + i)
			}
		this.imageRows.clear()
		for (const pr of this.props) {
			const size = PROP_SIZE[pr.kind]
			for (let i = 0; i < (size.h * TILE) / 2; i++) this.imageRows.add((pr.y >> 1) + i)
		}
		for (let r = 0; r < this.rows; r++)
			for (let c = 0; c < this.cols; c++) {
				const k = this.grid[r][c]
				// the worktop; `lit` is keyed on the SEAT row, one below this one
				if (k === 'desk') drawDesk(cv, c * TILE, r * TILE, lit.has(`${c},${r + 1}`))
				else if (k === 'solid') cv.rect(c * TILE, r * TILE, TILE, TILE, C.floorDark)
			}

		// ping-pong ball: one pixel arcing between the two players
		for (const g of new Set([...this.spots.values()].filter((x) => x.kind === 'pingpong').map((x) => x.group))) {
			const pair = [...this.spots.values()].filter((x) => x.group === g)
			if (pair.length !== 2 || !pair.every((x) => x.taken)) continue
			const t = (this.ballT % 1 + 1) % 1
			const swing = t < 0.5 ? t * 2 : (1 - t) * 2
			const x = pair[0].col * TILE + (pair[1].col - pair[0].col) * TILE * swing + TILE / 2
			const y = pair[0].row * TILE + TILE / 2 - Math.round(Math.sin(swing * Math.PI) * 3)
			cv.set(Math.round(x), Math.round(y), [252, 252, 240])
			cv.set(Math.round(x), Math.round(y) - 1, [220, 220, 200])
		}

		const out: Placed[] = []
		for (const ch of [...this.chars.values()].sort((a, b) => a.y - b.y)) {
			const s = byId.get(ch.id)
			if (!s) continue
			const seated = ch.state === 'type' || (ch.state === 'act' && this.postureOf(ch) === 'sit')
			const pose: Pose = ch.state === 'walk' ? 'walk' : ch.state === 'act' && !seated ? 'reading' : 'typing'
			const step = ch.state === 'idle' ? 1 : ch.frame
			// feet at the tile CENTRE, matching the reference — anchoring at the
			// tile bottom put the body a half tile low and it read as standing
			const y = Math.round(ch.y - CHAR_H + (seated ? SIT_SINK : 0))
			out.push({ s, ch, facing: ch.dir, pose, step, x: Math.round(ch.x - CHAR_W / 2), y: y - (y & 1) })
		}
		return out
	}

	private postureOf(ch: Character) {
		const id = ch.activity?.spotId
		return id ? (this.spots.get(id)?.posture ?? 'stand') : 'stand'
	}

	/** Project nameplates and per-character status labels. */
	overlay(cv: Canvas, placed: Placed[], selected?: string, showAll = true) {
		const named = new Set<string>()
		for (const pod of [...this.pods].sort((a, b) => b.c1 - b.c0 - (a.c1 - a.c0))) {
			if (named.has(pod.proj)) continue
			named.add(pod.proj)
			// A nameplate is text, not furniture, so it may run past its pod into the
			// floor beside it. Right-anchored pods have no room to their right, so
			// measure both directions and grow into whichever side is emptier —
			// otherwise every pod on the right edge reads "draf…".
			const band = this.pods.filter((p) => p.deskRow === pod.deskRow)
			const rightOf = band.filter((p) => p.c0 > pod.c1).sort((a, b) => a.c0 - b.c0)
			const leftOf = band.filter((p) => p.c1 < pod.c0).sort((a, b) => b.c1 - a.c1)
			const roomRight = ((rightOf.length ? rightOf[0].c0 : this.cols - 1) - pod.c0) * TILE - 1
			const roomLeft = (pod.c1 + 1 - (leftOf.length ? leftOf[0].c1 + 1 : 1)) * TILE - 1
			const span = Math.max(roomRight, roomLeft)
			const text = ` ${cut(pod.proj, Math.max(3, span - 2))} `
			// when growing leftward, end the plate on the pod's right edge
			const startCol = roomLeft > roomRight ? (pod.c1 + 1) * TILE - text.length : pod.c0 * TILE
			// the desk row carries monitor images, which draw over text, so the plate
			// goes on the aisle row below the pod
			const plateRow = Math.min(cv.rows - 1, Math.floor(((pod.seatRow + 1) * TILE) / 2))
			cv.text(Math.max(0, startCol), plateRow, text, C.ink, ROOFS[hash(pod.proj) % ROOFS.length])
		}
		const taken = new Map<number, [number, number][]>()
		const claim = (want: number, col: number, len: number) => {
			// walk upward past any row an image covers, then find a free run on it
			for (let row = want; row >= Math.max(0, want - 4); row--) {
				if (this.imageRows.has(row)) continue
				const used = taken.get(row) ?? []
				let c = Math.max(0, Math.min(cv.w - len, col))
				let ok = true
				for (let g = 0; g < 40; g++) {
					const hit = used.find((r) => c < r[1] && c + len > r[0])
					if (!hit) break
					c = hit[1] + 1
					if (c + len > cv.w) {
						ok = false
						break
					}
				}
				if (!ok) continue
				used.push([c, c + len])
				taken.set(row, used)
				return { row, col: c }
			}
			return null
		}
		for (const p of [...placed].sort((a, b) => RANK[a.s.state] - RANK[b.s.state] || a.x - b.x)) {
			const s = p.s
			const look = LOOK[s.state]
			const sel = s.id === selected
			const urgent = s.state === 'needs'
			if (!showAll && !urgent && !sel) continue
			if (s.state === 'parked' && !sel && !urgent) continue
			const text = ` ${look.glyph}${s.tab ? `⌘${s.tab}` : ''} ${cut(s.doing || s.title, sel ? 32 : 18)} `
			const at = claim(Math.floor(p.y / 2) - 1, p.x - 2, text.length)
			if (!at) continue
			const bgc = urgent ? look.color : sel ? C.gold : C.paper
			cv.text(at.col, at.row, text, C.ink, bgc)
		}
	}
}

const hash = (s: string) => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

/** A worktop with a monitor whose screen lights up while its owner works. */
function drawDesk(cv: Canvas, x: number, y: number, lit: boolean) {
	cv.rect(x, y, TILE, TILE, C.deskTop)
	cv.rect(x, y, TILE, 1, C.deskEdge)
	cv.rect(x, y + TILE - 1, TILE, 1, C.deskEdge)
	// a warm pool of light on the worktop when the machine is in use
	if (lit) cv.tint(x, y, TILE, TILE, C.screenOn, 0.28)
}



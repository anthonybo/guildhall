/**
 * The room itself: its floor plan, what can be walked on, and who sits where.
 *
 * Split from the simulation and the renderer because these are the parts with an
 * invariant worth protecting — a seat is claimed once and held, and a spot tile is
 * walkable only by its owner. Re-deriving seats each poll once put ~48% of seated
 * frames in someone else's chair.
 */
import { ROOFS, type RGB } from '../theme.ts'
import { RANK, type Session } from '../data.ts'
import type { PropKind } from '../props.ts'
import {
	TILE,
	type Character,
	type Kind,
	type Pod,
	type Spot,
} from './model.ts'
import { planRoom } from './plan.ts'

export class RoomBase {
	cols = 0
	rows = 0
	spots = new Map<string, Spot>()
	chars = new Map<string, Character>()
	pods: Pod[] = []
	hiddenCount = 0
	dropped: string[] = []
	/** where to place a monitor image this frame, and whether it is lit */
	monitors: { x: number; y: number; lit: boolean; seed: number; kind: Session['toolKind'] }[] = []
	/** level badges, in the gap column beside each occupied desk */
	badges: { x: number; y: number; level: number; asking: boolean }[] = []
	/** static furniture image placements, in canvas pixels */
	props: { kind: PropKind; x: number; y: number }[] = []
	/** cell spans covered by an image, per cell row. Kitty draws images over text,
	 *  so a label must not overlap one — but sharing the row is fine. */
	protected imageSpans = new Map<number, [number, number][]>()
	protected grid: Kind[][] = []
	protected zoneOf: (string | null)[][] = []
	protected walkable: { col: number; row: number }[] = []
	protected seatTiles = new Set<string>()
	/** tile -> the character heading there or resting on it */
	protected dest = new Map<string, string>()
	protected signature = ''
	/** last row belonging to a desk band; downtime happens below this */
	protected workBottom = 0
	/** project -> colour, assigned by index. A hash collides long before it runs
	 *  out of colours, which is why several projects were sharing one. */
	protected zoneColor = new Map<string, RGB>()
	/** rally phase, advanced by update() so the ball moves with real time */
	protected ballT = 0

	constructor(protected rng: () => number = Math.random) {}

	protected rand(a: number, b: number) {
		return a + this.rng() * (b - a)
	}
	protected randInt(a: number, b: number) {
		return Math.floor(this.rand(a, b + 1))
	}

	/* ───────────────────── floor plan ───────────────────── */

	/**
	 * Re-lay the room and adopt the result. Planning is pure (see office/plan.ts);
	 * this is the only place its output becomes state, which keeps the geometry
	 * reasoning testable on its own and out of the simulation.
	 */
	private plan(cols: number, rows: number, projects: { name: string; seats: number }[]) {
		const room = planRoom(cols, rows, projects)
		this.cols = room.cols
		this.rows = room.rows
		this.grid = room.grid
		this.zoneOf = room.zoneOf
		this.spots = room.spots
		this.seatTiles = room.seatTiles
		this.pods = room.pods
		this.props = room.props
		this.walkable = room.walkable
		this.workBottom = room.workBottom
		this.zoneColor = room.zoneColor
		this.hiddenCount = room.hiddenCount
		this.dropped = room.dropped
	}

	/* ───────────────────── walkability & paths ───────────────────── */

	/** A spot tile is walkable only by whoever holds it, so nobody stands in
	 *  someone else's chair — the reference's withOwnSeatUnblocked, inlined. */
	/** Is this tile open floor, ignoring who owns it? Used by reachability tests. */
	/** A project colour, for tests and callers that need it. */
	colourOf(proj: string) {
		return this.zoneColor.get(proj) ?? ROOFS[0]
	}

	isOpen(col: number, row: number) {
		if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false
		return this.grid[row][col] === 'floor'
	}

	protected isWalkable(col: number, row: number, own?: string) {
		if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false
		if (this.grid[row][col] !== 'floor') return false
		const k = `${col},${row}`
		return !this.seatTiles.has(k) || k === own
	}

	protected findPath(sc: number, sr: number, ec: number, er: number, own?: string) {
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
	protected relocate() {
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

		// Re-assert ownership of seats that are already held.
		//
		// A re-plan (any resize — including the one a cmux workspace switch causes)
		// clears every spot and rebuilds the desks under the same ids, d0..dn. So a
		// seated character still names a seat that exists and the guard above does
		// not fire, yet the freshly built spot has no owner and nothing below
		// re-claims it: `newcomers` only considers characters with no seat at all.
		// Every desk then stays unowned, and since a monitor takes `lit` from its
		// owner and a badge takes the level from it, the screens go dark and the
		// badges disappear outright — while the characters, which live in
		// `this.chars` and are never touched by planning, carry on animating.
		// Sorted so that if two ever name the same seat the winner is stable.
		for (const ch of [...this.chars.values()].sort((a, b) => a.id.localeCompare(b.id))) {
			if (!ch.seatId) continue
			const spot = this.spots.get(ch.seatId)
			if (!spot || spot.kind !== 'desk' || (spot.taken && spot.taken !== ch.id)) {
				ch.seatId = null // the seat is gone or somebody else holds it
				continue
			}
			spot.taken = ch.id
		}

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
	protected claimDesk(s: Session, desks: Spot[]) {
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
	protected spawn(s: Session, seat: Spot): Character {
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
			chatWanted: false,
			bubble: null,
			bubbleTimer: 0,
		}
	}

	/* ───────────────────── simulation ───────────────────── */

	/** Blocked on your approval is still mid-turn, so it stays at the desk. */
	protected atDesk = (s: Session) => s.state === 'working' || s.state === 'shell' || s.state === 'needs'

	/* ── claims and reservations ──
	 * These live with the room rather than the simulation: they are operations on
	 * who owns a tile, and assign() needs them before any simulation runs. */

	/** One teardown for every exit, so no claim or pairing can leak. */
	protected release(ch: Character) {		const act = ch.activity
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
		ch.chatWanted = false
	}

	protected reserve(ch: Character, col: number, row: number) {
		const k = `${col},${row}`
		const holder = this.dest.get(k)
		if (holder && holder !== ch.id) return false
		this.unreserve(ch)
		this.dest.set(k, ch.id)
		return true
	}

	protected unreserve(ch: Character) {
		for (const [k, id] of this.dest) if (id === ch.id) this.dest.delete(k)
	}

	/** Free floor that nobody else is heading to or standing on. */
	protected freeTiles() {
		const open = this.walkable.filter((t) => {
			const k = `${t.col},${t.row}`
			return !this.dest.get(k) && !this.seatTiles.has(k)
		})
		// keep downtime out of the work zone; walking THROUGH it is still fine
		const social = open.filter((t) => t.row > this.workBottom + 1)
		return social.length ? social : open
	}

}

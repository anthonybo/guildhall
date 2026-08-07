/**
 * What everybody does with their time.
 *
 * Working sessions sit and type. Everyone else walks to a kitchen, a couch, a
 * ping-pong table, or into a conversation. The reference project has no such
 * system — its idle agents wander to random floor tiles — but an office where
 * nothing happens away from the desks reads as broken rather than calm.
 */
import type { Session } from '../data/types.ts'
import {
	CHAT_RADIUS,
	DONE_BUBBLE_SEC,
	DWELL,
	IDLE_PAUSE_MAX,
	IDLE_PAUSE_MIN,
	SEAT_REST_MAX,
	SEAT_REST_MIN,
	TILE,
	TYPE_FRAME_SEC,
	WALK_FRAME_SEC,
	WALK_TILES_PER_SEC,
	type Character,
	type Dir,
} from './model.ts'
import { RoomBase } from './room.ts'

export class SimBase extends RoomBase {
	update(dt: number, sessions: Session[]) {
		this.ballT += dt * 1.6
		const byId = new Map(sessions.map((s) => [s.id, s]))
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
					// Two people standing shoulder to shoulder both facing the camera
					// reads as nobody doing anything. If somebody is directly beside
					// you, turn and face them — it costs no state and it is what the
					// room is telling you anyway.
					//
					// Right first, so a pair always resolves to facing each other
					// rather than to whichever neighbour happened to come first. But
					// preference alone is not enough: turning right puts your back to
					// whoever is on your left, and if THEY are already facing away —
					// mid-conversation with someone further along — the two of you end
					// up back to back, which reads as a fault rather than as an office.
					// A scan of forty simulated rooms found this in 7 of 5692 adjacent
					// pairs, always the same shape: [talker facing left][you][someone].
					// So a side that would leave you back to back loses to one that
					// would not, and you look at the talker's back instead, which reads
					// as waiting to join in.
					const beside = (dc: number) =>
						[...this.chars.values()].find((o) => o !== ch && o.state !== 'walk' && o.row === ch.row && o.col === ch.col + dc)
					const right = beside(1)
					const left = beside(-1)
					const backToBack = (face: Dir) => {
						const behind = face === 'right' ? left : right
						return !!behind && behind.dir === (face === 'right' ? 'left' : 'right')
					}
					if (right && !(backToBack('right') && left && !backToBack('left'))) ch.dir = 'right'
					else if (left) ch.dir = 'left'
					else if (right) ch.dir = 'right'
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
					if (this.rng() < 0.35) {
						ch.chatWanted = true
						break // the broker pairs us up once a second one wants to
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
		if ([...this.chars.values()].filter((c) => c.chatWanted).length >= 2) this.brokerChats(byId)
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

	/** Prefer a facility someone is already at, which is what makes a group read
	 *  as a group without any explicit socialising logic. */
	private goToSpot(ch: Character) {
		// ping pong is pair-only: a solo player looks broken, so the broker owns it
		const free = [...this.spots.values()].filter((s) => s.kind !== 'desk' && s.kind !== 'pingpong' && !s.taken)
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
			.filter((c) => c.state === 'idle' && c.chatWanted && !c.activity && !this.atDesk(byId.get(c.id)!))
			.sort((a, b) => a.id.localeCompare(b.id))
		for (let i = 0; i < waiting.length; i++) {
			const a = waiting[i]
			if (a.activity) continue
			for (let j = i + 1; j < waiting.length; j++) {
				const b = waiting[j]
				if (b.activity) continue
				if (Math.abs(a.col - b.col) + Math.abs(a.row - b.row) > CHAT_RADIUS) continue
				// a free table with BOTH ends open becomes a game
				const table = [...new Set([...this.spots.values()].filter((x) => x.kind === 'pingpong').map((x) => x.group))]
					.map((g) => [...this.spots.values()].filter((x) => x.group === g))
					.find((pair) => pair.length === 2 && pair.every((x) => !x.taken))
				if (table) {
					const [t0, t1] = table
					const d = this.rand(...DWELL.pingpong)
					t0.taken = a.id
					t1.taken = b.id
					a.activity = { kind: 'pingpong', spotId: t0.id, partner: b.id, timer: d }
					b.activity = { kind: 'pingpong', spotId: t1.id, partner: a.id, timer: d }
					a.chatWanted = b.chatWanted = false
					if (this.walkTo(a, t0.col, t0.row, `${t0.col},${t0.row}`) && this.walkTo(b, t1.col, t1.row, `${t1.col},${t1.row}`)) break
					this.release(a)
					this.release(b)
				}
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
					a.chatWanted = b.chatWanted = false
					if (this.walkTo(a, s0.col, s0.row, `${s0.col},${s0.row}`) && this.walkTo(b, s1.col, s1.row, `${s1.col},${s1.row}`)) break
					this.release(a)
					this.release(b)
				}
				const pair = this.findTalkPair(a, b)
				if (!pair) continue
				a.activity = { kind: 'talk', spotId: null, partner: b.id, timer: dur }
				b.activity = { kind: 'talk', spotId: null, partner: a.id, timer: dur }
				a.chatWanted = b.chatWanted = false
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

}

/**
 * Drawing the room.
 *
 * The public face of the office: `Office` is the renderer layered over the
 * simulation (office/sim.ts), which is layered over the room itself
 * (office/room.ts). Everything here reads state and writes pixels; nothing here
 * decides what anyone does.
 *
 * The model comes from pixel-agents (MIT), with three deliberate differences,
 * each for a measured reason:
 *
 *  - The occupant faces UP into their desk. A character is one tile wide and two
 *    tall, so a desk drawn below the seat is completely hidden by whoever sits at
 *    it; this way you see both their back and their screen.
 *  - Seats are claimed once and held. Re-deriving them each poll put ~48% of
 *    seated frames in someone else's chair, and let two characters share a tile.
 *  - Sessions that are not working leave their desk for a kitchen, a couch, a
 *    ping-pong table or a conversation. The reference has no such system; its
 *    idle agents wander to random floor tiles and come back.
 */
import { C, LOOK, ROOFS } from './theme.ts'
import { RANK, type Session } from './data/types.ts'
import { cut } from './data/describe.ts'
import { Canvas } from './canvas.ts'
import type { Pose } from './characters.ts'
import { PROP_SIZE } from './props.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, SCREEN_HOLD, SIT_SINK, TILE, type Character, type Placed } from './office/model.ts'
import { SimBase } from './office/sim.ts'

export { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, SIT_SINK, TILE } from './office/model.ts'
export type { Character, Dir, Placed } from './office/model.ts'

export class Office extends SimBase {
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
				const col = this.zoneColor.get(z) ?? ROOFS[0]
				cv.tint(c * TILE, r * TILE, TILE, TILE, col, 0.2)
				// edge only where the neighbour differs, which gives a pod-shaped rug
				if (this.zoneOf[r - 1]?.[c] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE + i, r * TILE, col)
				if (this.zoneOf[r + 1]?.[c] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE + i, r * TILE + TILE - 1, col)
				if (this.zoneOf[r][c - 1] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE, r * TILE + i, col)
				if (this.zoneOf[r][c + 1] !== z) for (let i = 0; i < TILE; i++) cv.set(c * TILE + TILE - 1, r * TILE + i, col)
			}
		}
		this.imageSpans.clear()
		const block = (x: number, y: number, w: number, hRows: number) => {
			for (let i = 0; i < hRows; i++) {
				const row = (y >> 1) + i
				const arr = this.imageSpans.get(row) ?? []
				arr.push([x, x + w])
				this.imageSpans.set(row, arr)
			}
		}
		this.monitors = []
		this.badges = []
		const lit = new Map<string, Session['toolKind']>()
		const levels = new Map<string, number>()
		const asking = new Set<string>()
		for (const sp of this.spots.values()) {
			if (sp.kind !== 'desk' || !sp.taken) continue
			const s = byId.get(sp.taken)
			if (s) levels.set(`${sp.col},${sp.row}`, s.level)
			if (s && s.state === 'needs') asking.add(`${sp.col},${sp.row}`)
			// A session is only 'busy' while it is literally generating, so the screen
			// blinked off in every pause between turns. Hold the light briefly after,
			// which is what a machine someone is working at actually looks like.
			if (s && (this.atDesk(s) || s.stale < SCREEN_HOLD)) lit.set(`${sp.col},${sp.row}`, s.toolKind)
		}
		// a monitor stands on the row above its worktop, clear of its occupant
		for (const pod of this.pods)
			// step 2: desks sit on alternate columns, so only those get a monitor
			for (let c = pod.c0; c <= pod.c1; c += 2) {
				this.monitors.push({
					x: c * TILE,
					y: pod.monitorRow * TILE,
					lit: lit.has(`${c},${pod.seatRow}`),
					seed: c + pod.monitorRow,
					kind: lit.get(`${c},${pod.seatRow}`) ?? 'think',
				})
				block(c * TILE, pod.monitorRow * TILE, MON_COLS, MON_ROWS)
				// beside the desk, in the gap column, where nobody sits
				const lvl = levels.get(`${c},${pod.seatRow}`) ?? 0
				if (lvl) {
					this.badges.push({ x: c * TILE + TILE, y: pod.deskRow * TILE, level: lvl, asking: false })
					block(c * TILE + TILE, pod.deskRow * TILE, TILE, TILE / 2)
				}
				// a session waiting on an answer gets a placard beside its desk, since
				// the registry never reports a plain question as "waiting"
				if (asking.has(`${c},${pod.seatRow}`)) {
					this.badges.push({ x: c * TILE + TILE, y: pod.monitorRow * TILE, level: 0, asking: true })
					block(c * TILE + TILE, pod.monitorRow * TILE, TILE, TILE / 2)
				}
			}
		for (const pr of this.props) {
			const size = PROP_SIZE[pr.kind]
			block(pr.x, pr.y, size.w * TILE, (size.h * TILE) / 2)
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
			// a claimed spot only means somebody is on their way to it — the rally
			// starts when both players have actually arrived and are playing
			if (pair.length !== 2) continue
			const playing = pair.every((sp) => {
				if (!sp.taken) return false
				const ch = this.chars.get(sp.taken)
				return !!ch && ch.state === 'act' && ch.col === sp.col && ch.row === sp.row
			})
			if (!playing) continue
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
			// the typing/reading frames have no legs, so they may only be used for a
			// seated character; anyone on their feet uses the walk set
			const pose: Pose = seated ? 'typing' : 'walk'
			const rally = ch.activity?.kind === 'pingpong'
			const step = seated || rally || ch.state === 'walk' ? ch.frame : 1
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
		// Cells a nameplate already occupies, per row. Plates are drawn widest-pod
		// first rather than left to right, and they are allowed to spill past their
		// own pod — so without this a later plate simply overwrote an earlier one and
		// you got "mari ouncewise". Measuring to the next POD was not enough: the
		// neighbour's plate can reach back toward you.
		const claimed = new Map<number, [number, number][]>()
		const blocks = (row: number) => claimed.get(row) ?? []

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
			// the desk row carries monitor images, which draw over text, so the plate
			// goes on the aisle row below the pod
			const plateRow = Math.min(cv.rows - 1, Math.floor(((pod.seatRow + 1) * TILE) / 2))
			const here = blocks(plateRow)
			const left0 = pod.c0 * TILE
			const right0 = (pod.c1 + 1) * TILE

			// stop at whichever comes first: the next pod, the edge, or a plate already
			// written on this row
			const podRight = (rightOf.length ? rightOf[0].c0 : this.cols - 1) * TILE
			const wallRight = Math.min(podRight, ...here.filter((b) => b[0] >= left0).map((b) => b[0]))
			const podLeft = (leftOf.length ? leftOf[0].c1 + 1 : 1) * TILE
			const wallLeft = Math.max(podLeft, ...here.filter((b) => b[1] <= right0).map((b) => b[1]))

			const roomRight = wallRight - left0 - 1
			const roomLeft = right0 - wallLeft - 1
			const span = Math.max(roomRight, roomLeft)
			if (span < 5) continue // no honest room for a name; better none than "m…"
			const text = ` ${cut(pod.proj, Math.max(3, span - 2))} `
			// when growing leftward, end the plate on the pod's right edge
			const startCol = Math.max(0, roomLeft > roomRight ? right0 - text.length : left0)
			cv.text(startCol, plateRow, text, C.ink, this.zoneColor.get(pod.proj) ?? ROOFS[0])
			claimed.set(plateRow, [...here, [startCol, startCol + text.length]])
		}
		// Characters are images as well, so their extents have to block text just
		// like furniture does, or a head gets drawn over a label.
		for (const p of placed) {
			for (let i = 0; i < CHAR_H / 2; i++) {
				const row = (p.y >> 1) + i
				const arr = this.imageSpans.get(row) ?? []
				arr.push([p.x, p.x + CHAR_W])
				this.imageSpans.set(row, arr)
			}
		}
		const taken = new Map<number, [number, number][]>()

		// Every character carries the same one-cell badge in the same place, pinned
		// beside its own head. A marker that is always present and never moves is a
		// legend you learn once; a label that relocates to free space has thrown away
		// the only thing it needed to say, which is whose it is.
		//
		// Words are detail-on-demand: the selection, and anything blocked on you.
		// They extend from the badge along the same row and are never rehomed. If the
		// words will not fit, the words go — the badge stays.
		for (const p of [...placed].sort((a, b) => RANK[a.s.state] - RANK[b.s.state] || a.x - b.x)) {
			const s = p.s
			const look = LOOK[s.state]
			const sel = s.id === selected
			const urgent = s.state === 'needs' || s.state === 'error'
			// Only draw a mark when it is ACTIONABLE. RimWorld shows a colonist's mood
			// solely when a breakdown is imminent; Stardew never puts a persistent
			// marker over a villager at all. A session that is merely working already
			// says so through position and a lit monitor — colour and shape carry
			// status, and text carries identity, which is the one rule every
			// precedent surveyed agrees on.
			if (!urgent && !sel) continue
			const row = p.y >> 1
			// nearest free cell to the head: right, left, then a row up or down. An
			// image would hide it, so a blocked cell is no use even though it is close.
			const spots: [number, number][] = [
				[row, p.x + CHAR_W],
				[row, p.x - 1],
				[row + 1, p.x + CHAR_W],
				[row - 1, p.x + CHAR_W],
				[row + 1, p.x - 1],
				[row - 1, p.x - 1],
			]
			const at = spots.find(([r, c]) => r >= 0 && r < cv.rows && c >= 0 && c < cv.w && !this.blocked(r, c, 1, taken))
			if (!at) continue
			const [badgeRow, badgeCol] = at
			cv.text(badgeCol, badgeRow, look.glyph, C.night, look.color)
			const mine = taken.get(badgeRow) ?? []
			mine.push([badgeCol, badgeCol + 1])
			taken.set(badgeRow, mine)

			if (!showAll && !urgent && !sel) continue
			if (!urgent && !sel) continue
			const body = s.short || (s.state === 'working' || s.state === 'shell' ? s.doing : s.title) || s.title
			const text = `${s.tab ? `⌘${s.tab} ` : ''}${cut(body, 26)} `
			// same row, immediately after the badge; try the left side if it overruns
			const rightFits = badgeCol + 1 + text.length <= cv.w && !this.blocked(badgeRow, badgeCol + 1, text.length, taken)
			const leftCol = p.x - text.length
			const fits = rightFits ? badgeCol + 1 : leftCol >= 0 && !this.blocked(badgeRow, leftCol, text.length, taken) ? leftCol : -1
			if (fits < 0) continue
			cv.text(fits, badgeRow, text, C.ink, urgent ? look.color : C.paper)
			const used = taken.get(badgeRow) ?? []
			used.push([fits, fits + text.length])
			taken.set(badgeRow, used)
		}
	}

	/** Is this run free of other text and of any image? */
	private blocked(row: number, col: number, len: number, taken: Map<number, [number, number][]>) {
		const spans = [...(taken.get(row) ?? []), ...(this.imageSpans.get(row) ?? [])]
		return spans.some((r) => col < r[1] && col + len > r[0])
	}
}


/** A worktop with a monitor whose screen lights up while its owner works. */
function drawDesk(cv: Canvas, x: number, y: number, lit: boolean) {
	cv.rect(x, y, TILE, TILE, C.deskTop)
	cv.rect(x, y, TILE, 1, C.deskEdge)
	cv.rect(x, y + TILE - 1, TILE, 1, C.deskEdge)
	// a warm pool of light on the worktop when the machine is in use
	if (lit) cv.tint(x, y, TILE, TILE, C.screenOn, 0.28)
}



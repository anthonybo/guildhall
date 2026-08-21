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
import { TINT } from './screens.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, PLATE_COLS, PLATE_ROWS, SCREEN_HOLD, SIT_SINK, TILE, type Character, type Placed } from './office/model.ts'
import { SimBase } from './office/sim.ts'

export { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, SIT_SINK, TILE } from './office/model.ts'
export type { Character, Dir, Placed } from './office/model.ts'

export class Office extends SimBase {
	/** whether nameplates are drawn as rotated images beside each pod */
	vertical = false

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
		this.plates = []
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
				// A light sliding along the floor under a desk somebody is working at, so
				// who is active reads from across the room without looking at any screen.
				//
				// It is drawn into the CANVAS, not into the monitor sprite and not as a
				// pass in the compositor, because the canvas is the one surface all three
				// renderers share — the terminal draws it as half-blocks, the browser and
				// the docs run it through renderRoom. Put anywhere else it exists in some
				// of them and not others; the first attempt lived in the sprite and so
				// never reached the terminal at all.
				//
				// Under the desk rather than on it. The desk's own front edge was tried
				// first and looked right in the sprite, but the occupant sits directly at
				// it and is exactly as wide as it is: measured on a real frame, only about
				// 24 pixels across five lit desks survived to the screen. The bar is also
				// drawn a pixel wider than the desk on each side so its ends clear their
				// shoulders.
				//
				// FOUR rows below the seat, which is the first row outside the pod's
				// carpet — the carpet covers the monitor, desk and seat rows and so ends
				// at +3.
				//
				// Both neighbours were tried on the real screen. At +3 the light is ON the
				// carpet and reads as part of the desk: "I see it at the bottom of the desk
				// but not below it". At +5 there is a whole empty row between them and it
				// floats: "a little too far down". +4 touches the carpet's outside edge,
				// which is the subtle gap that was actually wanted. The clear band runs to
				// +8 where the next pod's monitor starts, so there is room either way; this
				// is about what it reads as, not about what fits.
				if (lit.has(`${c},${pod.seatRow}`)) {
					const span = TILE + 2
					const y = pod.seatRow * TILE + 4
					const head = Math.floor(this.glowT * 2.5) % span
					const tint = TINT[lit.get(`${c},${pod.seatRow}`) ?? 'think'] ?? TINT.think
					// three pixels, brightest at the head, so it reads as travelling rather
					// than blinking in place
					cv.tint(c * TILE - 1 + head, y, 1, 1, tint, 0.9)
					cv.tint(c * TILE - 1 + ((head + span - 1) % span), y, 1, 1, tint, 0.55)
					cv.tint(c * TILE - 1 + ((head + span - 2) % span), y, 1, 1, tint, 0.25)
				}
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
		// Nameplates, as images beside each pod. `block` is what keeps the status
		// labels off them — the same mechanism furniture already uses — which is why
		// this no longer needs the "draw plates last" ordering hack.
		if (this.vertical) {
			const named = new Set<string>()
			for (const pod of this.pods) {
				if (named.has(pod.proj)) continue
				const x = pod.c0 * TILE - PLATE_COLS
				if (x < 0) continue
				named.add(pod.proj)
				this.plates.push({ x, y: pod.monitorRow * TILE, proj: pod.proj, colour: this.zoneColor.get(pod.proj) ?? ROOFS[0] })
				block(x, pod.monitorRow * TILE, PLATE_COLS, PLATE_ROWS)
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

	/**
	 * Project nameplates and per-character status labels.
	 *
	 * `vertical` runs the name down the column beside the pod instead of along the
	 * aisle beneath it. A horizontal plate is as wide as the name, which is what
	 * forced every long project to truncate and what made neighbouring plates fight
	 * over the same row; a vertical one costs one column and as many rows as the
	 * band already has, so the room reads as columns of desks rather than a wall of
	 * labels.
	 */
	overlay(cv: Canvas, placed: Placed[], selected?: string, showAll = true) {
		// `this.vertical`, never a parameter. This used to take the mode as a fifth
		// argument while draw() read the field, so a caller that set the field and
		// left the argument alone drew BOTH — a rotated plate beside every desk and
		// a horizontal one underneath it. One flag decides for both halves now.
		if (!this.vertical) this.horizontalPlates(cv)
		return this.labels(cv, placed, selected, showAll)
	}

	private horizontalPlates(cv: Canvas) {
		const named = new Set<string>()
		// Cells a nameplate already occupies, per row. Plates are drawn widest-pod
		// first rather than left to right, and they are allowed to spill past their
		// own pod — so without this a later plate simply overwrote an earlier one and
		// you got "mari saltmarsh". Measuring to the next POD was not enough: the
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
			// Also tell the status labels, which run afterwards and consult only
			// `imageSpans`. `claimed` is private to this pass, so without this a
			// status label sat straight on top of a nameplate and you got
			// "lan▲⌘3 Needs you rd". The vertical plates already register this way.
			const spans = this.imageSpans.get(plateRow) ?? []
			spans.push([startCol, startCol + text.length])
			this.imageSpans.set(plateRow, spans)
		}
	}

	/** Per-character status labels, which are the same either way. */
	private labels(cv: Canvas, placed: Placed[], selected?: string, showAll = true) {
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
			// Nearest free cell beside the character: right first, then left, working
			// down from the head. An image would hide it, so a blocked cell is no use
			// however close it is.
			//
			// Every row the character occupies, not just its head and one either side.
			// A character is CHAR_H/2 rows tall, and the old three-row window meant a
			// seated worker with the pod's nameplate to its left and its level badge
			// to its right had nowhere to go at all — measured, 0 of 6 candidates free
			// against 3 of 6 with horizontal plates, so switching to vertical silently
			// deleted the status labels. Beside the body is still beside the character.
			const rows = [...Array(CHAR_H / 2).keys()].map((i) => row + i)
			rows.push(row - 1, row + CHAR_H / 2)
			const spots: [number, number][] = []
			for (const r of rows) spots.push([r, p.x + CHAR_W], [r, p.x - 1])
			const free = spots.filter(([r, c]) => r >= 0 && r < cv.rows && c >= 0 && c < cv.w && !this.blocked(r, c, 1, taken))
			if (!free.length) continue

			const body = s.short || (s.state === 'working' || s.state === 'shell' ? s.doing : s.title) || s.title
			// The slot that says how to reach this worker. A cmux tab gives `⌘3`; a Codex
			// session has no pane to jump to, so the same slot names the harness instead
			// of sitting empty. Only sessions carrying `agent` are affected, and nothing
			// carries it today — so no existing label moves by a single column.
			const prefix = s.tab ? `⌘${s.tab} ` : s.agent === 'codex' ? 'cx ' : ''
			const want = prefix.length + 27 // 26 characters of body, plus a trailing space
			// below this the body is an ellipsis and one word, which the badge already
			// outperforms — so it is the line between "shorten it" and "drop it"
			const least = prefix.length + 6

			/**
			 * Free cells running outward from a badge position, away from the
			 * character — the room its words would have.
			 */
			const room = ([r, c]: [number, number]) => {
				const step = c < p.x ? -1 : 1
				let n = 0
				while (n < want) {
					const x = c + step * (n + 1)
					if (x < 0 || x >= cv.w || this.blocked(r, x, 1, taken)) break
					n++
				}
				return n
			}
			// Nearest spot that can carry words too, rather than merely the nearest.
			// Taking the first free cell put the badge in the one-cell gap between a
			// desk and its level badge, where nothing could follow it — so the words
			// were dropped even though the aisle a row below was empty. Both are
			// beside the character; only one of them can say anything.
			const at = free.find((sp) => room(sp) >= least) ?? free[0]
			const [badgeRow, badgeCol] = at
			cv.text(badgeCol, badgeRow, look.glyph, C.night, look.color)
			const mine = taken.get(badgeRow) ?? []
			mine.push([badgeCol, badgeCol + 1])
			taken.set(badgeRow, mine)

			if (!showAll && !urgent && !sel) continue
			// Words shrink before they vanish. This used to demand the full width on
			// the right, then the full width on the left, and drop the label if
			// neither had it — which in a packed desk band is most of the time. A
			// truncated "editing app.ts" still answers the question the label exists
			// to answer; nothing at all does not.
			const n = room(at)
			if (n < least) continue
			const text = `${prefix}${cut(body, n - prefix.length - 1)} `
			const fits = badgeCol < p.x ? badgeCol - text.length : badgeCol + 1
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



/**
 * Laying out the room.
 *
 * A pure function of the viewport and the population — not the viewport alone,
 * or every project would tile identically and the room would carry no
 * information. Nothing here reads or writes simulation state: it returns a fresh
 * room, and the caller adopts it.
 *
 * The vertical unit is a band of [monitor, worktop, seat, aisle]. The occupant
 * faces UP into the desk, because a character is two tiles tall: sitting with the
 * desk above leaves the monitor row clear over their head, which is the only
 * arrangement that shows both the worker's back and their screen.
 */
import { projectColours, type RGB } from '../theme.ts'
import { PROP_SIZE, type PropKind } from '../props.ts'
import { DROP_ORDER, FACILITIES, MAX_RUN, TILE, type Dir, type Kind, type Pod, type Spot } from './model.ts'

export type Room = {
	cols: number
	rows: number
	grid: Kind[][]
	zoneOf: (string | null)[][]
	spots: Map<string, Spot>
	seatTiles: Set<string>
	pods: Pod[]
	props: { kind: PropKind; x: number; y: number }[]
	walkable: { col: number; row: number }[]
	/** last row belonging to a desk band; downtime happens below this */
	workBottom: number
	zoneColor: Map<string, RGB>
	/** seats that did not fit, reported rather than silently discarded */
	hiddenCount: number
	dropped: string[]
}

export function planRoom(cols: number, rows: number, projects: { name: string; seats: number }[]): Room {
	const grid: Kind[][] = Array.from({ length: rows }, () => new Array<Kind>(cols).fill('floor'))
	const zoneOf: (string | null)[][] = Array.from({ length: rows }, () => new Array<string | null>(cols).fill(null))
	for (let c = 0; c < cols; c++) {
		grid[0][c] = 'wall'
		grid[rows - 1][c] = 'wall'
	}
	for (let r = 0; r < rows; r++) {
		grid[r][0] = 'wall'
		grid[r][cols - 1] = 'wall'
	}

	const room: Room = {
		cols,
		rows,
		grid,
		zoneOf,
		spots: new Map(),
		seatTiles: new Set(),
		pods: [],
		props: [],
		walkable: [],
		workBottom: 1,
		zoneColor: new Map(),
		hiddenCount: 0,
		dropped: [],
	}
	room.zoneColor = projectColours(projects.map((p) => p.name))

	// Row 1 is a gutter carrying each front-row occupant's head and status label,
	// so nothing may ever be placed there.
	const bandRows: number[] = []
	for (let r = 1; r + 3 < rows - 1; r += 4) bandRows.push(r)

	const band = seatProjects(room, projects, bandRows)
	const socialBands = addFacilities(room, bandRows, band)
	addTalkArea(room, socialBands)
	addDecor(room, socialBands)

	for (let r = 0; r < rows; r++)
		for (let c = 0; c < cols; c++) if (grid[r][c] === 'floor') room.walkable.push({ col: c, row: r })
	return room
}

/** Desk pods, packed left to right along each band. Returns the first free band. */
function seatProjects(room: Room, projects: { name: string; seats: number }[], bandRows: number[]) {
	// a project wider than MAX_RUN spills into a second pod rather than one long row
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
		const hi = room.cols - 3
		while (i < wishlist.length) {
			const want = wishlist[i]
			const span = want.seats * 2 - 1 // one gap between each pair of desks
			if (lo + span - 1 > hi) break
			const c0 = lo
			const c1 = c0 + span - 1
			for (let c = c0; c <= c1; c += 2) {
				room.grid[deskRow][c] = 'desk'
				const id = `d${n++}`
				room.spots.set(id, {
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
				room.seatTiles.add(`${c},${seatRow}`)
				for (const r of [monitorRow, deskRow, seatRow]) room.zoneOf[r][c] ??= want.proj
			}
			room.pods.push({ proj: want.proj, c0, c1, seatRow, deskRow, monitorRow })
			lo = c1 + 3 // a two-tile gap so neighbouring pods stay legible
			i++
		}
		band++
	}

	// anyone who could not be seated is counted, never silently dropped
	for (const w of wishlist) {
		const seated = room.pods.filter((p) => p.proj === w.proj).reduce((a, p) => a + (p.c1 - p.c0 + 1), 0)
		const wanted = wishlist.filter((x) => x.proj === w.proj).reduce((a, x) => a + x.seats, 0)
		if (seated < wanted && !room.dropped.includes(w.proj)) room.hiddenCount += wanted - seated
	}
	room.dropped = []

	// +1 is the nameplate row; a standing character is two tiles tall, so its head
	// reaches one row above its feet and must clear the plate as well
	room.workBottom = room.pods.length ? Math.max(...room.pods.map((p) => p.seatRow)) + 1 : 1
	return band
}

/** Kitchen, couches and ping-pong, anchored low so the gap becomes a corridor. */
function addFacilities(room: Room, bandRows: number[], firstFree: number) {
	const below = room.workBottom + 2
	const socialBands = bandRows
		.slice(firstFree)
		.filter((r) => r >= below)
		.slice(-2)

	let wish = ['couch', 'kitchen', 'couch', 'pingpong', 'couch']
	while (socialBands.length * 2 < wish.length - 1 && DROP_ORDER.some((d) => wish.includes(d))) {
		const drop = DROP_ORDER.find((d) => wish.includes(d))!
		wish = wish.filter((w) => w !== drop)
		room.dropped.push(drop)
	}

	let sb = 0
	for (let i = 0; i < wish.length && sb < socialBands.length; ) {
		const row = socialBands[sb]
		let lo = 2
		let hi = room.cols - 3
		for (let side = 0; side < 2 && i < wish.length; side++) {
			const f = FACILITIES[wish[i]]
			if (!f || hi - lo + 1 < f.w + (side === 0 ? 2 : 0) || row + f.h > room.rows - 1) {
				i++
				side--
				if (i >= wish.length) break
				continue
			}
			const c0 = side === 0 ? lo : hi - f.w + 1
			placeFacility(room, f, c0, row, `${wish[i]}@${row}`)
			if (side === 0) lo = c0 + f.w + 2
			else hi = c0 - 1
			i++
		}
		sb++
	}
	return socialBands
}

function placeFacility(room: Room, f: (typeof FACILITIES)[string], c0: number, r0: number, group: string) {
	for (const pr of f.props) {
		const lift = pr.dr > 0 && !pr.under ? TILE / 2 : 0
		room.props.push({ kind: pr.kind, x: (c0 + pr.dc) * TILE, y: (r0 + pr.dr) * TILE - lift })
		if (pr.under) continue // you can stand on a couch; you cannot stand on a counter
		const size = PROP_SIZE[pr.kind]
		for (let dr = 0; dr < size.h; dr++)
			for (let dc = 0; dc < size.w; dc++) {
				const c = c0 + pr.dc + dc
				const r = r0 + pr.dr + dr
				if (r > 0 && r < room.rows - 1 && c > 0 && c < room.cols - 1) room.grid[r][c] = 'solid'
			}
	}
	f.spots.forEach(([dc, dr, facing, posture], k) => {
		const id = `${group}:${k}`
		room.spots.set(id, {
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
		room.seatTiles.add(`${c0 + dc},${r0 + dr}`)
	})
}

/**
 * A conversation costs no furniture, so it always gets somewhere to happen. It
 * must be BELOW every desk band: anything inside the work zone puts idle people
 * on top of a workstation, which destroys the one signal that matters — whoever
 * is at a desk is working.
 */
function addTalkArea(room: Room, socialBands: number[]) {
	const corridor = socialBands.length ? socialBands[0] - 2 : room.rows - 3
	const below = room.workBottom + 2
	let talkRow = -1
	for (let r = Math.max(below, corridor); r < room.rows - 1 && talkRow < 0; r++)
		if ([2, 3].every((c) => room.grid[r][c] === 'floor' && !room.seatTiles.has(`${c},${r}`))) talkRow = r

	if (talkRow >= 0 && room.cols > 8) {
		const pair: [number, Dir][] = [
			[2, 'right'],
			[3, 'left'],
		]
		pair.forEach(([c, facing], k) => {
			const id = `talk@${talkRow}:${k}`
			room.spots.set(id, {
				id,
				kind: 'talk',
				group: `talk@${talkRow}`,
				col: c,
				row: talkRow,
				facing,
				posture: 'stand',
				zone: null,
				taken: null,
			})
			room.seatTiles.add(`${c},${talkRow}`)
		})
	}

	// a window on the wall is a free loiter spot and costs no band
	if (corridor > 1 && corridor < room.rows - 1) {
		room.spots.set('w0', {
			id: 'w0',
			kind: 'window',
			group: 'window',
			col: room.cols - 2,
			row: corridor,
			facing: 'right',
			posture: 'stand',
			zone: null,
			taken: null,
		})
	}
}

/** So the room reads as an office rather than a grid of desks. */
function addDecor(room: Room, socialBands: number[]) {
	if (room.cols <= 14) return
	// Not tile 1 on the top band: that is the strip the leftmost pod's nameplate
	// needs, and decor must not sit on the one thing in the room that identifies
	// a desk. The corner opposite is free either way.
	room.props.push({ kind: 'plant', x: 1 * TILE, y: (room.rows - 3) * TILE })
	room.props.push({ kind: 'plant', x: (room.cols - 2) * TILE, y: 1 * TILE })
	room.grid[room.rows - 3][1] = 'solid'
	room.grid[1][room.cols - 2] = 'solid'
	room.props.push({ kind: 'whiteboard', x: 3 * TILE, y: 0 })
	room.props.push({ kind: 'shelf', x: (room.cols - 4) * TILE, y: 0 })
	const cr = socialBands.length ? socialBands[0] - 2 : room.rows - 3
	if (cr > 1 && cr < room.rows - 2) {
		room.props.push({ kind: 'cooler', x: 1 * TILE, y: cr * TILE })
		room.grid[cr][1] = 'solid'
	}
}

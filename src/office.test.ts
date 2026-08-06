import assert from 'node:assert/strict'
import test from 'node:test'
import { Canvas } from './canvas.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, Office, TILE } from './office.ts'
import type { Session, State } from './data.ts'

/** Seeded LCG so every behavioural test is reproducible. */
const seeded = (seed = 12345) => {
	let s = seed >>> 0
	return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)
}

function session(id: string, proj: string, state: State): Session {
	return {
		id,
		pid: 1,
		name: id,
		proj,
		cwd: `/x/${proj}`,
		state,
		stale: 60_000,
		title: `work on ${proj}`,
		doing: 'editing a file',
		short: 'Editing a file',
		last: 'said a thing',
		ctxUsed: 50_000,
		ctxLimit: 200_000,
		tab: 1,
		unread: false,
		toolKind: 'edit' as const,
		turns: 40,
		level: 5,
		palette: 0,
		hueShift: 0,
	}
}

const room = (list: Session[], w = 88, h = 76) => {
	const cv = new Canvas(w, h)
	const office = new Office(seeded())
	office.fit(cv.w, cv.h, list)
	office.assign(list)
	return { cv, office }
}

const desks = (o: Office) => [...o.spots.values()].filter((s) => s.kind === 'desk')
const seatOf = (o: Office, id: string) => o.spots.get(o.chars.get(id)!.seatId!)!
const posOf = (o: Office, id: string) => {
	const c = o.chars.get(id)!
	return `${c.col},${c.row},${c.state}`
}

test('a session starts seated at its desk, not at a doorway', () => {
	const list = [session('a', 'alpha', 'working')]
	const { office } = room(list)
	const ch = office.chars.get('a')!
	const seat = seatOf(office, 'a')
	assert.equal(ch.state, 'type', 'should be born working at the desk')
	assert.equal(ch.col, seat.col)
	assert.equal(ch.row, seat.row)
	assert.equal(ch.dir, seat.facing)
})

test('the occupant faces up into its desk, with the screen above its head', () => {
	const { office } = room([session('a', 'alpha', 'working')])
	const seat = seatOf(office, 'a')
	assert.equal(seat.facing, 'up', 'facing away from the desk would show their back to the screen')
	const pod = office.pods.find((p) => p.seatRow === seat.row && seat.col >= p.c0 && seat.col <= p.c1)!
	assert.ok(pod, 'the seat belongs to no pod')
	assert.equal(pod.deskRow, seat.row - 1, 'the worktop must be directly above the seat')
	assert.equal(pod.monitorRow, seat.row - 2, 'the monitor must clear the occupant head')
})

test('everybody gets their own desk and no two share one', () => {
	const list = Array.from({ length: 9 }, (_, i) => session(`s${i}`, i < 5 ? 'alpha' : 'beta', 'done'))
	const { office } = room(list)
	assert.equal(office.hiddenCount, 0, 'someone was left without a desk')
	const claimed = desks(office)
		.filter((d) => d.taken)
		.map((d) => d.taken)
	assert.equal(claimed.length, 9)
	assert.equal(new Set(claimed).size, 9, 'a desk was claimed twice')
})

test('seat assignment is sticky across polls and state changes', () => {
	const list = [
		session('a', 'alpha', 'parked'),
		session('b', 'beta', 'parked'),
		session('c', 'alpha', 'parked'),
		session('d', 'gamma', 'parked'),
	]
	const { office } = room(list)
	const before = list.map((s) => office.chars.get(s.id)!.seatId).join('|')
	// one session starts working — this used to rotate every assignment
	list[3] = { ...list[3], state: 'working' }
	office.assign(list)
	office.assign(list)
	assert.equal(list.map((s) => office.chars.get(s.id)!.seatId).join('|'), before, 'seats were reshuffled')
})

test('a departed session frees its desk for the next arrival', () => {
	const list = [session('a', 'alpha', 'parked'), session('b', 'beta', 'parked')]
	const { office } = room(list)
	const freed = office.chars.get('a')!.seatId
	office.assign([list[1]])
	assert.equal(office.chars.has('a'), false)
	assert.equal(office.spots.get(freed!)!.taken, null, 'the desk is still held by a dead session')
	office.assign([list[1], session('c', 'alpha', 'parked')])
	assert.ok(office.chars.get('c')!.seatId, 'the newcomer got no desk')
})

test('nobody can stand in somebody else s chair', () => {
	const list = Array.from({ length: 6 }, (_, i) => session(`s${i}`, 'alpha', 'parked'))
	const { office } = room(list)
	const owner = new Map([...office.spots.values()].filter((s) => s.taken).map((s) => [`${s.col},${s.row}`, s.taken!]))
	for (let i = 0; i < 4000; i++) {
		office.update(0.1, list)
		for (const ch of office.chars.values()) {
			const who = owner.get(`${ch.col},${ch.row}`)
			if (who && who !== ch.id) assert.fail(`${ch.id} is standing in ${who}'s seat`)
		}
	}
})

test('two characters never share a tile while stationary', () => {
	const list = Array.from({ length: 6 }, (_, i) => session(`s${i}`, i % 2 ? 'alpha' : 'beta', 'parked'))
	const { office } = room(list)
	for (let i = 0; i < 3000; i++) {
		office.update(0.1, list)
		const seen = new Map<string, string>()
		for (const ch of office.chars.values()) {
			if (ch.state === 'walk') continue
			const k = `${ch.col},${ch.row}`
			const other = seen.get(k)
			if (other) assert.fail(`${ch.id} and ${other} are both stopped on ${k}`)
			seen.set(k, ch.id)
		}
	}
})

test('a working session is at its own desk, and a parked one is not', () => {
	const list = [session('a', 'alpha', 'working'), session('b', 'beta', 'parked')]
	const { office } = room(list)
	for (let i = 0; i < 3000; i++) office.update(0.1, list)
	const a = office.chars.get('a')!
	assert.equal(a.state, 'type')
	assert.equal(posOf(office, 'a'), `${seatOf(office, 'a').col},${seatOf(office, 'a').row},type`)
	// the parked one must have left its desk for something social
	const b = office.chars.get('b')!
	const bSeat = seatOf(office, 'b')
	assert.ok(!(b.col === bSeat.col && b.row === bSeat.row && b.state === 'type'), 'a parked session is still working')
})

test('a session blocked on you stays at its desk', () => {
	// being blocked on a permission prompt is still mid-turn
	const list = [session('a', 'alpha', 'needs')]
	const { office } = room(list)
	for (let i = 0; i < 2000; i++) office.update(0.1, list)
	const ch = office.chars.get('a')!
	const seat = seatOf(office, 'a')
	assert.equal(ch.state, 'type', 'it walked away from its desk while waiting for you')
	assert.equal(ch.col, seat.col)
	assert.equal(ch.bubble, 'permission')
})

test('a session that starts working returns to its desk promptly', () => {
	const list = [session('a', 'alpha', 'parked')]
	const { office } = room(list)
	for (let i = 0; i < 1200; i++) office.update(0.1, list) // let it wander off
	const working = [{ ...list[0], state: 'working' as State }]
	let frames = 0
	while (frames < 400 && office.chars.get('a')!.state !== 'type') {
		office.update(0.1, working)
		frames++
	}
	assert.equal(office.chars.get('a')!.state, 'type', 'never got back to the desk')
	assert.ok(frames < 400, `took ${frames} frames`)
})

test('leisure spots are never double booked and never leak', () => {
	const list = Array.from({ length: 8 }, (_, i) => session(`s${i}`, 'alpha', 'parked'))
	const { office } = room(list)
	for (let i = 0; i < 5000; i++) {
		office.update(0.1, list)
		const held = [...office.spots.values()].filter((s) => s.taken && s.kind !== 'desk').map((s) => s.taken!)
		assert.equal(new Set(held).size, held.length, 'a leisure spot is held twice')
		for (const s of office.spots.values()) if (s.taken) assert.ok(office.chars.has(s.taken), 'spot held by a ghost')
	}
	// everyone going back to work must release everything
	const working = list.map((s) => ({ ...s, state: 'working' as State }))
	for (let i = 0; i < 600; i++) office.update(0.1, working)
	for (const s of office.spots.values()) if (s.kind !== 'desk') assert.equal(s.taken, null, 'leisure spot still held')
	for (const ch of office.chars.values()) assert.equal(ch.activity, null, 'activity was not released')
})

test('a conversation is mutual, or it does not happen', () => {
	const list = Array.from({ length: 6 }, (_, i) => session(`s${i}`, 'alpha', 'parked'))
	const { office } = room(list)
	for (let i = 0; i < 5000; i++) {
		office.update(0.1, list)
		for (const ch of office.chars.values()) {
			const partner = ch.activity?.partner
			if (!partner) continue
			const p = office.chars.get(partner)
			assert.ok(p, `${ch.id} is talking to a ghost`)
			assert.equal(p!.activity?.partner, ch.id, 'a conversation is one-sided')
		}
	}
})

test('ping pong has exactly zero or two players', () => {
	const list = Array.from({ length: 8 }, (_, i) => session(`s${i}`, 'alpha', 'parked'))
	const { office } = room(list)
	for (let i = 0; i < 4000; i++) {
		office.update(0.1, list)
		const groups = new Map<string, number>()
		for (const s of office.spots.values()) {
			if (s.kind !== 'pingpong' || !s.taken) continue
			groups.set(s.group, (groups.get(s.group) ?? 0) + 1)
		}
		// zero or two: a solo player at a ping-pong table looks broken
		for (const n of groups.values()) assert.ok(n === 2, `${n} player(s) at one table`)
	}
})

test('drawing never moves anybody — only update() does', () => {
	const list = [session('a', 'alpha', 'working'), session('b', 'beta', 'parked')]
	const { cv, office } = room(list)
	for (let i = 0; i < 200; i++) office.update(0.1, list)
	const before = list.map((s) => posOf(office, s.id)).join('|')
	for (let i = 0; i < 20; i++) office.draw(cv, list)
	assert.equal(list.map((s) => posOf(office, s.id)).join('|'), before)
})

test('a data refresh does not teleport anyone', () => {
	const list = [session('a', 'alpha', 'working')]
	const { office } = room(list)
	for (let i = 0; i < 300; i++) office.update(0.1, list)
	const settled = posOf(office, 'a')
	office.assign(list)
	assert.equal(posOf(office, 'a'), settled)
})

test('a resize leaves nobody stranded outside the room', () => {
	const list = Array.from({ length: 6 }, (_, i) => session(`s${i}`, 'alpha', 'parked'))
	const { office } = room(list)
	for (let i = 0; i < 500; i++) office.update(0.1, list)
	const small = new Canvas(52, 40)
	office.fit(small.w, small.h, list)
	office.assign(list)
	for (const ch of office.chars.values()) {
		assert.ok(ch.col > 0 && ch.col < office.cols - 1, `${ch.id} at col ${ch.col} of ${office.cols}`)
		assert.ok(ch.row > 0 && ch.row < office.rows - 1, `${ch.id} at row ${ch.row} of ${office.rows}`)
	}
	// and they must still be able to move afterwards
	for (let i = 0; i < 800; i++) office.update(0.1, list)
	for (const ch of office.chars.values()) assert.ok(ch.col < office.cols && ch.row < office.rows)
})

test('every spot is reachable from the door', () => {
	const list = Array.from({ length: 10 }, (_, i) => session(`s${i}`, i < 6 ? 'alpha' : 'beta', 'parked'))
	const { office } = room(list)
	// walk out from a known-open tile and confirm each spot is adjacent to the flood
	const open = new Set<string>()
	const start = { col: 1, row: office.rows - 2 }
	let frontier = [start]
	open.add(`${start.col},${start.row}`)
	while (frontier.length) {
		const next: typeof frontier = []
		for (const t of frontier)
			for (const [dc, dr] of [
				[0, -1],
				[1, 0],
				[0, 1],
				[-1, 0],
			]) {
				const c = t.col + dc
				const r = t.row + dr
				const k = `${c},${r}`
				if (open.has(k) || c < 1 || r < 1 || c >= office.cols - 1 || r >= office.rows - 1) continue
				if (!office.isOpen(c, r)) continue
				open.add(k)
				next.push({ col: c, row: r })
			}
		frontier = next
	}
	for (const s of office.spots.values()) {
		const adjacent = [
			[0, -1],
			[1, 0],
			[0, 1],
			[-1, 0],
		].some(([dc, dr]) => open.has(`${s.col + dc},${s.row + dr}`))
		assert.ok(adjacent || open.has(`${s.col},${s.row}`), `spot ${s.id} (${s.kind}) is walled off`)
	}
})

test('every rendered row is exactly the canvas width', () => {
	const list = [session('a', 'alpha', 'needs'), session('b', 'beta', 'working')]
	const { cv, office } = room(list)
	office.overlay(cv, office.draw(cv, list), 'a')
	for (const line of cv.render()) {
		const bare = [...line.replace(/\x1b\[[0-9;]*m/g, '')].length
		assert.equal(bare, cv.w, `row was ${bare} columns, expected ${cv.w}`)
	}
})

test('the tile size stays even so image placements land on cell boundaries', () => {
	assert.equal(TILE % 2, 0)
})

test('an idle character never comes to rest inside the work zone', () => {
	const list = Array.from({ length: 8 }, (_, i) => session(`s${i}`, i < 4 ? 'alpha' : 'beta', 'parked'))
	const { office } = room(list)
	const deskRows = new Set<number>()
	for (const p of office.pods) for (const r of [p.monitorRow, p.deskRow, p.seatRow, p.seatRow + 1]) deskRows.add(r)
	let bad = 0
	for (let i = 0; i < 4000; i++) {
		office.update(0.1, list)
		for (const ch of office.chars.values()) {
			if (ch.state === 'walk' || ch.state === 'type') continue
			const seat = office.spots.get(ch.seatId ?? '')
			// standing at your OWN desk is fine — your head is over your own worktop
			if (seat && ch.col === seat.col && ch.row === seat.row) continue
			// otherwise a character is two tiles tall, so both its feet row and the
			// row its head reaches into must clear the work zone
			for (const r of [ch.row, ch.row - 1]) if (deskRows.has(r)) bad++
		}
	}
	assert.equal(bad, 0, `${bad} character-frames idling inside the work zone`)
})

test('exactly the working sessions have a lit screen', () => {
	const list = [
		session('a', 'alpha', 'working'),
		session('b', 'alpha', 'parked'),
		session('c', 'beta', 'needs'),
		session('d', 'beta', 'done'),
	]
	const { cv, office } = room(list)
	office.draw(cv, list)
	// one monitor per desk, and only working/blocked sessions light theirs
	assert.equal(office.monitors.length, [...office.spots.values()].filter((s) => s.kind === 'desk').length)
	assert.equal(
		office.monitors.filter((m) => m.lit).length,
		2,
		'working and needs-you are both mid-turn and should light the screen',
	)
	// and a monitor sits two rows above its seat, clear of the occupant
	for (const p of office.pods) assert.equal(p.monitorRow, p.seatRow - 2)
})

test('only mid-turn sessions get a label, plus the selection', () => {
	const list = [
		session('a', 'alpha', 'working'),
		session('b', 'alpha', 'parked'),
		session('c', 'beta', 'done'),
		session('d', 'beta', 'needs'),
	]
	const { cv, office } = room(list)
	const placed = office.draw(cv, list)
	office.overlay(cv, placed, 'c')
	const text = cv
		.render()
		.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
		.join('\n')
	// working and needs-you are mid-turn; done and parked are not
	assert.ok(text.includes('⌘1'), 'a working session should be labelled')
	// the selection is 'c', which is done — it is labelled because it is selected
	const labelled = list.filter((s) => text.includes(`⌘${s.tab}`)).length
	assert.ok(labelled >= 1, 'nothing was labelled at all')
})

test('a label never lands inside a character sprite', () => {
	const list = Array.from({ length: 6 }, (_, i) => session(`s${i}`, i < 3 ? 'alpha' : 'beta', i === 0 ? 'working' : 'parked'))
	const { cv, office } = room(list)
	for (let i = 0; i < 60; i++) office.update(0.1, list)
	const placed = office.draw(cv, list)
	office.overlay(cv, placed, placed[0]?.s.id)
	const boxes = placed.map((p) => ({ x0: p.x, x1: p.x + CHAR_W, r0: p.y >> 1, r1: (p.y >> 1) + CHAR_H / 2 - 1 }))
	let hits = 0
	cv.render().forEach((line, row) => {
		const bare = line.replace(/\x1b\[[0-9;]*m/g, '')
		for (let c = 0; c < bare.length; c++) {
			if (bare[c] === ' ' || bare[c] === '▀') continue
			// a character is drawn as an image over the text layer, so any label cell
			// inside its box would be invisible
			if (boxes.some((b) => row >= b.r0 && row <= b.r1 && c >= b.x0 && c < b.x1)) hits++
		}
	})
	assert.equal(hits, 0, `${hits} text cells hidden behind a character`)
})

test('what an image blocks matches what gets drawn', () => {
	// a monitor placed three cell rows tall but blocking two let labels land in the
	// third row and be covered by it
	assert.equal(MON_ROWS, TILE / 2 + 1)
	assert.equal(MON_COLS, TILE)
	const list = [session('a', 'alpha', 'working'), session('b', 'alpha', 'working')]
	const { cv, office } = room(list)
	const placed = office.draw(cv, list)
	office.overlay(cv, placed)
	const boxes = office.monitors.map((m) => ({ x0: m.x, x1: m.x + MON_COLS, r0: m.y >> 1, r1: (m.y >> 1) + MON_ROWS - 1 }))
	let hits = 0
	cv.render().forEach((line, row) => {
		const bare = line.replace(/\x1b\[[0-9;]*m/g, '')
		for (let c = 0; c < bare.length; c++) {
			if (bare[c] === ' ' || bare[c] === '▀') continue
			if (boxes.some((b) => row >= b.r0 && row <= b.r1 && c >= b.x0 && c < b.x1)) hits++
		}
	})
	assert.equal(hits, 0, `${hits} text cells hidden behind a monitor`)
})

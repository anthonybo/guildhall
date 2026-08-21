/** Seating, claims and movement: who sits where, and that nobody overlaps. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Canvas } from './canvas.ts'
import { Office } from './office.ts'
import type { State } from './data.ts'
import { desks, posOf, room, seatOf, seeded, session } from './office/fixtures.ts'

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

test('a re-plan keeps every desk claimed, so screens and badges survive', () => {
	// Switching cmux workspaces resizes the terminal, which re-plans the room.
	// plan() clears every spot and rebuilds desks under the SAME ids (d0..dn), so
	// a character still names a seat that exists and the stale-seat guard never
	// fires. Nothing then re-claimed the new spots, leaving every desk unowned:
	// monitors derive `lit` from the owner and badges derive the level from it, so
	// the screens went dark and the badges vanished entirely — while the characters,
	// which live in this.chars and are untouched by planning, kept animating.
	const list = [
		session('a', 'alpha', 'working'),
		session('b', 'beta', 'working'),
		session('c', 'gamma', 'parked'),
	]
	const cv = new Canvas(120, 80)
	const office = new Office(seeded())
	office.fit(cv.w, cv.h, list)
	office.assign(list)
	office.draw(cv, list)

	const badgesBefore = office.badges.length
	const litBefore = office.monitors.filter((m) => m.lit).length
	assert.ok(badgesBefore > 0, 'no badges even before the re-plan')
	assert.ok(litBefore > 0, 'no lit screens even before the re-plan')

	// the resize a workspace switch produces
	const cv2 = new Canvas(120, 78)
	office.fit(cv2.w, cv2.h, list)
	office.assign(list)
	office.draw(cv2, list)

	assert.equal(office.badges.length, badgesBefore, 'badges disappeared after a re-plan')
	assert.equal(office.monitors.filter((m) => m.lit).length, litBefore, 'screens went dark after a re-plan')
	const claimed = [...office.spots.values()].filter((s) => s.kind === 'desk' && s.taken).length
	assert.equal(claimed, list.length, 'desks were left unowned after a re-plan')
})

test('a re-plan never lets two characters hold one desk', () => {
	const list = [session('a', 'alpha', 'working'), session('b', 'beta', 'parked')]
	const cv = new Canvas(120, 80)
	const office = new Office(seeded())
	office.fit(cv.w, cv.h, list)
	office.assign(list)
	// re-plan, then admit a newcomer — it must not be handed an occupied desk
	office.fit(new Canvas(120, 78).w, 78, list)
	const grown = [...list, session('c', 'gamma', 'parked')]
	office.assign(grown)
	const owners = [...office.spots.values()].filter((s) => s.kind === 'desk' && s.taken).map((s) => s.taken)
	assert.equal(new Set(owners).size, owners.length, 'one session claimed two desks')
})

test('nobody ends up standing back to back', () => {
	// Found by scanning 40 simulated rooms: 7 of 5692 adjacent pairs stood back to
	// back, always the same shape — [talker facing left][idle person][someone else].
	// The idle rule preferred its right-hand neighbour, which turned its back on a
	// left-hand neighbour already facing away mid-conversation. Preference alone
	// cannot see the person behind you, so a side that would leave you back to back
	// now loses to one that would not.
	const opposite: Record<string, string> = { left: 'right', right: 'left', up: 'down', down: 'up' }
	const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => session(id, `p${i}`, i < 2 ? 'working' : 'parked'))
	const { office } = room(list)
	office.assign(list)
	for (let f = 0; f < 4000; f++) {
		office.update(1 / 30, list)
		if (f % 50) continue
		const here = [...office.chars.values()].filter((c) => c.state !== 'walk')
		for (const a of here) {
			for (const b of here) {
				if (a.id >= b.id) continue
				const dc = b.col - a.col
				const dr = b.row - a.row
				if (Math.abs(dc) + Math.abs(dr) !== 1) continue
				const toward = dc === 1 ? 'right' : dc === -1 ? 'left' : dr === 1 ? 'down' : 'up'
				assert.ok(!(a.dir === opposite[toward] && b.dir === toward), `${a.id} and ${b.id} stood back to back at frame ${f}`)
			}
		}
	}
})

test('a fresh room does not open with everyone at their computer', () => {
	// The opening frame is the one that gets believed, and it used to claim every
	// session was hard at work: spawn() hardcoded `type` at a desk regardless of
	// what the session was doing, so launching with eight parked sessions drew
	// eight people typing. They wandered off within seconds, but by then the wrong
	// impression was made. Only sessions that belong at a desk start in one.
	const list = [session('a', 'alpha', 'working'), session('b', 'beta', 'needs'), session('c', 'gamma', 'parked'), session('d', 'delta', 'done'), session('e', 'eps', 'parked')]
	const { office } = room(list)
	office.assign(list)
	const typing = () => [...office.chars.values()].filter((c) => c.state === 'type').length
	// working and needs belong at a desk; parked and done do not
	assert.equal(typing(), 2, 'someone who is not at their desk was drawn typing on the first frame')

	// and settling leaves nobody mid-stride, so the first paint is a still room
	office.settle(list)
	assert.equal(typing(), 2, 'settling changed who is working')
	assert.equal([...office.chars.values()].filter((c) => c.state === 'walk').length, 0, 'the room opened with someone mid-walk')
	// the desks stay owned either way: a desk is the project's identity, not a chair
	assert.equal([...office.spots.values()].filter((s) => s.kind === 'desk' && s.taken).length, list.length)
})

/** The label a single session gets, read off the rendered canvas. */
const labelFor = (s: ReturnType<typeof session>) => {
	// One session per room: labels need a free cell beside the character, and two
	// characters in a small room contend for the same space — which is how the first
	// version of this test "proved" a Codex label was missing when it had simply lost
	// the race for somewhere to sit.
	const list = [s]
	const { cv, office } = room(list, 120, 78)
	office.overlay(cv, office.draw(cv, list))
	return cv.render().join('\n').replace(/\x1b\[[0-9;]*m/g, '')
}

test('a Codex worker is named in its room label, where a tab number would go', () => {
	// Only on a label that is ALREADY being drawn. The room draws words solely for
	// what is actionable — urgent or selected — and argues the case at length: colour
	// and shape carry status, text carries identity. So this adds nothing to a merely
	// working session, and the list is where a harness stays visible at rest.
	//
	// Read off the rendered canvas rather than the helper, because the claim is about
	// what somebody sees. It covers the browser too: web/room.ts draws through this
	// same Office.
	// `tab: undefined` explicitly: the shared fixture sets `tab: 1`, so without this
	// the ⌘ branch wins and the test proves nothing about the Codex one.
	const codex = { ...session('cx1', 'orchard', 'needs'), tab: undefined, agent: 'codex' as const }
	assert.match(labelFor(codex), /cx /, 'a Codex worker is indistinguishable from a Claude one')
	assert.doesNotMatch(labelFor(codex), /⌘/, 'offered a terminal tab for something with no pane')
})

test('a tab number is still what a cmux session gets', () => {
	const tabbed = { ...session('cl1', 'willow', 'needs'), tab: 4 }
	assert.match(labelFor(tabbed), /⌘4/, 'the cmux tab stopped being offered')
	assert.doesNotMatch(labelFor(tabbed), /cx /, 'labelled a Claude session as a second harness')
})

test('a label for a session with no tab and no harness gets no prefix', () => {
	// The gutter rule applied to labels: a marker on every row is noise.
	const screen = labelFor({ ...session('p1', 'orchard', 'needs'), tab: undefined })
	assert.doesNotMatch(screen, /cx /, 'labelled a Claude session as a second harness')
	assert.doesNotMatch(screen, /⌘/, 'offered a tab that does not exist')
})

test('a Codex desk is marked whether or not anything else is in the room', () => {
	// NOT gated on the room being mixed, which an earlier version was. The mark is the
	// kind of machine on the desk, which is a fact about that desk rather than a
	// comparison with its neighbours — and the gated version drew a room of nothing but
	// Codex as a room of desktop monitors.
	const alone = [{ ...session('a', 'alpha', 'working'), agent: 'codex' as const }]
	const one = room(alone)
	one.office.draw(one.cv, alone)
	assert.deepEqual(
		one.office.monitors.filter((m) => m.agent).map((m) => m.agent),
		['codex'],
		'a lone Codex session was drawn as a desktop monitor',
	)

	// And a room of only Claude Code carries no mark at all, so every existing room and
	// every doc image is untouched.
	const claudeOnly = [session('a', 'alpha', 'working'), session('b', 'alpha', 'done')]
	const two = room(claudeOnly)
	two.office.draw(two.cv, claudeOnly)
	assert.equal(two.office.monitors.filter((m) => m.agent).length, 0, 'a Claude-only room marked its desks')
})

test('the harness mark sits above the seat, where the occupant cannot cover it', () => {
	// The reported bug: "when an agent is working that is not visible". Everything on the
	// worktop is covered by whoever sits at it — office.ts records the same thing about
	// the working-light, where only ~24 pixels across five lit desks survived. So the
	// mark has to be in the monitor area, and this pins the geometry that makes that
	// safe rather than trusting it: the monitor row is strictly above the desk row, which
	// is itself above the seat.
	const list = [{ ...session('a', 'alpha', 'working'), agent: 'codex' as const }, session('b', 'alpha', 'working')]
	const { cv, office } = room(list)
	office.draw(cv, list)
	assert.equal(office.monitors.filter((m) => m.lit).length, 2, 'the fixture is not exercising working sessions')
	for (const pod of office.pods) {
		assert.ok(pod.monitorRow < pod.deskRow, 'the monitor is not above the worktop')
		assert.ok(pod.deskRow < pod.seatRow, 'the worktop is not above the seat')
	}
	// the working Codex desk still carries its mark
	assert.ok(
		office.monitors.some((m) => m.lit && m.agent === 'codex'),
		'a working Codex desk lost its mark',
	)
})

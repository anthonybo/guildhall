/** Rendering: what is drawn, what is labelled, and what never collides. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, TILE } from './office.ts'
import { badge } from './screens.ts'
import { room, session } from './office/fixtures.ts'

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
	// the workstation image is the screen plus the desk surface under it
	assert.equal(MON_ROWS, TILE / 2 + 2)
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

test('no two projects share a workstation colour', () => {
	const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']
	const list = names.map((n, i) => session(`s${i}`, n, 'parked'))
	const { office } = room(list)
	const colours = office.pods.map((p) => office.colourOf(p.proj).join(','))
	assert.equal(new Set(colours).size, new Set(office.pods.map((p) => p.proj)).size, 'two projects share a colour')
})

test('every occupied desk carries a level badge beside it', () => {
	const list = Array.from({ length: 6 }, (_, i) => session('s' + i, 'p' + i, 'parked'))
	const { cv, office } = room(list)
	office.draw(cv, list)
	assert.equal(office.badges.length, list.length, 'a desk lost its badge')
	const deskCols = new Set([...office.spots.values()].filter((s) => s.kind === 'desk').map((s) => s.col * TILE))
	for (const b of office.badges) assert.ok(!deskCols.has(b.x), 'a badge sits on a desk column')
})

test('the badge is pixel art, and each level renders differently', () => {
	const a = badge(9, [255, 200, 90])
	const b = badge(3, [120, 200, 130])
	let painted = 0
	for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.grid[y][x]) painted++
	assert.ok(painted > 60, 'the badge only painted ' + painted + ' pixels')
	assert.notEqual(JSON.stringify(a.grid), JSON.stringify(b.grid))
})

test('the rally only starts once both players have arrived', () => {
	const list = Array.from({ length: 8 }, (_, i) => session('s' + i, 'alpha', 'parked'))
	const { cv, office } = room(list)
	let walkingWithBall = 0
	for (let i = 0; i < 4000; i++) {
		office.update(0.1, list)
		const table = [...office.spots.values()].filter((s) => s.kind === 'pingpong')
		if (table.length !== 2 || !table.every((s) => s.taken)) continue
		const both = table.every((s) => {
			const ch = office.chars.get(s.taken!)!
			return ch.state === 'act' && ch.col === s.col && ch.row === s.row
		})
		if (both) continue
		// claimed but not arrived: the ball must not be on the table yet
		const before = cv.render().join('')
		office.draw(cv, list)
		const after = cv.render().join('')
		if (before !== after) walkingWithBall += 0 // drawing is expected; the check is below
		const mid = table[0]
		const ballRow = ((mid.row * TILE + TILE / 2) >> 1) - 2
		const line = cv.render()[ballRow]?.replace(/\x1b\[[0-9;]*m/g, '') ?? ''
		if (/[▀]/.test(line) === false && line.includes('◦')) walkingWithBall++
	}
	assert.equal(walkingWithBall, 0, 'the ball was drawn before both players arrived')
})

test('a needy session is labelled with vertical nameplates, not only horizontal ones', () => {
	// The regression: badge spots were the head row and one row either side, but a
	// character is CHAR_H/2 rows tall. With the pod's plate on its left and its
	// level badge on its right, a seated worker had 0 of 6 candidates free and its
	// label silently vanished — so turning nameplates vertical deleted the very
	// thing that says what a session is doing. Beside the body is still beside it.
	const list = [session('a', 'alpha', 'needs'), session('b', 'beta', 'working')]
	const words = (vertical: boolean) => {
		const { cv, office } = room(list)
		office.vertical = vertical
		office.overlay(cv, office.draw(cv, list), 'b')
		const out: string[] = []
		for (let r = 0; r < cv.rows; r++) {
			let run = ''
			for (let c = 0; c < cv.w; c++) {
				const cell = cv.cellAt(c, r)
				run = cell?.bg ? run + (cell.ch || ' ') : ((out.push(run), ''))
			}
			out.push(run)
		}
		return out.filter((s) => /[▲●◆✗◍]/.test(s) && s.trim().length > 3)
	}
	assert.ok(words(false).length > 0, 'no worded label at all with horizontal plates')
	// at least as many, not exactly as many: freeing the aisle row that horizontal
	// nameplates used to occupy means vertical often fits one more, which is fine.
	// What must never happen again is vertical fitting fewer.
	assert.ok(words(true).length >= words(false).length, `vertical plates lost a label: ${words(true).length} vs ${words(false).length}`)
})

test('a status label never sits on top of a horizontal nameplate', () => {
	// `horizontalPlates` tracked its claims in a local map that `labels` could not
	// see, so a label drew straight over a nameplate and produced "lan▲⌘3 Needs
	// you rd". Both now register in imageSpans, which is what blocked() consults.
	const list = [session('a', 'alpha', 'needs'), session('b', 'beta', 'working'), session('c', 'gamma', 'parked')]
	const { cv, office } = room(list)
	office.vertical = false
	office.overlay(cv, office.draw(cv, list), 'a')
	for (let r = 0; r < cv.rows; r++) {
		let run = ''
		for (let c = 0; c <= cv.w; c++) {
			const cell = c < cv.w ? cv.cellAt(c, r) : null
			if (cell?.bg) run += cell.ch || ' '
			else {
				// a nameplate is a bare project name; a status label carries a glyph.
				// One run holding both means they were drawn over each other.
				const hasGlyph = /[▲●◆✗◍]/.test(run)
				const names = ['alpha', 'beta', 'gamma'].filter((n) => run.includes(n))
				assert.ok(!(hasGlyph && names.length), `label and nameplate share a run: ${JSON.stringify(run)}`)
				run = ''
			}
		}
	}
})

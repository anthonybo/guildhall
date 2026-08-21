import assert from 'node:assert/strict'
import test from 'node:test'
import { header, rows, tableWidths } from './table.ts'
import type { Session, State } from './data.ts'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

const session = (proj: string, state: State = 'parked'): Session =>
	({
		id: proj,
		pid: 1,
		name: proj,
		proj,
		cwd: `/x/${proj}`,
		state,
		stale: 60_000,
		title: proj,
		doing: 'doing a thing that runs on and on and needs truncating somewhere',
		short: '',
		last: '',
		ctxUsed: 50_000,
		ctxLimit: 200_000,
		unread: false,
		toolKind: 'edit',
		turns: 10,
		level: 5,
		xp: 100,
		palette: 0,
		hueShift: 0,
	}) as Session

test('the project is never dropped, however narrow the table gets', () => {
	// it used to vanish below 84 columns, which left a row identified only by a tab
	// number: you could read what a session was doing but not which one it was
	const list = [session('foxglove'), session('brookwater')]
	for (const w of [120, 90, 84, 78, 70, 62, 50, 46]) {
		// rows() sorts, so check every row carries a recognisable name rather than
		// assuming an order
		for (const r of rows(list, w)) {
			const out = strip(r.line)
			assert.ok(/foxglo|brookw/.test(out), `identity gone at width ${w}: ${out}`)
		}
		assert.match(strip(header(w)), /PROJECT/, `header lost PROJECT at width ${w}`)
	}
})

test('the context gauge is what yields when space runs out, not identity', () => {
	assert.equal(tableWidths(120).showCtx, true)
	assert.equal(tableWidths(50).showCtx, false)
	assert.ok(tableWidths(50).proj > 0, 'project column was starved to nothing')
})

test('each project is tinted with the colour it has in the room', () => {
	// the table and the office are one view: a character you spot upstairs has a row
	// down here in the same hue, so finding it is a colour match not a read
	const list = [session('alpha'), session('beta')]
	const colours: Record<string, [number, number, number]> = { alpha: [1, 2, 3], beta: [9, 8, 7] }
	const out = rows(list, 120, undefined, (p) => colours[p])
	assert.match(out[0].line, /38;2;1;2;3/, 'project not tinted with its room colour')
	assert.match(out[1].line, /38;2;9;8;7/)
})

test('every row is exactly the requested width', () => {
	const list = [session('alpha'), session('beta', 'working')]
	for (const w of [120, 84, 70, 52]) {
		for (const r of rows(list, w)) {
			assert.ok(strip(r.line).length <= w, `row overflowed ${w}: ${strip(r.line).length}`)
		}
	}
})

test('both harnesses get a mark, so neither is identified by absence', () => {
	// The first version marked only Codex and left Claude Code blank, which is not a
	// distinction anybody can read: you cannot tell "this is Claude" from "this column
	// means nothing on this row". Two Claude sessions and a Codex session in one project
	// was the case that showed it.
	// Rendered TOGETHER, which is the case that matters: two Claude sessions and a Codex
	// session in one project. The column only appears when the list holds more than one
	// harness, because a glyph identical on every row is a column of decoration.
	const list: Session[] = [
		{ ...session('orchard'), id: 'a' } as Session,
		{ ...session('orchard'), id: 'b' } as Session,
		{ ...session('orchard'), id: 'c', agent: 'codex' } as Session,
	]
	const lines = rows(list, 120).map((r) => strip(r.line))
	const codexLines = lines.filter((l) => l.includes('◆'))
	const claudeLines = lines.filter((l) => l.includes('✳'))
	assert.equal(claudeLines.length, 2, 'the Claude Code rows are not marked')
	assert.equal(codexLines.length, 1, 'the Codex row is not marked')
})

test('the harness column is absent when every session is the same harness', () => {
	// Which is everybody who does not run Codex. A column of identical glyphs conveys
	// nothing and costs a character of the project name.
	const only = [session('orchard'), session('willow')]
	for (const l of rows(only, 120).map((r) => strip(r.line))) {
		assert.doesNotMatch(l, /[✳◆]/, 'a single-harness list still spends a column on it')
	}
	assert.doesNotMatch(strip(header(120)), /[✳◆]/)
})

test('the tab column is about tabs again', () => {
	// It briefly did double duty, showing `cx` where a tab number would go. That
	// conflated "how do I reach this" with "what is it", and the harness has its own
	// column now.
	const withTab = { ...session('orchard'), tab: 3 } as Session
	const noTab = session('willow')
	const codex = { ...session('kestrel'), agent: 'codex' } as Session
	const line = (x: Session) => strip(rows([x], 120)[0]!.line)
	assert.match(line(withTab), /⌘3/)
	assert.match(line(noTab), /·/)
	assert.doesNotMatch(line(codex), /⌘/, 'offered a terminal tab for something with no pane')
	assert.doesNotMatch(line(codex), /\bcx\b/, 'the old marker is still in the tab column')
})

test('every row is the requested width, whichever harness it is', () => {
	// A glyph that measures wider than one cell would shift every column after it on
	// that row only, which is the worst kind of layout bug: it looks like a data error.
	const cases: Session[] = [
		{ ...session('a'), tab: 9 } as Session,
		session('b'),
		{ ...session('c'), agent: 'codex' } as Session,
	]
	// One render of the whole list: widths are only comparable within a single table,
	// since the harness column appears per-list rather than per-row.
	const widths = new Set(rows(cases, 120).map((r) => strip(r.line).length))
	assert.equal(widths.size, 1, `rows came out different lengths: ${[...widths].join(', ')}`)
})

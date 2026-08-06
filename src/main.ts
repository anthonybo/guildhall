#!/usr/bin/env node
/**
 * guildhall — every live Claude Code session as a pixel town, in a terminal.
 *
 * Read-only. It watches the sessions you already run (in cmux or anywhere else)
 * and never launches or modifies one. The only thing it writes is a cmux
 * "focus this tab" request, and only when you press enter.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadSprite } from './png.ts'
import {
	clearAll,
	clearPlacements,
	cursorTo,
	encodePNG,
	place,
	supportsImages,
	SYNC_END,
	SYNC_START,
	transmit,
	upscale,
} from './kitty.ts'
import { collect, needsAttention, order, type Session } from './data.ts'
import { Canvas, Town, type Placement } from './town.ts'
import * as T from './table.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TILES = path.join(ROOT, 'assets/tiny-creatures/Tiles')
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const ONCE = process.argv.includes('--once')
const BENCH = process.argv.includes('--bench')
const IMAGES = supportsImages() && !ONCE && !BENCH

const creatures: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/creatures.json'), 'utf8'))

/* ── sprites: transmit each creature once, then place it by id every frame ── */
const imageIds = new Map<string, number>()
let nextId = 1000
function ensureTransmitted(tile: string, pre: string[]) {
	const known = imageIds.get(tile)
	if (known) return known
	const sp = loadSprite(path.join(TILES, tile), 0)
	// nearest-neighbour 8x so the terminal has real pixels to draw with
	const up = upscale(sp.grid, 8)
	const id = nextId++
	imageIds.set(tile, id)
	pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
	return id
}

/* ── screen ── */
const OUT = process.stdout
let prev: string[] = []
let alt = false
let quiet = false // --bench exercises the frame path without writing to the screen

function paint(lines: string[], images: string) {
	if (quiet) {
		prev = lines
		return
	}
	let buf = SYNC_START
	if (images) buf += clearPlacements()
	for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) buf += `${cursorTo(i + 1, 1)}\x1b[2K${lines[i]}`
	prev = lines
	buf += images + SYNC_END
	OUT.write(buf)
}

function jump(tab: number) {
	try {
		spawn(CMUX, ['select-workspace', '--workspace', String(tab)], { stdio: 'ignore', detached: true }).unref()
	} catch {}
}

/* ── state ── */
type Mode = 'town' | 'split' | 'table'
let mode: Mode = 'split'
let faultsOnly = false
let selectedId: string | null = null
let sessions: Session[] = []
let timers: NodeJS.Timeout[] = []

// The town owns the creatures' positions, so it is created once and resized —
// never rebuilt — or every creature would jump back to its start position.
const town = new Town(80, 40)
let cv = new Canvas(80, 40)
let geom = { cols: 0, rows: 0, townRows: 0, tableRows: 0 }

const visible = () => (faultsOnly ? sessions.filter((s) => needsAttention(s)) : sessions)

function moveSelection(delta: number) {
	const list = order(visible())
	if (!list.length) return
	const at = list.findIndex((s) => s.id === selectedId)
	const i = at < 0 ? 0 : at
	// hold the session, not the row index: rows can move, the session you were
	// reading does not
	selectedId = list[Math.min(list.length - 1, Math.max(0, i + delta))].id
}

/** Recompute geometry and re-place creatures. Safe to call as often as you like. */
function layout() {
	const cols = Math.max(46, (OUT.columns ?? 90) - 1)
	const rows = Math.max(14, (OUT.rows ?? 44) - 2)
	const list = visible()
	if (!selectedId || !list.some((s) => s.id === selectedId)) selectedId = order(list)[0]?.id ?? null

	// the town is the hero, so the table is capped at roughly a third and the
	// town keeps the rest; press tab for a full-screen table when you want detail
	const wantTable = Math.min(list.length + 4, Math.max(6, Math.floor(rows * 0.34)))
	const tableRows = mode === 'town' ? 0 : mode === 'table' ? rows : wantTable
	const townRows = rows - tableRows

	if (cols !== geom.cols || townRows !== geom.townRows) {
		cv = new Canvas(cols, Math.max(2, townRows) * 2)
		town.resize(cols, Math.max(2, townRows) * 2)
	}
	geom = { cols, rows, townRows, tableRows }
	town.layout(list)
}

/** Render the current state. Draws only — advancing the animation is separate. */
function draw() {
	const { cols, rows, townRows, tableRows } = geom
	const list = visible()
	let townLines: string[] = []
	let images = ''
	if (townRows > 0) {
		const placements = town.draw(cv)
		if (!IMAGES) for (const p of placements) cv.blit(p.x, p.y, loadSprite(path.join(TILES, p.tile), town.spriteH))
		town.overlay(cv, placements, selectedId ?? undefined)
		townLines = cv.render()
		if (IMAGES) images = drawImages(placements, town.spriteH)
	}

	const body: string[] = [...townLines]
	if (tableRows > 0) {
		const rowsOut = T.rows(list, cols, selectedId ?? undefined)
		const sel = rowsOut.find((r) => r.s.id === selectedId)?.s
		const det = T.detail(sel, cols)
		body.push(T.header(cols))
		for (const r of rowsOut.slice(0, Math.max(0, tableRows - 3))) body.push(r.line)
		while (body.length < townRows + tableRows - 2) body.push('')
		body.push(...det)
	}
	while (body.length < rows) body.push('')
	paint([T.summary(sessions, cols), ...body.slice(0, rows), T.footer(cols, town.hiddenLots, faultsOnly, mode)], images)
}

/** One animation step, then redraw. Only the animation timer calls this. */
function animate() {
	town.tick()
	draw()
}

function drawImages(placements: Placement[], spriteH: number) {
	const pre: string[] = []
	let out = ''
	let pid = 1
	for (const p of placements) {
		const id = ensureTransmitted(p.tile, pre)
		const sp = loadSprite(path.join(TILES, p.tile), 0)
		// one canvas pixel is one column and half a row, so the footprint matches
		// the half-block fallback exactly while the image is drawn at font resolution
		const cols = Math.round((sp.w / sp.h) * spriteH)
		const rows = Math.ceil(spriteH / 2)
		out += cursorTo((p.y >> 1) + 2, p.x + 1) + place(id, cols, rows, pid++)
	}
	return pre.join('') + out
}

function cleanup() {
	if (alt) OUT.write(clearAll() + '\x1b[?25h\x1b[?1049l')
	process.exit(0)
}

function onKey(b: Buffer) {
	const k = b.toString()
	if (k === 'q' || k === '\x03') return cleanup()
	if (k === '\x1b[A') moveSelection(-1)
	else if (k === '\x1b[B') moveSelection(1)
	else if (k === '\r' || k === '\n') {
		const s = sessions.find((x) => x.id === selectedId)
		if (s?.tab) jump(s.tab)
	} else if (k === '\t') {
		mode = mode === 'split' ? 'town' : mode === 'town' ? 'table' : 'split'
		prev = []
		OUT.write('\x1b[2J')
		layout()
	} else if (k === 'f') {
		faultsOnly = !faultsOnly
		layout()
	} else if (/^[0-9]$/.test(k)) jump(k === '0' ? 10 : Number(k))
	// keys only ever redraw; they must not advance the animation or the creatures
	// lurch forward once per keystroke
	draw()
}

function start() {
	for (const t of timers) clearInterval(t)
	timers = []
	prev = []
	OUT.write('\x1b[2J')
	layout()
	draw()
	timers.push(setInterval(animate, 110))
	timers.push(
		setInterval(() => {
			sessions = collect(creatures)
			layout()
			draw()
		}, 2000),
	)
}

function main() {
	sessions = collect(creatures)
	if (!sessions.length) {
		console.log('no live claude sessions found')
		process.exit(0)
	}
	if (BENCH) {
		quiet = true
		layout()
		const N = 200
		const t0 = process.cpuUsage()
		for (let i = 0; i < N; i++) animate()
		const u = process.cpuUsage(t0)
		const ms = (u.user + u.system) / 1000 / N
		process.stderr.write(`${ms.toFixed(2)} ms/frame · ${((ms * 9) / 10).toFixed(2)}% of one core at 9fps\n`)
		return
	}
	if (ONCE) {
		layout()
		draw()
		OUT.write('\n')
		return
	}
	alt = true
	OUT.write('\x1b[?1049h\x1b[?25l\x1b[2J')
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		process.stdin.on('data', onKey)
	}
	process.on('SIGINT', cleanup)
	process.on('SIGTERM', cleanup)
	OUT.on('resize', start)
	start()
}

main()

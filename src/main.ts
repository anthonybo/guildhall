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
import { Canvas } from './canvas.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, Office, TILE, type Placed } from './office.ts'
import { frameOf, loadSheets, shrink } from './characters.ts'
import { monitor } from './screens.ts'
import { PROP_SIZE, prop } from './props.ts'
import * as T from './table.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const ONCE = process.argv.includes('--once')
const BENCH = process.argv.includes('--bench')
const IMAGES = supportsImages() && !ONCE && !BENCH


/* ── sprites: transmit each creature once, then place it by id every frame ── */
const imageIds = new Map<string, number>()
let nextId = 1000
function ensureTransmitted(p: Placed, pre: string[]) {
	const key = `${p.s.palette}:${p.s.hueShift}:${p.facing}:${p.pose}:${p.step}`
	const known = imageIds.get(key)
	if (known) return known
	const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step)
	// nearest-neighbour 4x so the terminal has real pixels to scale from
	// 2x, not 4x: a 4x source made the terminal DOWNSCALE into the placement box,
	// which is a fractional resample and the reason sprites looked mushy
	const up = upscale(g.grid, 2)
	const id = nextId++
	imageIds.set(key, id)
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
/** All labels on, or only the ones that need you plus the selection. */
let labels = true
let selectedId: string | null = null
let sessions: Session[] = []
let timers: NodeJS.Timeout[] = []

// The office owns the characters' positions, so it is created once and refitted
// — never rebuilt — or everyone would jump back to the doorway.
const office = new Office()
let cv = new Canvas(80, 40)
let geom = { cols: 0, rows: 0, townRows: 0, tableRows: 0 }
let lastTick = 0
let screenFrame = 0
let screenClock = 0
/** A stalled event loop must not teleport anyone across the room. */
const MAX_DT = 0.25

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
		office.fit(cv.w, cv.h, list)
	}
	geom = { cols, rows, townRows, tableRows }
	office.assign(list)
}

/** Render the current state. Draws only — advancing the animation is separate. */
function draw() {
	const { cols, rows, townRows, tableRows } = geom
	const list = visible()
	let townLines: string[] = []
	let images = ''
	if (townRows > 0) {
		const placed = office.draw(cv, list)
		if (!IMAGES)
			for (const p of placed) {
				const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step)
				cv.blit(p.x, p.y, shrink(g, CHAR_W, CHAR_H))
			}
		office.overlay(cv, placed, selectedId ?? undefined, labels)
		townLines = cv.render()
		// furniture first, then monitors, then people on top of both
		if (IMAGES) images = drawProps() + drawMonitors() + drawImages(placed)
		else {
			for (const pr of office.props) {
				const size = PROP_SIZE[pr.kind]
				cv.blit(pr.x, pr.y, shrink(prop(pr.kind), size.w * TILE, size.h * TILE))
			}
			for (const m of office.monitors) cv.blit(m.x, m.y, shrink(monitor(m.lit, screenFrame, m.seed), CHAR_W, CHAR_W))
		}
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
	paint([T.summary(sessions, cols), ...body.slice(0, rows), T.footer(cols, office.hiddenCount, faultsOnly, mode)], images)
}

/** One simulation step, then redraw. Only the animation timer calls this. */
function animate() {
	const now = Date.now()
	const dt = lastTick ? Math.min((now - lastTick) / 1000, MAX_DT) : 0
	lastTick = now
	office.update(dt, visible())
	screenClock += dt
	if (screenClock > 0.45) {
		screenClock = 0
		screenFrame++
	}
	draw()
}

/**
 * Place each worker as a real image. The footprint is the world-scale one — one
 * tile wide, two tall — but the terminal draws it at font resolution, so the
 * sprite is far more detailed than the canvas grid it occupies.
 */
function drawImages(placements: Placed[]) {
	const pre: string[] = []
	let out = ''
	let pid = 1
	const cols = CHAR_W
	const rows = CHAR_H / 2
	for (const p of placements) {
		const id = ensureTransmitted(p, pre)
		out += cursorTo((p.y >> 1) + 2, p.x + 1) + place(id, cols, rows, pid++)
	}
	return pre.join('') + out
}

/** Static furniture. Sent once per kind and then only re-placed each frame. */
function drawProps() {
	const pre: string[] = []
	let out = ''
	let pid = 200
	for (const pr of office.props) {
		const key = `prop:${pr.kind}`
		let id = imageIds.get(key)
		if (!id) {
			id = nextId++
			imageIds.set(key, id)
			const up = upscale(prop(pr.kind).grid, 2)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		const size = PROP_SIZE[pr.kind]
		out += cursorTo((pr.y >> 1) + 2, pr.x + 1) + place(id, size.w * TILE, (size.h * TILE) / 2, pid++)
	}
	return pre.join('') + out
}

/** Monitors sit on the desk row, which no character overlaps, so no z conflict. */
function drawMonitors() {
	const pre: string[] = []
	let out = ''
	let pid = 500
	for (const m of office.monitors) {
		const key = `mon:${m.lit ? 'on' : 'off'}:${m.lit ? screenFrame % 4 : 0}:${m.seed % 8}`
		let id = imageIds.get(key)
		if (!id) {
			id = nextId++
			imageIds.set(key, id)
			const up = upscale(monitor(m.lit, screenFrame, m.seed).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((m.y >> 1) + 2, m.x + 1) + place(id, MON_COLS, MON_ROWS, pid++)
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
	} else if (k === 'l') {
		labels = !labels
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
			sessions = collect()
			layout()
			draw()
		}, 2000),
	)
}

function main() {
	sessions = collect()
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
	// A resize makes the terminal drop the images it is holding, so every id we
	// cached is stale and re-placing them renders nothing. Tear the whole image
	// layer down, forget the ids, and rebuild. Debounced because a drag fires
	// this dozens of times.
	let resizeTimer: NodeJS.Timeout | null = null
	OUT.on('resize', () => {
		if (resizeTimer) clearTimeout(resizeTimer)
		resizeTimer = setTimeout(() => {
			resizeTimer = null
			OUT.write(clearAll())
			imageIds.clear()
			prev = []
			OUT.write('\x1b[2J')
			start()
		}, 80)
	})
	start()
}

main()

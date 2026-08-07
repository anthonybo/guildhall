/**
 * The browser client.
 *
 * It runs the same office the terminal does — same planner, same seating rules,
 * same behaviour — against a JSON feed of sessions. Only the drawing differs: a
 * canvas instead of half blocks and kitty images. That is possible because the
 * simulation has no node dependencies, so nothing here is a reimplementation
 * that can drift from the original.
 *
 * The room needs width to be legible, so below 720px it is hidden and the list
 * carries everything. A phone is asking "what is the status", not "show me the
 * furniture".
 */
import { Canvas } from '../src/canvas.ts'
import { Office } from '../src/office.ts'
import { setSheets } from '../src/characters.ts'
import { renderRoom } from '../src/render.ts'
import { LOOK, projectColours, tierOf } from '../src/theme.ts'
import { needsAttention, order } from '../src/data/select.ts'
import type { Session } from '../src/data/types.ts'
import type { Image } from '../src/png.ts'

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T
const rgb = (c: readonly number[]) => `rgb(${c[0]} ${c[1]} ${c[2]})`

const bar = { counts: $<HTMLElement>('#counts'), link: $<HTMLElement>('#link') }
const listEl = $<HTMLUListElement>('#list')
const emptyEl = $<HTMLElement>('#empty')
const roomEl = $<HTMLElement>('#room')
const canvas = $<HTMLCanvasElement>('#canvas')
const stampEl = $<HTMLElement>('#stamp')
const ctx2d = canvas.getContext('2d')!

let sessions: Session[] = []
let office: Office | null = null
let cv: Canvas | null = null
let sheetsReady = false

/* ── sprites: the same PNGs, decoded by the browser ── */

async function loadSheets() {
	const imgs: Image[] = []
	for (let i = 0; i < 6; i++) {
		const bitmap = await createImageBitmap(await (await fetch(`/characters/char_${i}.png`)).blob())
		const off = new OffscreenCanvas(bitmap.width, bitmap.height)
		const c = off.getContext('2d')!
		c.drawImage(bitmap, 0, 0)
		const d = c.getImageData(0, 0, bitmap.width, bitmap.height)
		imgs.push({ w: bitmap.width, h: bitmap.height, rgba: new Uint8ClampedArray(d.data) })
	}
	setSheets(imgs)
	sheetsReady = true
}

/* ── the room ── */

/**
 * How big the office should be.
 *
 * Height comes from the population, not from the width. A fixed aspect gave a
 * room mostly made of empty floor and pushed the table off the bottom of the
 * screen — the room is the picture, but the list is the answer, and burying the
 * answer under three screens of carpet is the wrong trade.
 *
 * Bands are four rows: desks take one per few projects, and two more carry the
 * kitchen, couches and ping-pong that the idle characters walk to.
 */
function roomSize(n: number) {
	const cssW = roomEl.clientWidth || 900
	const cols = Math.max(48, Math.min(104, Math.floor(cssW / 10)))
	// Count in TILE rows, then double. `fit` takes canvas pixels and divides by
	// TILE, and a canvas is two pixels per terminal row — so asking for 26 rows
	// quietly bought 13 bands' worth of floor and left none for the facilities.
	const perBand = Math.max(1, Math.floor((cols - 6) / 8))
	const bands = Math.ceil(n / perBand) + 2 // +2 for kitchen, couches, ping-pong
	// 24 is the floor: below it the social bands land inside the work zone and get
	// filtered out, leaving a room with desks and nothing else in it
	const tileRows = Math.max(24, Math.min(34, bands * 4 + 12))
	return { cols, rows: tileRows * 2 }
}

function ensureOffice(list: Session[]) {
	const { cols, rows } = roomSize(list.length)
	if (!cv || cv.w !== cols || cv.rows !== rows) {
		cv = new Canvas(cols, rows * 2)
		office ??= new Office()
		office.fit(cv.w, cv.h, list)
	}
	office!.assign(list)
	return office!
}

let last = performance.now()
let screenClock = 0
let screenFrame = 0

function frame(now: number) {
	requestAnimationFrame(frame)
	const dt = Math.min((now - last) / 1000, 0.25)
	last = now
	if (!sheetsReady || roomEl.hidden || !sessions.length) return

	const off = ensureOffice(sessions)
	off.update(dt, sessions)
	screenClock += dt
	if (screenClock > 0.45) {
		screenClock = 0
		screenFrame++
	}

	const placed = off.draw(cv!, sessions)
	off.overlay(cv!, placed, undefined, true)

	// 4 and 8 put a 16x32 sprite on screen unresampled; the canvas is then scaled
	// up by CSS with image-rendering: pixelated, which keeps every edge hard
	const { rgba, w, h } = renderRoom(cv!, off, placed, 4, 8, screenFrame)
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w
		canvas.height = h
	}
	ctx2d.putImageData(new ImageData(rgba, w, h), 0, 0)
	drawLabels(off)
}

/** Nameplates and status labels live in the canvas text layer, not the pixels. */
function drawLabels(off: Office) {
	const cw = canvas.width / cv!.w
	const ch = canvas.height / cv!.rows
	ctx2d.font = `${Math.round(ch * 0.8)}px ui-monospace, Menlo, monospace`
	ctx2d.textBaseline = 'middle'
	for (let r = 0; r < cv!.rows; r++) {
		for (let c = 0; c < cv!.w; c++) {
			const cell = cv!.cellAt(c, r)
			if (!cell) continue
			if (cell.bg) {
				ctx2d.fillStyle = rgb(cell.bg)
				ctx2d.fillRect(c * cw, r * ch, cw, ch)
			}
			if (cell.ch.trim()) {
				ctx2d.fillStyle = rgb(cell.fg ?? [220, 220, 220])
				ctx2d.fillText(cell.ch, c * cw, r * ch + ch / 2)
			}
		}
	}
	void off
}

/* ── the list ── */

const ago = (ms: number) => {
	const m = Math.round(ms / 60000)
	if (m < 1) return 'now'
	if (m < 60) return `${m}m`
	const h = Math.round(m / 60)
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

function paintList(list: Session[]) {
	const sorted = order(list)
	// the same assignment the room makes, so a name here and its carpet upstairs
	// are the same colour
	const hues = projectColours(list.map((s) => s.proj))
	emptyEl.hidden = sorted.length > 0
	listEl.replaceChildren(
		...sorted.map((s) => {
			const look = LOOK[s.state]
			const li = document.createElement('li')
			li.className = 'row' + (needsAttention(s) ? ' attn' : '')
			li.style.setProperty('--state', rgb(look.color))
			li.style.setProperty('--tier', rgb(tierOf(s.level).color))
			// the project's own colour, the same hue as its carpet in the room
			li.style.setProperty('--proj', rgb(hues.get(s.proj) ?? look.color))
			const pct = s.ctxLimit ? Math.round((s.ctxUsed / s.ctxLimit) * 100) : 0
			li.innerHTML = `
				<span class="lv">${s.level}</span>
				<span class="proj"></span>
				<span class="meta">
					<span class="state">${look.glyph} ${look.label}</span>
					${s.ctxUsed ? `<span class="ctx${pct > 90 ? ' hot' : ''}">${pct}%</span>` : ''}
					<span>${ago(s.stale)}</span>
				</span>
				<span class="doing"></span>`
			// textContent, never innerHTML: this is a session's own prose and file
			// names, and it must never be able to become markup
			li.querySelector('.proj')!.textContent = s.proj
			li.querySelector('.doing')!.textContent = s.doing || s.last || '—'
			return li
		}),
	)
}

function paintCounts(list: Session[]) {
	const counts: Record<string, number> = {}
	for (const s of list) counts[s.state] = (counts[s.state] ?? 0) + 1
	bar.counts.replaceChildren(
		...(['error', 'needs', 'working', 'shell', 'review', 'done', 'parked'] as const)
			.filter((k) => counts[k])
			.map((k) => {
				const el = document.createElement('span')
				el.style.color = rgb(LOOK[k].color)
				el.textContent = `${LOOK[k].glyph} `
				const n = document.createElement('b')
				n.textContent = `${counts[k]} ${LOOK[k].label}`
				el.append(n)
				return el
			}),
	)
}

function apply(data: { sessions: Session[]; at: number }) {
	sessions = data.sessions
	roomEl.hidden = window.innerWidth <= 720 || sessions.length === 0
	paintCounts(sessions)
	paintList(sessions)
	stampEl.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · updated ${new Date(data.at).toLocaleTimeString()}`
}

/* ── the feed ── */

function connect() {
	const es = new EventSource('/api/stream')
	es.onopen = () => {
		bar.link.className = 'link live'
		bar.link.textContent = 'live'
	}
	es.onmessage = (e) => apply(JSON.parse(e.data))
	es.onerror = () => {
		bar.link.className = 'link down'
		bar.link.textContent = 'reconnecting'
		// EventSource retries on its own; this only reports it
	}
}

addEventListener('resize', () => {
	roomEl.hidden = window.innerWidth <= 720 || sessions.length === 0
	cv = null // force a re-fit at the new width
})

loadSheets().catch(() => {
	// no sprites: the list still works, which is the part that matters
	sheetsReady = false
})
connect()
requestAnimationFrame(frame)

/**
 * The office, drawn on a canvas.
 *
 * It runs the same simulation the terminal does — same planner, same seating
 * rules, same behaviour — because the simulation has no node dependencies.
 * Only the drawing differs: a canvas instead of half blocks and kitty images,
 * so nothing here is a reimplementation that can drift from the original.
 *
 * The room needs width to be legible, so below 720px the caller hides it and
 * the list carries everything. A phone is asking "what is the status", not
 * "show me the furniture".
 */
import { Canvas } from '../src/canvas.ts'
import { Office } from '../src/office.ts'
import { setSheets } from '../src/characters.ts'
import { renderRoom } from '../src/render.ts'
import { PLATE_COLS, PLATE_ROWS } from '../src/office/model.ts'
import { MIN_CHARS } from '../src/nameplate.ts'
import type { Session } from '../src/data/types.ts'
import type { Image } from '../src/png.ts'
import { rgb } from './dom.ts'
import { settings } from './settings.ts'

let roomEl: HTMLElement
let canvas: HTMLCanvasElement
let ctx2d: CanvasRenderingContext2D
/** The room at its native pixel size, before being blown up onto the display. */
let buffer: HTMLCanvasElement
let bufferCtx: CanvasRenderingContext2D

let sessions: Session[] = []
let office: Office | null = null
let cv: Canvas | null = null
let sheetsReady = false
let settled = false

/** The feed's latest, which the frame loop reads rather than being pushed to. */
export const setRoomSessions = (list: Session[]) => (sessions = list)
/** Force a re-plan — the width changed, or the label mode did. */
export const relayout = () => (cv = null)

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
	// Once, on the first paint. Otherwise a browser resize would teleport everyone
	// mid-stride, and the room is on screen while it happens here.
	if (!settled && list.length) {
		settled = true
		office!.settle(list)
	}
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

	off.vertical = settings.labels === 'vertical'
	const placed = off.draw(cv!, sessions)
	off.overlay(cv!, placed, undefined, true)

	// The room is pixel art and must be scaled by whole pixels with no smoothing.
	// The nameplates are TEXT, and drawing them into that small buffer meant they
	// were stretched along with it — which is why they were unreadable. So the
	// pixels go through an offscreen buffer blown up with smoothing off, and the
	// text is drawn afterwards at the display's own resolution.
	//
	// `plates: []` for the same reason. The terminal has to draw a vertical plate
	// as a rotated bitmap because a terminal cannot rotate text, and at 4px per
	// column that bitmap would hold six characters. A canvas has real fonts and
	// rotate(), so the plates are drawn below at display resolution instead.
	const scene = { props: off.props, monitors: off.monitors, badges: off.badges, plates: [] }
	const { rgba, w, h } = renderRoom(cv!, scene, placed, 4, 8, screenFrame)
	if (buffer.width !== w || buffer.height !== h) {
		buffer.width = w
		buffer.height = h
	}
	bufferCtx.putImageData(new ImageData(rgba, w, h), 0, 0)

	const dpr = Math.min(3, window.devicePixelRatio || 1)
	const cssW = roomEl.clientWidth
	const cssH = Math.round((cssW * h) / w)
	const pxW = Math.round(cssW * dpr)
	const pxH = Math.round(cssH * dpr)
	if (canvas.width !== pxW || canvas.height !== pxH) {
		canvas.width = pxW
		canvas.height = pxH
		canvas.style.height = `${cssH}px`
	}
	ctx2d.imageSmoothingEnabled = false
	ctx2d.drawImage(buffer, 0, 0, pxW, pxH)
	drawLabels(pxW, pxH)
}

/**
 * Vertical nameplates: a coloured bar with the project turned on its side.
 *
 * Bottom-to-top, following Imhof's rule for labelling vertical features on maps,
 * and the same direction the terminal uses — the two views have to agree about
 * which way a name reads even though they draw it by completely different means.
 *
 * The size is shared, not solved per name. Letting each plate take the largest
 * size its own name allowed put a huge `willow` beside a tiny
 * `brightwater-sync`, which reads as emphasis the room does not mean. So one
 * floor is set from MIN_CHARS — the same length the terminal guarantees — and a
 * short name may grow a third above it, which is the browser's equivalent of the
 * terminal's one-scale-step. Anything longer is truncated with a real ellipsis;
 * the terminal makes do with '.' only because its pixel font has no such glyph.
 */
function drawPlates(pxW: number, pxH: number) {
	const cw = pxW / cv!.w
	const ch = pxH / cv!.rows
	// set here rather than inherited from drawLabels, which sets them after this
	// runs — on the first frame of all they would still be the context defaults
	ctx2d.textBaseline = 'middle'
	ctx2d.textAlign = 'center'
	const w = PLATE_COLS * cw
	const h = PLATE_ROWS * ch
	const font = (px: number) => `${px}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
	// 0.62 is the advance-to-size ratio of that stack; 0.66 of the bar's width
	// leaves the keyline of colour that makes it read as a plate, not as a stripe.
	const fits = (chars: number) => Math.min(w * 0.66, (h * 0.94) / (chars * 0.62))
	const floor = fits(MIN_CHARS)

	for (const p of office!.plates) {
		// plate y is in canvas pixels, and a canvas pixel is half a row tall
		const x0 = p.x * cw
		const y0 = (p.y / 2) * ch
		ctx2d.fillStyle = rgb(p.colour)
		ctx2d.fillRect(Math.floor(x0), Math.floor(y0), Math.ceil(w), Math.ceil(h))

		const size = Math.max(9, Math.floor(Math.min(fits(p.proj.length), floor * (4 / 3))))
		ctx2d.font = font(Math.max(size, Math.floor(floor)))
		let text = p.proj
		while (text.length > 1 && ctx2d.measureText(text).width > h * 0.94) text = text.slice(0, -2) + '…'
		ctx2d.save()
		ctx2d.translate(x0 + w / 2, y0 + h / 2)
		ctx2d.rotate(-Math.PI / 2)
		ctx2d.fillStyle = '#20222e'
		ctx2d.fillText(text, 0, 0)
		ctx2d.restore()
	}
}

/**
 * Nameplates and status labels, drawn as real glyphs at full resolution.
 *
 * They live in the canvas text layer rather than in the pixel buffer, which is
 * what makes this possible — flattened into 4-pixel-wide cells and then stretched
 * they were a smear, and the room's one job is telling you which desk is whose.
 */
function drawLabels(pxW: number, pxH: number) {
	if (office!.vertical) drawPlates(pxW, pxH)
	const cw = pxW / cv!.w
	const ch = pxH / cv!.rows
	// a hair under the cell so descenders do not clip, and never below legibility
	ctx2d.font = `${Math.max(9, Math.round(ch * 0.82))}px ui-monospace, SFMono-Regular, Menlo, monospace`
	ctx2d.textBaseline = 'middle'
	ctx2d.textAlign = 'center'
	for (let r = 0; r < cv!.rows; r++) {
		for (let c = 0; c < cv!.w; c++) {
			const cell = cv!.cellAt(c, r)
			if (!cell) continue
			if (cell.bg) {
				ctx2d.fillStyle = rgb(cell.bg)
				ctx2d.fillRect(Math.floor(c * cw), Math.floor(r * ch), Math.ceil(cw), Math.ceil(ch))
			}
			if (cell.ch.trim()) {
				ctx2d.fillStyle = rgb(cell.fg ?? [220, 220, 220])
				ctx2d.fillText(cell.ch, c * cw + cw / 2, r * ch + ch / 2)
			}
		}
	}
}

/** Wire the room to its elements and start the frame loop. */
export function mountRoom(room: HTMLElement, el: HTMLCanvasElement) {
	roomEl = room
	canvas = el
	ctx2d = canvas.getContext('2d')!
	buffer = document.createElement('canvas')
	bufferCtx = buffer.getContext('2d')!
	loadSheets().catch(() => {
		// no sprites: the list still works, which is the part that matters
		sheetsReady = false
	})
	requestAnimationFrame(frame)
}

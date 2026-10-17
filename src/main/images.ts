/**
 * The image layer: every sprite, prop, plate, monitor and desk screen, transmitted to
 * the terminal once by a stable id and then only re-placed each frame.
 */
import { DEFAULT_CELL, cursorTo, encodePNG, place, transmit, upscale } from '../kitty.ts'
import type { Session } from '../data.ts'
import { screenFits, screenImage } from '../deskscreen.ts'
import { glance } from '../peek.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, TILE, type Placed } from '../office.ts'
import { frameOf } from '../characters.ts'
import { badgeFor, badgeKey, harnessColor, monitorFor, monitorKey } from '../screens.ts'
import { logo, logoKey } from '../logos.ts'
import { C, LOOK, tierOf } from '../theme.ts'
import { PROP_SIZE, prop } from '../props.ts'
import { choose, plate } from '../nameplate.ts'
import { PLATE_COLS, PLATE_ROWS } from '../office/model.ts'
import { office, screenFrame } from './state.ts'

// the tier/needs colours a badge takes, passed in so screens.ts stays theme-free
export const LEVEL_LOOK = { needs: LOOK.needs.color, tierOf: (n: number) => tierOf(n).color }

/* ── sprites: transmit each creature once, then place it by id every frame ── */
export const imageIds = new Map<string, number>()
/** ids we have already sent the pixels for. Cleared to force a re-transmit; the
 *  id itself never changes, so the terminal replaces an image rather than
 *  accumulating thousands and evicting the ones still in use. */
export const sent = new Set<number>()
let nextId = 1000

/** One placement per frame goes out un-silenced so the terminal can report a
 *  missing image. It has to be whichever is drawn first, not a particular class:
 *  hanging it off the first monitor meant no sentinel at all in a room with none. */
/** Real pixels per cell, as reported by the terminal. Plates are authored at
 *  exactly this size: kitty and Ghostty bilinear-filter images, so anything
 *  bigger gets averaged on the way down and 1px stems wash out to grey. */
export let cell = { ...DEFAULT_CELL }
export function setCell(size: typeof cell) {
	cell = size
}

let sentinelUsed = false
/** Called at the top of every frame, so that frame's first placement is the loud one. */
export function resetSentinel() {
	sentinelUsed = false
}
const loudOnce = () => (sentinelUsed ? false : ((sentinelUsed = true), true))

/** Get this key's stable id, and whether its pixels still need sending. */
function idFor(key: string) {
	let id = imageIds.get(key)
	if (!id) {
		id = nextId++
		imageIds.set(key, id)
	}
	const fresh = !sent.has(id)
	sent.add(id)
	return { id, fresh }
}
function ensureTransmitted(p: Placed, pre: string[]) {
	const key = `${p.s.palette}:${p.s.hueShift}:${p.facing}:${p.pose}:${p.step}:${p.s.level}`
	// via idFor, so a cleared `sent` re-sends the pixels. Returning early on a known
	// id meant characters were transmitted exactly once per process: when the
	// terminal dropped its image store, furniture healed on the next sweep and the
	// sprites stayed dangling ids forever, which is the bug you kept seeing.
	const { id, fresh } = idFor(key)
	if (!fresh) return id
	const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color)
	// nearest-neighbour 4x so the terminal has real pixels to scale from
	// 2x, not 4x: a 4x source made the terminal DOWNSCALE into the placement box,
	// which is a fractional resample and the reason sprites looked mushy
	const up = upscale(g.grid, 2)
	pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
	return id
}

/**
 * Place each worker as a real image. The footprint is the world-scale one — one
 * tile wide, two tall — but the terminal draws it at font resolution, so the
 * sprite is far more detailed than the canvas grid it occupies.
 */
export function drawImages(placements: Placed[]) {
	const pre: string[] = []
	let out = ''
	let pid = 1
	const cols = CHAR_W
	const rows = CHAR_H / 2
	for (const p of placements) {
		const id = ensureTransmitted(p, pre)
		out += cursorTo((p.y >> 1) + 2, p.x + 1) + place(id, cols, rows, pid++, 3)
	}
	return pre.join('') + out
}

/** Static furniture. Sent once per kind and then only re-placed each frame. */
export function drawProps() {
	const pre: string[] = []
	let out = ''
	let pid = 200
	for (const pr of office.props) {
		const { id, fresh } = idFor(`prop:${pr.kind}`)
		if (fresh) {
			const up = upscale(prop(pr.kind).grid, 2)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		const size = PROP_SIZE[pr.kind]
		// furniture behind, workstations above it, people above everything
		out += cursorTo((pr.y >> 1) + 2, pr.x + 1) + place(id, size.w * TILE, (size.h * TILE) / 2, pid++, 1, loudOnce())
	}
	return pre.join('') + out
}

/** Monitors sit on the desk row, which no character overlaps, so no z conflict. */
export function drawPlates() {
	const pre: string[] = []
	let out = ''
	let pid = 700
	const w = PLATE_COLS * cell.w
	const h = PLATE_ROWS * cell.h
	for (const p of office.plates) {
		const pick = choose(p.proj, w, h)
		if (!pick) continue // too small to read; RimWorld's rule — draw nothing
		const { id, fresh } = idFor(`plate:${p.proj}:${w}x${h}`)
		if (fresh) {
			const g = plate(pick.font, pick.text, w, h, p.colour, C.ink, C.night, pick.scale)
			// factor 1, deliberately: see the note on `cell`
			const up = upscale(g.grid, 1)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((p.y >> 1) + 2, p.x + 1) + place(id, PLATE_COLS, PLATE_ROWS, pid++, 2, loudOnce())
	}
	return pre.join('') + out
}

/**
 * The desk screens, as images, which is what lets their text be sized in pixels.
 *
 * Keyed on the CONTENT, so a screen is re-transmitted when its terminal moves and not
 * otherwise. Built at exactly `cols * cell.w` by `rows * cell.h` and transmitted 1:1 — see
 * deskscreen.ts on what supersampling does to a one-pixel stem.
 */
export function drawDeskScreens(list: Session[], watched: string[]) {
	const pre: string[] = []
	let out = ''
	let pid = 900
	const byId = new Map(list.map((s) => [s.id, s]))
	for (const sc of office.screens) {
		const s = sc.id ? byId.get(sc.id) : undefined
		const scr = s?.workspace ? glance(s.workspace, `${s.turns}:${s.ctxUsed}:${s.doing}`) : null
		if (s?.workspace) watched.push(s.workspace)
		const cols = sc.w * TILE
		const rows = (sc.h * TILE) >> 1
		const wPx = cols * cell.w
		const hPx = rows * cell.h
		const fit = screenFits(wPx, hPx)
		const lines = (scr?.lines ?? []).slice(-Math.max(1, fit.rows - 1)).map((l) => l.slice(0, fit.cols))
		const beat = screenFrame % 2
		const { id, fresh } = idFor(`ds:${wPx}x${hPx}:${s?.id ?? '-'}:${s?.state ?? '-'}:${beat}:${scr?.reading ? 'r' : ''}${scr?.error ?? ''}:${lines.join('')}`)
		if (fresh) {
			const g = screenImage(wPx, hPx, s, lines, !!scr?.reading, scr?.error, screenFrame)
			// factor 1, deliberately — the scaling is inside the drawing, at integer steps
			const up = upscale(g.grid, 1)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo(((sc.row * TILE) >> 1) + 2, sc.col * TILE + 1) + place(id, cols, rows, pid++, 2, loudOnce())
	}
	return pre.join('') + out
}

export function drawMonitors() {
	const pre: string[] = []
	let out = ''
	let pid = 500
	for (const m of office.monitors) {
		// Key and picture from the same descriptor, so they cannot describe different
		// desks — see the note on `Desk` for the version of this that shipped.
		const { id, fresh } = idFor(monitorKey(m, screenFrame))
		if (fresh) {
			const up = upscale(monitorFor(m, screenFrame).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		// the first workstation is the sentinel; if the store was wiped it answers
		// ENOENT and the reader below re-arms every transmit
		out += cursorTo((m.y >> 1) + 2, m.x + 1) + place(id, MON_COLS, MON_ROWS, pid++, 2, loudOnce())
	}
	for (const b of office.badges) {
		const { id, fresh } = idFor(badgeKey(b))
		if (fresh) {
			const up = upscale(badgeFor(b, LEVEL_LOOK).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((b.y >> 1) + 2, b.x + 1) + place(id, TILE, TILE / 2, pid++, 2)
	}
	// The harness sign beside each desk. Keyed by `logoKey` rather than by a string
	// spelled out here, for the reason the desks already learned the hard way: two
	// pictures that differ hashing to one key means the second is served the first's
	// image, and the mark silently disappears.
	for (const l of office.logos) {
		const { id, fresh } = idFor(logoKey(l.agent))
		if (fresh) {
			const up = upscale(logo(l.agent, harnessColor(l.agent)).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((l.y >> 1) + 2, l.x + 1) + place(id, TILE, TILE / 2, pid++, 2)
	}
	return pre.join('') + out
}

/**
 * Render the documentation image: the office as it actually looks.
 *
 * An ANSI-to-SVG pass can only capture the half-block fallback, which is a
 * different-looking program — the sprites, workstations and level badges are
 * kitty images and never touch the text grid. So this composites the same layers
 * the terminal does, at the same resolution, and embeds the result as a raster
 * inside an SVG. Text stays real text drawn on top, because a nameplate flattened
 * into pixels is unreadable at any size.
 *
 * Geometry: one terminal column is 4 raster pixels and one row is 8, which is
 * exactly the scale at which a 16x32 character sprite lands 1:1 without
 * resampling. Everything else follows from that.
 *
 *     npx tsx tools/shot.ts --cols 104 --rows 40 -o docs/room.svg
 */
import fs from 'node:fs'
import { Canvas } from '../src/canvas.ts'
import { demoSessions } from '../src/demo.ts'
import { Office } from '../src/office.ts'
import { renderRoom } from '../src/render.ts'
import { loadSheets } from '../src/sheets.ts'
import type { RGB } from '../src/theme.ts'
import { encodePNG } from '../src/kitty.ts'
import * as T from '../src/table.ts'
import { order } from '../src/data.ts'

// 8/16 rather than 4/8: a nameplate's ink band is 11px and needs two columns of
// room, which 4px per column cannot give. Sprites stay sharp at any multiple.
const SX = 8
const SY = 16
const CW = 8.4 // display width of a column, in SVG units
const LH = 16.8 // display height of a row — SY/SX * CW keeps the room square

const arg = (name: string, dflt: number) => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? Number(process.argv[i + 1]) : dflt
}
const COLS = arg('cols', 104)
const ROWS = arg('rows', 40)
const OUT = process.argv[process.argv.indexOf('-o') + 1] ?? 'docs/room.svg'

/* ── the room, as pixels ── */

loadSheets()
const sessions = demoSessions()
const tableRows = Math.min(sessions.length + 4, Math.max(6, Math.floor(ROWS * 0.34)))
const townRows = ROWS - tableRows
const cv = new Canvas(COLS, townRows * 2)
const office = new Office(seeded(7))
office.fit(cv.w, cv.h, sessions)
office.assign(sessions)
// let the room settle so the idle characters are at facilities rather than
// standing on their spawn tiles, which is not what it looks like in use
for (let i = 0; i < 900; i++) office.update(1 / 30, sessions)
office.vertical = true
const placed = office.draw(cv, sessions)
office.vertical = true
const placed2 = placed
office.overlay(cv, placed2, sessions[0].id, true, true)

const { rgba: raster, w: W, h: H } = renderRoom(cv, office, placed, SX, SY)

/* ── the SVG: raster underneath, real text on top ── */

const png = encodePNG(raster, W, H)
const roomW = cv.w * CW
const roomH = cv.rows * LH
const lines = [T.header(COLS), ...T.rows(sessions, COLS, sessions[0].id, (p) => office.colourOf(p)).map((r) => r.line)]
const detail = T.detail(order(sessions)[0], COLS)
const footer = T.footer(COLS, office.hiddenCount, false, 'split', { armed: true, holding: true })
// no version stamp: it would make this file differ on every commit
const below = [T.summary(sessions, COLS, { armed: true, holding: true }, '')]
const textRows = [...lines, ...detail, footer]

const totalH = LH + roomH + textRows.length * LH + 16
const svg: string[] = [
	// the xlink namespace has to be declared or the whole document is invalid and
	// renders as an error page rather than an image — SVG 1.1 readers still want it
	`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${roomW.toFixed(0)}" height="${totalH.toFixed(0)}" viewBox="0 0 ${roomW.toFixed(0)} ${totalH.toFixed(0)}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">`,
	`<rect width="100%" height="100%" fill="#282634"/>`,
	// the header line, then the room, then the table
	...ansiRow(below[0], 0, LH * 0.75),
	`<image x="0" y="${LH}" width="${roomW.toFixed(1)}" height="${roomH.toFixed(1)}" image-rendering="pixelated" preserveAspectRatio="none" xlink:href="data:image/png;base64,${png.toString('base64')}" href="data:image/png;base64,${png.toString('base64')}"/>`,
]
// nameplates and status labels live in the canvas text layer, over the room
for (let r = 0; r < cv.rows; r++) {
	for (let c = 0; c < cv.w; c++) {
		const cell = cv.cellAt(c, r)
		if (!cell) continue
		const y = LH + r * LH
		if (cell.bg) svg.push(`<rect x="${(c * CW).toFixed(2)}" y="${y.toFixed(2)}" width="${CW.toFixed(2)}" height="${LH.toFixed(2)}" fill="${hex(cell.bg)}"/>`)
		if (cell.ch.trim()) svg.push(`<text x="${(c * CW).toFixed(2)}" y="${(y + LH * 0.76).toFixed(2)}" fill="${hex(cell.fg ?? [220, 220, 220])}" xml:space="preserve">${esc(cell.ch)}</text>`)
	}
}
textRows.forEach((line, i) => svg.push(...ansiRow(line, 0, LH + roomH + (i + 0.75) * LH)))
svg.push('</svg>')
fs.mkdirSync('docs', { recursive: true })
fs.writeFileSync(OUT, svg.join('\n'))
console.log(`wrote ${OUT} (${(svg.join('\n').length / 1024).toFixed(0)}KB, ${roomW.toFixed(0)}x${totalH.toFixed(0)})`)

/* ── helpers ── */

// declarations, not const arrows: these are used above where they are written
function hex(c: RGB) {
	return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
function esc(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One ANSI line as SVG: background runs first, then glyph runs. */
function ansiRow(line: string, x0: number, baseline: number): string[] {
	const out: string[] = []
	const cells: { ch: string; fg: string; bg: string | null; bold: boolean }[] = []
	let fg = '#d0d0d0'
	let bg: string | null = null
	let bold = false
	const SGR = /\x1b\[([0-9;]*)m/y
	let i = 0
	while (i < line.length) {
		SGR.lastIndex = i
		const m = SGR.exec(line)
		if (m) {
			const p = m[1].split(';').filter(Boolean).map(Number)
			for (let j = 0; j < p.length; j++) {
				if (p[j] === 0) ((fg = '#d0d0d0'), (bg = null), (bold = false))
				else if (p[j] === 1) bold = true
				else if ((p[j] === 38 || p[j] === 48) && p[j + 1] === 2) {
					const col = `#${[p[j + 2], p[j + 3], p[j + 4]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
					if (p[j] === 38) fg = col
					else bg = col
					j += 4
				}
			}
			i = m.index + m[0].length
			continue
		}
		cells.push({ ch: line[i], fg, bg, bold })
		i++
	}
	let c = 0
	while (c < cells.length) {
		const b = cells[c].bg
		let run = c
		while (run < cells.length && cells[run].bg === b) run++
		if (b) out.push(`<rect x="${(x0 + c * CW).toFixed(2)}" y="${(baseline - LH * 0.76).toFixed(2)}" width="${((run - c) * CW).toFixed(2)}" height="${LH.toFixed(2)}" fill="${b}"/>`)
		c = run
	}
	c = 0
	while (c < cells.length) {
		const { fg: f, bold: bd } = cells[c]
		let run = c
		const buf: string[] = []
		while (run < cells.length && cells[run].fg === f && cells[run].bold === bd) buf.push(cells[run++].ch)
		const s = buf.join('')
		if (s.trim()) out.push(`<text x="${(x0 + c * CW).toFixed(2)}" y="${baseline.toFixed(2)}" fill="${f}"${bd ? ' font-weight="700"' : ''} xml:space="preserve">${esc(s)}</text>`)
		c = Math.max(run, c + 1)
	}
	return out
}

/** Fixed seed so the image is the same every time it is regenerated. */
function seeded(seed: number) {
	let s = seed >>> 0
	return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)
}

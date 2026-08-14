/**
 * The office, moving. The README's one animated image.
 *
 * The stills say what the room contains; they cannot say that it is a simulation.
 * Characters walk to the kitchen, rally around a ping-pong table, and sit back
 * down when their session starts working again — which is the whole reason this
 * program looks the way it does, and it is invisible in a screenshot.
 *
 * Frames come from the same simulation the terminal runs, advanced by a fixed dt
 * and rendered through the same compositor as `shot.ts`. Nothing is recorded off a
 * screen: a capture would be at the mercy of whatever font and window size the
 * machine happened to have, and would have to be redone by hand every time the
 * layout changed.
 *
 * Seeded, so the same command produces the same animation. `ffmpeg` turns the
 * frames into a GIF — a dev-machine tool, not a dependency of the program.
 *
 *     npx tsx tools/make-docs-gif.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Canvas } from '../src/canvas.ts'
import { demoSessions } from '../src/demo.ts'
import { Office } from '../src/office.ts'
import { renderRoom } from '../src/render.ts'
import { loadSheets } from '../src/sheets.ts'
import { encodePNG } from '../src/kitty.ts'

const COLS = 100
/**
 * The same floor area `room.svg` gets, which is the still's 58 rows minus the 14
 * its table takes. Room only — the table is already a still and nothing in it
 * moves.
 *
 * Not a smaller number. At 30 the pods packed sideways until every nameplate
 * truncated to four characters, and the lounge furniture dropped out entirely —
 * it needs about 22 rows of floor to place — so the animation lost the ping-pong
 * table and the couch, which are the things it exists to show.
 */
const ROWS = 44
/** 12 fps for 6 seconds. Fast enough to read as walking, few enough frames that
 *  the file stays small enough for a README nobody waits on. */
const FPS = 12
const SECONDS = 6
/**
 * Three times a terminal's native cell, and this is what makes the nameplates
 * legible — not anything done to the GIF afterwards.
 *
 * A plate is authored at its box's real pixel size, and that box grows with the
 * terminal's font. At the native 4x8 the strip is 16px wide, which is too little
 * for anything but the crudest font on the ladder: `pick()` returns 4x6 and cuts
 * `brightwater` down to `brig.`. Enlarging that afterwards enlarges a 4x6 glyph —
 * there is no detail in it to recover, which is why upscaling the GIF looked
 * identical however carefully it was done.
 *
 * At 12x24 the strip is 48px, `pick()` reaches the 6x13 font at the top of the
 * ladder, and the whole name fits. This is not a trick: it is exactly what the
 * room looks like in a terminal with a large font, which is a real way to run it.
 */
const SX = 12
const SY = 24

const out = process.argv.includes('-o') ? process.argv[process.argv.indexOf('-o') + 1] : 'docs/room.gif'

loadSheets()
const sessions = demoSessions()
const cv = new Canvas(COLS, ROWS * 2)
/**
 * Seed and settle chosen so a ping-pong rally is already under way when the
 * capture starts — searched for, not staged.
 *
 * A rally needs two idle characters to drift within talking distance of a free
 * table, which the simulation brokers on its own; it cannot be asked for from
 * outside without reaching into private state and posing the scene. So instead
 * every seed was rendered and scored on how many of the 72 frames differ, and
 * this pair won: 54 distinct frames against 6 for the previous seed 7, whose room
 * sat almost perfectly still for the whole six seconds.
 *
 * 45 seconds rather than the default 20 because that is roughly how long it takes
 * two people to finish what they were doing and find each other. A rally then runs
 * 30 to 90 seconds — DWELL.pingpong — so once it starts it comfortably outlasts
 * the clip, and the GIF has motion in every frame rather than a still room with
 * one person walking across it.
 */
const office = new Office(seeded(20))
office.fit(cv.w, cv.h, sessions)
office.assign(sessions)
office.settle(sessions, 45)
office.vertical = true

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-gif-'))
const total = FPS * SECONDS
for (let i = 0; i < total; i++) {
	const placed = office.draw(cv, sessions)
	const { rgba, w, h } = renderRoom(cv, office, placed, SX, SY)
	fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), encodePNG(rgba, w, h))
	// advance the same simulation the terminal runs, one frame's worth
	office.update(1 / FPS, sessions)
}

// Two passes: build a palette from the WHOLE clip, then apply it. One pass picks a
// palette per frame and the pixel art shimmers — every flat colour in the room
// crawls slightly, which on a pixel-art image reads as a broken encoder.
//
// The whole animation uses 246 distinct colours — counted, not assumed — so a
// 256-entry palette holds every one of them and the GIF is pixel-exact. That is
// what makes `dither=none` below correct rather than a compromise.
const pal = path.join(dir, 'palette.png')
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, 'f%04d.png'), '-vf', 'palettegen=stats_mode=full:max_colors=256', pal])
execFileSync('ffmpeg', [
	'-y',
	'-v',
	'error',
	'-framerate',
	String(FPS),
	'-i',
	path.join(dir, 'f%04d.png'),
	'-i',
	pal,
	// Tripled with NEAREST NEIGHBOUR, never a smooth filter, and the factor is not
	// arbitrary — it has to survive the BROWSER's scaling, which is the step that
	// actually decides whether this looks sharp.
	//
	// The raster is 1:1 pixel art at 400px wide. The README shows it at 600 CSS px,
	// and a retina screen paints that with 1200 device pixels — so anything narrower
	// than 1200 gets upscaled by the browser with a smooth filter and goes soft, no
	// matter how clean the GIF itself is. A 2x GIF was 800px against 1240 needed:
	// upscaled 1.55x, and it looked exactly as blurry as the un-fixed version.
	//
	// 3x = 1200px, displayed at 600. On retina that is pixel-for-pixel; on a 1x
	// screen it is a clean 2:1 downscale. Keep SCALE and the README's `width` in
	// that 2:1 relationship or the blur comes straight back.
	//
	// `dither=none`, and this is the whole reason the nameplates are legible.
	//
	// Error-diffusion dithering scatters the quantisation error of one pixel into
	// its neighbours. On a photograph that hides banding; on a nameplate whose
	// letters are ONE PIXEL wide it sprays those stems into surrounding pixels and
	// the name turns to mush — which is exactly what shipped in the first version of
	// this file, with `sierra2_4a`. nameplate.ts warns about the same class of
	// mistake at the other end of the pipeline: never supersample a plate, because
	// filtering averages 1px stems into grey. Dithering does it too.
	//
	// There is nothing to dither anyway. The clip has 246 colours and the palette
	// holds 256, so every pixel maps exactly and error diffusion has zero error to
	// diffuse — it was pure damage.
	'-lavfi',
	'paletteuse=dither=none',
	'-loop',
	'0',
	out,
])
fs.rmSync(dir, { recursive: true, force: true })
console.log(`${out}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  ${total} frames at ${FPS}fps`)

/** Fixed seed so the animation is the same every time it is regenerated. */
function seeded(seed: number) {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 4294967296
	}
}

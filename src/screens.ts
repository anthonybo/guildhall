/**
 * Workstation monitors, generated rather than drawn from art.
 *
 * A desk tile is only 4x4 canvas pixels, so a monitor painted into the canvas is
 * four pixels and invisible. Sent as an image instead, the same tile renders at
 * font resolution — about 32x34 real pixels — which is enough for a bezel, a
 * stand, and a few lines of code on the screen.
 */
import type { RGB } from './png.ts'
import type { Grid } from './characters.ts'

const W = 16
const H = 24 // screen on top, desk surface with keyboard and mug below

const CASE: RGB = [46, 48, 62]
const CASE_LIT: RGB = [72, 76, 96]
const BASE: RGB = [38, 40, 52]
const DARK: RGB = [22, 24, 32]
/** Syntax-ish colours, so a lit screen reads as code rather than as a block. */
const CODE: RGB[] = [
	[126, 220, 190],
	[150, 190, 255],
	[240, 200, 120],
	[230, 140, 170],
	[170, 210, 140],
]

/** A 3x5 pixel font — the smallest that stays legible once the workstation image
 *  is drawn at font resolution. */
const DIGITS: Record<string, string[]> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '010', '010', '010'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111'],
	'?': ['111', '001', '011', '000', '010'],
	'★': ['101', '111', '010', '111', '101'],
}

const cache = new Map<string, Grid>()

/**
 * `activity` shifts the line lengths so consecutive frames differ — a session
 * that is working has a screen that visibly changes. `off` screens are dark and
 * static, which is what makes an unoccupied desk read as unoccupied.
 */
export type Kind = 'edit' | 'read' | 'run' | 'search' | 'agent' | 'think'

/** Screen tint by tool class, so the whole room is readable at a glance. */
export const TINT: Record<Kind, RGB> = {
	edit: [120, 170, 255],
	read: [110, 220, 235],
	run: [250, 180, 90],
	search: [200, 160, 250],
	agent: [160, 235, 150],
	think: [150, 160, 190],
}

/**
 * The mug, which is the one thing on a desk that carried no meaning.
 *
 * Two Claude sessions and a Codex session in the same project sit as three identical
 * workers in the same pod, and until now nothing in the room told them apart at rest —
 * the label prefix only appears on a session that is urgent or selected. Both of the
 * obvious channels were already taken: the sprite badge IS the level tier, and the
 * screen tint IS the tool class, so putting a third meaning on either would break the
 * property that makes the room readable at a glance.
 *
 * A mug is decorative, always present, and per-desk. A different mug reads as somebody
 * else's desk, which is exactly the fact being conveyed.
 */
/**
 * A colour per harness, defined once.
 *
 * The room paints the desk mug with it and the table paints its harness glyph with it,
 * so the two surfaces say the same thing the same way rather than drifting into two
 * different ideas of what colour Codex is.
 */
export const HARNESS: Record<string, RGB> = {
	claude: [226, 118, 96],
	codex: [110, 186, 196],
}
export const harnessColor = (agent?: string): RGB => HARNESS[agent ?? 'claude'] ?? HARNESS.claude!

/**
 * The one description of a harness mark: its glyph, its colour, and what to call it.
 *
 * Here rather than at each surface because the glyph had three definitions — a map in
 * table.ts, an inline ternary in web/list.ts, and the mug in this file — for one
 * decision. That is the shape of the nameplate bug, where the terminal tripled the
 * plates and the shipped browser bundle still drew the old ones: nothing was wrong
 * with either copy, they just stopped agreeing.
 *
 * Glyphs and not the vendors' logos. Those are someone else's trademark and this is a
 * public repository, so shipping them is a licensing decision rather than a drawing
 * one — and the room draws these at desk scale, where a faithful logo would have to be
 * redrawn into a handful of pixels, which is the modification brand guidelines
 * consistently forbid.
 *
 * `name` is the accessible name, so a screen reader gets a word rather than a
 * decorative character.
 */
export type Harness = { glyph: string; color: RGB; name: string }
const MARK: Record<string, Harness> = {
	claude: { glyph: '✳', color: HARNESS.claude!, name: 'Claude Code' },
	codex: { glyph: '◆', color: HARNESS.codex!, name: 'Codex — queued messages, no terminal tab' },
}
/** An unknown harness gets a neutral dot rather than being drawn as Claude Code:
 *  guessing wrong here is worse than admitting the mark is not known. */
export const harnessMark = (agent?: string): Harness => MARK[agent ?? 'claude'] ?? { glyph: '·', color: HARNESS.claude!, name: agent ?? 'unknown' }

/**
 * One desk's worth of drawing inputs.
 *
 * This type and the two helpers under it exist because of a real, shipped failure.
 * `monitor()` takes five positional arguments and had THREE call sites — the
 * terminal's half-block path, the terminal's image path, and the compositor the
 * browser and the docs share. When `agent` was added, only the compositor was
 * updated, so the harness mark appeared in the browser and never once in the
 * terminal. The room was reported as having "no logo at the desks anywhere", and it
 * was right: in the terminal there was none.
 *
 * Worse, the image path's cache key was assembled by hand from the same five values
 * and also omitted `agent`, so even once the draw call was fixed two desks differing
 * only by harness would hash alike and the second would be served the first's
 * picture.
 *
 * Passing the descriptor means a new field reaches the drawing and the key together
 * or not at all.
 */
export type Desk = { lit: boolean; seed: number; kind: Kind; agent?: string }

/** Draw a desk from its descriptor. Every caller should use this, not `monitor`. */
export const monitorFor = (d: Desk, frame: number): Grid => monitor(d.lit, frame, d.seed, d.kind, d.agent)

/**
 * The cache key for that exact picture.
 *
 * Derived from the same descriptor as the drawing, so the two cannot disagree. An
 * unlit screen is static, so its frame is pinned to 0 rather than churning a new
 * image every tick for a desk nobody is at.
 */
export const monitorKey = (d: Desk, frame: number): string =>
	`mon:${d.lit ? 'on' : 'off'}:${d.lit ? frame % 4 : 0}:${d.seed % 8}:${d.kind}:${d.agent ?? ''}`

export function monitor(lit: boolean, frame: number, seed = 0, kind: Kind = 'think', agent?: string): Grid {
	const key = `${lit ? 1 : 0}:${lit ? frame % 4 : 0}:${seed % 8}:${kind}:${agent ?? ''}`
	const hit = cache.get(key)
	if (hit) return hit
	const grid: (RGB | null)[][] = Array.from({ length: H }, () => new Array<RGB | null>(W).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = c
	}
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
	}

	// desk surface under the screen, with the things a desk actually has on it
	const WOOD: RGB = [138, 96, 62]
	const WOOD_DK: RGB = [104, 70, 44]
	box(0, 16, W, 8, WOOD)
	box(0, 16, W, 1, [168, 122, 82])
	box(0, 23, W, 1, WOOD_DK)
	/**
	 * What kind of machine is on this desk, which is how the harness is told apart.
	 *
	 * SHAPE, after three attempts at colour all failed. The room is already saturated
	 * with colour — a carpet hue per project, a tier strip on every badge, a tool tint
	 * on every lit screen — so a twelfth colour meaning cannot be found in it, and all
	 * three attempts were reported as invisible: a coloured mug, then a cable beside it,
	 * then a tinted badge frame. The table's own harness column works for the opposite
	 * reason: `*` and a diamond differ in shape, not in hue.
	 *
	 * And the MONITOR AREA, because it is the one part of a desk nothing ever covers.
	 * A pod's monitor row is two rows above its seat and the occupant is two tall, so
	 * they reach the worktop and stop — which is why the mug failed while somebody was
	 * working and why this cannot.
	 *
	 * A laptop reads as a different machine at a glance: no neck, a screen sitting on a
	 * wide deck. Both harnesses are still positively identified — a desktop monitor is
	 * as much a statement as a laptop is — so this is not the "Claude is the desks
	 * without a mark" problem that the first version had.
	 */
	const laptop = agent === 'codex'
	if (!laptop) {
		// stand and base
		box(7, 12, 2, 3, BASE)
		box(5, 15, 6, 1, CASE)
	} else {
		// A deck the full width of the sprite, and thick. The outline is the whole point:
		// a monitor is a wide screen on a thin neck, so it is narrow at the bottom and
		// broad at the top. This is the reverse — a smaller lid on a base wider than
		// itself — and the eye picks that up from across the room where a hue change did
		// not. A timid first version kept the lid full width and read as "the same desk,
		// slightly lower".
		box(0, 13, W, 3, lit ? CASE_LIT : CASE)
		// the keyboard deck catching the light, so it reads as a surface not a slab
		box(1, 13, 14, 1, [92, 98, 118])
		box(0, 15, W, 1, BASE)
	}
	// keyboard
	box(3, 18, 9, 3, [58, 62, 78])
	box(4, 19, 7, 1, [92, 98, 118])
	// mug — its colour is which harness this desk belongs to
	const mug = harnessColor(agent)
	box(13, 18, 3, 3, mug)
	put(12, 19, mug)
	// A cable was added here and REMOVED again. It was meant to make the harness
	// findable, and it cannot: the occupant is drawn over this surface while they are
	// working, so the mark disappeared exactly when the session was active. Leaving it
	// in would be a second layer on a diagnosis that had already been shown wrong. The
	// mug stays because it predates all this and reads at close range; the badge frame
	// is what actually carries the fact.
	// a small stack of paper where the badge used to sit
	box(0, 19, 3, 2, [236, 234, 226])
	// bezel
	//
	// NOT tinted by harness, though that was tried and shipped. Each pod's carpet shows
	// through around this sprite, so the monitor already wears a ring in its project's
	// colour; a tint inside that ring is low contrast against the dark screen and reads
	// as noise rather than as a fact. It looked convincing in an isolated crop only
	// because both desks in it shared one carpet. The harness lives on the level badge
	// instead — see the note there.
	// The lid: shorter AND narrower than a monitor's bezel, which is what makes the
	// silhouette read as a different machine rather than as the same one moved.
	const top = laptop ? 4 : 1
	const tall = laptop ? 9 : 11
	const x0 = laptop ? 2 : 1
	const wide = laptop ? 12 : 14
	box(x0, top, wide, tall, lit ? CASE_LIT : CASE)
	box(x0 + 1, top + 1, wide - 2, tall - 2, DARK)

	// Everything on the screen moves down with the lid, or a laptop's code lines would
	// be painted onto its bezel. The screen contents are the tool tint and must look
	// identical on both machines — only the frame around them differs.
	const sy = top - 1
	if (lit) {
		// four ragged code lines; the ragging advances with the frame
		const lens = [9, 6, 11, 7]
		for (let i = 0; i < 4; i++) {
			const y = sy + 3 + i * 2
			const wob = ((frame + i * 3 + seed) % 5) - 2
			const len = Math.max(2, Math.min(11, lens[i] + wob))
			const indent = i === 1 || i === 3 ? 3 : 2
			for (let x = 0; x < len && indent + x < 13; x++) put(indent + x, y, i === 0 ? TINT[kind] : CODE[(i + seed) % CODE.length])
		}
		// caret, blinking on alternate frames
		if (frame % 2 === 0) put(3, sy + 9, [250, 250, 250])
	} else {
		// a faint reflection so an idle screen still looks like glass
		for (let x = 3; x < 11; x++) put(x, sy + 3, [40, 44, 58])
	}
	const g: Grid = { w: W, h: H, grid }
	cache.set(key, g)
	return g
}

const badges = new Map<string, Grid>()

/**
 * The level badge, as its own one-tile image. It lives beside the desk rather
 * than on it: a seated occupant covers the desk surface, and a badge you cannot
 * see while someone is working is the wrong way round.
 */
/**
 * One level badge's inputs, for the same reason `Desk` exists.
 *
 * `badge()` had three callers too, and all three re-derived `tier` and `face` from
 * `asking` and `level` with their own copy of the same two ternaries. That is the
 * arrangement that lost the harness on the desks: not one mistake, but a shape where
 * adding an input means finding every place that spells the arguments out.
 */
export type Level = { level: number; asking: boolean }

/**
 * Which colour a badge's tier strip takes. Needs-attention outranks the rank, because
 * a session waiting on you is the thing you are scanning for.
 *
 * Passed in rather than imported so screens.ts stays free of theme.ts — the docs
 * compositor and the terminal already disagree about nothing here and should keep it
 * that way.
 */
export type LevelLook = { needs: RGB; tierOf: (level: number) => RGB }
const lookOf = (b: Level, look: LevelLook): RGB => (b.asking ? look.needs : look.tierOf(b.level))

/** Draw a level badge from its descriptor. Every caller should use this. */
export const badgeFor = (b: Level, look: LevelLook): Grid => badge(b.level, lookOf(b, look), b.asking ? '?' : '')

/** The cache key for that exact badge, derived from the same descriptor. */
export const badgeKey = (b: Level): string => (b.asking ? 'badge:ask' : `badge:${b.level}`)

export function badge(level: number, tier: RGB, face = ''): Grid {
	const key = level + ':' + tier.join('') + ':' + face
	const hit = badges.get(key)
	if (hit) return hit
	const grid: (RGB | null)[][] = Array.from({ length: 16 }, () => new Array<RGB | null>(16).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < 16 && y < 16) grid[y][x] = c
	}
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
	}
	const CARD: RGB = [238, 236, 228]
	/**
	 * A fixed gray, deliberately.
	 *
	 * The frame was tinted toward the harness colour and it did not work — reported as
	 * "looks the exact same". The room is already saturated with colour: a carpet hue per
	 * project, a tier strip on every one of these badges, a tool tint on every lit screen.
	 * One more hue among eleven multicoloured cards is not findable, and that was the
	 * THIRD colour attempt after the mug and the cable. The harness is a shape now — a
	 * laptop rather than a monitor — which is why the table's own harness column works.
	 */
	const EDGE: RGB = [90, 92, 102]
	box(7, 0, 2, 2, EDGE)
	box(2, 2, 12, 13, EDGE)
	box(3, 3, 10, 3, tier)
	box(3, 6, 10, 8, CARD)
	const INK: RGB = [40, 42, 54]
	if (face) {
		const glyph = DIGITS[face] ?? DIGITS['0']
		glyph.forEach((r, y) => [...r].forEach((c, x) => c === '1' && put(6 + x, 8 + y, INK)))
	} else {
		// two digits fit: the card is ten pixels wide inside, a digit is three, so
		// 3+1+3 leaves a margin. Levels are open-ended now and mostly two digits.
		const text = String(Math.max(1, Math.min(99, level)))
		const startX = text.length > 1 ? 4 : 6
		;[...text].forEach((ch, i) => {
			const glyph = DIGITS[ch] ?? DIGITS['0']
			glyph.forEach((r, y) => [...r].forEach((c, x) => c === '1' && put(startX + i * 4 + x, 8 + y, INK)))
		})
	}
	const g: Grid = { w: 16, h: 16, grid }
	badges.set(key, g)
	return g
}

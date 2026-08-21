/**
 * The harness mark on a desk, as an actual logo.
 *
 * Its own file because the room's other sprites are furniture and this is branding —
 * a different kind of thing with a different reason to change, and screens.ts is
 * already near the size limit.
 *
 * WHY A LOGO, after four other ideas. A coloured mug, a coloured cable, a tinted
 * badge frame and a differently shaped machine were each tried and each reported
 * invisible or unclear. Three of the four failed for one reason worth stating plainly:
 * colour is a saturated channel in this room. There is a carpet hue per project, a
 * tier-coloured strip on every badge and a tool tint on every lit screen, so a further
 * hue has nowhere to land. The fourth — a laptop instead of a monitor — was legible
 * but answered the wrong question: it says two desks have different equipment, not
 * which agent each desk belongs to. What was asked for was "a clear indication of what
 * each desk represents", and the honest answer to that is the mark people already
 * recognise.
 *
 * WHERE. The gap column beside each desk, one slot below the level badge. That column
 * is where nobody sits, so nothing occludes it — the reason the mug failed is that it
 * sat on the worktop, which the occupant is drawn over while they work. At a real
 * terminal's cell this tile is roughly 44x44 screen pixels, which is the first surface
 * in this room big enough for a mark to be recognisable rather than merely different.
 *
 * ON THE MARKS THEMSELVES. These are pixel-art reductions of the Anthropic and OpenAI
 * logos, drawn here rather than copied: no vendor artwork is redistributed by this
 * repository. They are used to identify those vendors' own products, which is what the
 * marks are for, and guildhall claims no affiliation with or endorsement by either.
 * They are necessarily approximations — a mark redrawn at eleven pixels across cannot
 * be faithful, and brand guidelines generally ask that logos not be modified, so
 * anyone repackaging this should treat these two sprites as the part to check.
 */
import type { RGB } from './png.ts'
import type { Grid } from './characters.ts'

const W = 16
const H = 16

/**
 * Anthropic's mark: a radiating burst.
 *
 * Eleven across, drawn as eight tapered rays from a centre. This is the same shape the
 * table's harness column shows as an asterisk, so the two surfaces agree about what
 * Claude Code looks like rather than each inventing a symbol.
 */
const CLAUDE = [
	'.....#.....',
	'.....#.....',
	'.#...#...#.',
	'..#..#..#..',
	'...#.#.#...',
	'###########',
	'...#.#.#...',
	'..#..#..#..',
	'.#...#...#.',
	'.....#.....',
	'.....#.....',
]

/**
 * OpenAI's mark: the hexagonal knot.
 *
 * Reduced to a hexagon of six loops meeting at the centre. The real mark's interlacing
 * cannot survive this resolution — it is three strokes wide at full size — so what is
 * kept is the silhouette and the six-fold symmetry, which is what makes it readable as
 * that logo and not as a generic shape.
 */
const CODEX = [
	'...#####...',
	'..#.....#..',
	'.#..###..#.',
	'#..#...#..#',
	'#.#.....#.#',
	'#.#.....#.#',
	'#.#.....#.#',
	'#..#...#..#',
	'.#..###..#.',
	'..#.....#..',
	'...#####...',
]

const ART: Record<string, string[]> = { claude: CLAUDE, codex: CODEX }

/**
 * The mark as rows of pixels, for a surface that is not this room.
 *
 * Exported so the browser list can draw the SAME art as SVG rather than inventing its
 * own symbol. It had a text glyph: `*` for Claude Code, which happens to look like
 * Anthropic's actual mark, and a plain `◆` for Codex, which looks like nothing — so one
 * row read as a logo and the other as a shape. Reported as exactly that.
 *
 * One definition, three surfaces. The glyph in `harnessMark` stays for the terminal
 * table, which can only draw characters.
 */
export const logoArt = (agent: string): string[] | null => ART[agent] ?? null

/**
 * The same mark as horizontal runs: `[x, y, width]` per stretch of lit pixels.
 *
 * Here rather than in web/list.ts so it can be tested. A rect per lit pixel is 34 and 45
 * elements for the two marks; merging runs gets them to 23 and 32, and that markup ships
 * in the bundle a phone downloads. The browser turns each run into one `<rect>`.
 *
 * Also the shape a canvas or another renderer would want, so the next surface that needs
 * this mark does not re-derive it.
 */
export function logoRuns(agent: string): { x: number; y: number; w: number }[] | null {
	const rows = ART[agent]
	if (!rows) return null
	const runs: { x: number; y: number; w: number }[] = []
	rows.forEach((row, y) => {
		let x = 0
		while (x < row.length) {
			if (row[x] !== '#') {
				x++
				continue
			}
			let w = 1
			while (row[x + w] === '#') w++
			runs.push({ x, y, w })
			x += w
		}
	})
	return runs
}

/** How many rows (and columns) the art is. Square by construction; asserted in tests. */
export const logoSize = (agent: string): number => ART[agent]?.length ?? 0

/**
 * A plate to hang the mark on, so it reads as a sign rather than as loose pixels on
 * the floor. Deliberately quiet: the room already has eleven saturated carpets and the
 * mark has to be the thing you notice, not its backing.
 */
const PLATE: RGB = [40, 42, 54]
const PLATE_LIP: RGB = [58, 60, 76]

const cache = new Map<string, Grid>()

/** Is there a mark for this harness at all? Nothing is drawn for one we do not know. */
export const hasLogo = (agent?: string): boolean => !!agent && agent in ART

/** The cache key, so the terminal's image store and the drawing cannot disagree. */
export const logoKey = (agent: string): string => `logo:${agent}`

/**
 * The mark for one harness, on its plate.
 *
 * `tint` is the harness colour, passed in rather than imported so this file has no
 * opinion about the palette — screens.ts owns that, and one definition of what colour
 * Codex is has already been worth enforcing once.
 */
export function logo(agent: string, tint: RGB): Grid {
	const key = `${agent}:${tint.join(',')}`
	const hit = cache.get(key)
	if (hit) return hit
	const grid: (RGB | null)[][] = Array.from({ length: H }, () => new Array<RGB | null>(W).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = c
	}
	const box = (x: number, y: number, w: number, h: number, c: RGB) => {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
	}
	// a 13x13 plate centred in the tile, with a lit top edge like the nameplates have
	box(1, 1, 14, 14, PLATE)
	box(1, 1, 14, 1, PLATE_LIP)
	const art = ART[agent]
	if (!art) return { w: W, h: H, grid }
	// the art is 11 wide, so it sits at 2,2 inside a 14-wide plate with a pixel spare
	art.forEach((row, y) => [...row].forEach((c, x) => c === '#' && put(2 + x, 3 + y, tint)))
	const g: Grid = { w: W, h: H, grid }
	cache.set(key, g)
	return g
}

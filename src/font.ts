/**
 * The rest of the alphabet.
 *
 * `nameplate.ts` carries four bitmap fonts converted from X11 misc-fixed, and every one of
 * them holds the same 39 glyphs: lowercase, digits, and `-_.`. That was the right subset
 * for what it was built for — project names are lowercase — but it means anything else
 * drawn with it silently loses characters. Rendering a terminal through it turned `Refresh`
 * into `efresh`, `The docs` into `he docs` and `today's` into `today s`, which was reported
 * as "the text doesn't really match up" and was exactly that.
 *
 * There is no BDF source and no converter left in the repo or its history, so the missing
 * glyphs are authored here instead, in the same 5-wide, 7-tall band the lowercase font
 * uses, on rows 4..10 of its 13-row cell — measured off `b`, whose ascender starts at row 2
 * and whose baseline is row 10.
 *
 * WRITTEN AS PICTURES ON PURPOSE. A table of hex bytes cannot be reviewed; these can be
 * read straight off the page, and `font.test.ts` renders every one of them so a wrong
 * letter is visible rather than inferred.
 */
import { F6x13 } from './nameplate.ts'

/** Where a 7-row capital sits in the 13-row cell: baseline at row 10, so it starts at 4. */
const CAP_TOP = 4
const CELL_H = 13
const W = 6

// biome-ignore format: these are pictures of letters and must stay one row per line
const SHAPES: Record<string, string[]> = {
	A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
	B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
	C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
	D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
	E: ['#####', '#....', '#....', '###..', '#....', '#....', '#####'],
	F: ['#####', '#....', '#....', '###..', '#....', '#....', '#....'],
	G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
	H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
	I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
	J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
	K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
	L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
	M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
	N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
	O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
	P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
	Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
	R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
	S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
	T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
	U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
	V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
	W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
	X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
	Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
	Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],

	'!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
	'"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
	'#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
	$: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
	'%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
	'&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
	"'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
	'(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
	')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
	'*': ['..#..', '#.#.#', '.###.', '#.#.#', '..#..', '.....', '.....'],
	'+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
	',': ['.....', '.....', '.....', '.....', '..##.', '..#..', '.#...'],
	'/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
	':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
	';': ['.....', '..#..', '..#..', '.....', '..##.', '..#..', '.#...'],
	'<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
	'=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
	'>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
	'?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
	'@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.###.'],
	'[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
	'\\': ['#....', '.#...', '.#...', '..#..', '...#.', '...#.', '....#'],
	']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
	'^': ['..#..', '.#.#.', '#...#', '.....', '.....', '.....', '.....'],
	'`': ['.#...', '..#..', '.....', '.....', '.....', '.....', '.....'],
	'{': ['..##.', '.#...', '.#...', '##...', '.#...', '.#...', '..##.'],
	'|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
	'}': ['.##..', '...#.', '...#.', '...##', '...#.', '...#.', '.##..'],
	'~': ['.....', '.....', '.##.#', '#.##.', '.....', '.....', '.....'],
}

/** A picture becomes the same 13-byte hex string the converted fonts use, so both halves
 *  of the table are read by one decoder. */
function encode(rows: string[]): string {
	const out: number[] = new Array(CELL_H).fill(0)
	for (const [i, row] of rows.entries()) {
		let bits = 0
		for (let x = 0; x < W; x++) if (row[x] === '#') bits |= 1 << (W - 1 - x)
		out[CAP_TOP + i] = bits
	}
	return out.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The complete 6x13 table: the converted lowercase and digits, plus everything above.
 *
 * A space is a blank cell rather than a missing glyph — a missing one would collapse the
 * indentation that makes terminal output readable as output.
 */
export const FULL6x13 = {
	w: W,
	h: CELL_H,
	g: {
		...(F6x13.g as Record<string, string>),
		' ': '0'.repeat(CELL_H * 2),
		...Object.fromEntries(Object.entries(SHAPES).map(([ch, rows]) => [ch, encode(rows)])),
	} as Record<string, string>,
}

/** Rows of one glyph, or null when the font has no picture for it. */
export function glyphRows(ch: string): number[] | null {
	const hex = FULL6x13.g[ch]
	if (!hex) return null
	const rows: number[] = []
	for (let i = 0; i < CELL_H; i++) rows.push(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))
	return rows
}

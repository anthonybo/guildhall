/**
 * Office furniture, generated at 16px per tile.
 *
 * Everything here is drawn as an image rather than into the canvas: a tile is 4
 * canvas pixels, which is not enough for a sink or a net or a cushion, but the
 * same tile rendered as an image gets font resolution and plenty of room.
 *
 * The unit is a tile of 16x16 source pixels, so a 3x2-tile prop is a 48x32 grid.
 */
import type { RGB } from './png.ts'
import type { Grid } from './characters.ts'

export type PropKind = 'kitchen' | 'pingpong' | 'couch' | 'lowtable' | 'plant' | 'cooler' | 'whiteboard' | 'shelf'

const U = 16 // source pixels per tile

const P = {
	wood: [146, 104, 66] as RGB,
	woodDk: [104, 72, 44] as RGB,
	woodLt: [178, 134, 90] as RGB,
	counter: [206, 198, 182] as RGB,
	counterDk: [150, 142, 128] as RGB,
	steel: [176, 184, 196] as RGB,
	steelDk: [120, 128, 142] as RGB,
	felt: [58, 132, 96] as RGB,
	feltDk: [40, 100, 72] as RGB,
	white: [244, 246, 250] as RGB,
	fabric: [126, 112, 168] as RGB,
	fabricDk: [92, 80, 130] as RGB,
	fabricLt: [156, 142, 198] as RGB,
	leaf: [78, 156, 92] as RGB,
	leafDk: [52, 118, 70] as RGB,
	pot: [166, 106, 78] as RGB,
	potDk: [124, 76, 56] as RGB,
	glass: [150, 200, 230] as RGB,
	dark: [40, 42, 54] as RGB,
	ink: [30, 32, 42] as RGB,
	board: [236, 238, 242] as RGB,
	marker: [110, 170, 220] as RGB,
	book: [190, 90, 80] as RGB,
	book2: [88, 132, 190] as RGB,
	book3: [214, 176, 90] as RGB,
}

function blank(wTiles: number, hTiles: number) {
	const w = wTiles * U
	const h = hTiles * U
	const grid: (RGB | null)[][] = Array.from({ length: h }, () => new Array<RGB | null>(w).fill(null))
	const put = (x: number, y: number, c: RGB) => {
		if (x >= 0 && y >= 0 && x < w && y < h) grid[y][x] = c
	}
	const box = (x: number, y: number, bw: number, bh: number, c: RGB) => {
		for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) put(x + i, y + j, c)
	}
	return { w, h, grid, put, box }
}

/** Counter run with a sink and a coffee machine. 3x1 tiles. */
function kitchen(): Grid {
	const { w, h, grid, put, box } = blank(3, 1)
	box(0, 2, w, 12, P.counter)
	box(0, 2, w, 1, P.white)
	box(0, 13, w, 2, P.wood)
	for (let x = 0; x < w; x += 12) box(x, 13, 1, 2, P.woodDk)
	// sink basin
	box(3, 5, 11, 7, P.steelDk)
	box(4, 6, 9, 5, P.steel)
	box(8, 3, 1, 3, P.steel)
	// coffee machine
	box(34, 3, 9, 10, P.dark)
	box(36, 5, 5, 5, [90, 60, 44])
	box(36, 5, 5, 1, [180, 120, 84])
	put(42, 4, [230, 90, 80])
	// a mug
	box(28, 7, 3, 4, P.white)
	put(31, 8, P.white)
	return { w, h, grid }
}

/** The middle of a ping-pong table, with the net across it. 2x1 tiles. */
function pingpong(): Grid {
	const { w, h, grid, box } = blank(2, 1)
	box(0, 2, w, 12, P.felt)
	box(0, 2, w, 1, P.white)
	box(0, 13, w, 1, P.white)
	// net standing across the middle of the table
	box(14, 0, 4, 16, P.feltDk)
	box(14, 0, 4, 2, P.white)
	for (let y = 2; y < 14; y += 3) box(14, y, 4, 1, [230, 236, 240])
	box(2, 14, 2, 2, P.steelDk)
	box(w - 4, 14, 2, 2, P.steelDk)
	return { w, h, grid }
}

/** Two-seat couch: back cushion, arms, seat cushions. 2x1 tiles. */
function couch(): Grid {
	const { w, h, grid, box } = blank(2, 1)
	box(0, 2, w, h - 2, P.fabricDk)
	box(1, 0, w - 2, 5, P.fabric) // backrest
	box(2, 1, w - 4, 3, P.fabricLt)
	box(0, 3, 3, h - 4, P.fabric) // arms
	box(w - 3, 3, 3, h - 4, P.fabric)
	box(4, 6, 11, 8, P.fabricLt) // two seat cushions
	box(17, 6, 11, 8, P.fabricLt)
	box(4, 13, 11, 1, P.fabricDk)
	box(17, 13, 11, 1, P.fabricDk)
	return { w, h, grid }
}

/** Low table with a couple of things on it. 2x1 tiles. */
function lowtable(): Grid {
	const { w, h, grid, box, put } = blank(2, 1)
	box(2, 4, w - 4, 8, P.wood)
	box(2, 4, w - 4, 1, P.woodLt)
	box(2, 11, w - 4, 1, P.woodDk)
	box(4, 12, 2, 3, P.woodDk)
	box(w - 6, 12, 2, 3, P.woodDk)
	box(8, 6, 6, 3, P.white) // a magazine
	box(20, 5, 3, 4, P.glass) // and a glass
	put(21, 4, P.white)
	return { w, h, grid }
}

/** Potted plant. 1x1 tile. */
function plant(): Grid {
	const { grid, box, put } = blank(1, 1)
	box(5, 10, 6, 5, P.pot)
	box(5, 10, 6, 1, P.potDk)
	box(6, 14, 4, 1, P.potDk)
	box(6, 4, 4, 6, P.leafDk)
	box(4, 2, 3, 5, P.leaf)
	box(9, 1, 3, 6, P.leaf)
	box(7, 0, 2, 4, P.leafDk)
	put(3, 5, P.leaf)
	put(12, 4, P.leaf)
	return { w: U, h: U, grid }
}

/** Water cooler. 1x1 tile. */
function cooler(): Grid {
	const { grid, box } = blank(1, 1)
	box(5, 1, 6, 6, P.glass)
	box(6, 2, 4, 4, [180, 220, 240])
	box(4, 7, 8, 8, P.white)
	box(4, 7, 8, 1, P.steelDk)
	box(7, 10, 2, 2, P.steelDk)
	box(5, 14, 6, 1, P.steelDk)
	return { w: U, h: U, grid }
}

/** Whiteboard with some scrawl. 2x1 tiles, hangs on the wall row. */
function whiteboard(): Grid {
	const { w, grid, box } = blank(2, 1)
	box(1, 2, w - 2, 11, P.board)
	box(1, 2, w - 2, 1, P.steel)
	box(1, 12, w - 2, 1, P.steelDk)
	box(4, 5, 12, 1, P.marker)
	box(4, 7, 18, 1, P.marker)
	box(4, 9, 8, 1, [230, 140, 130])
	box(20, 9, 6, 1, P.marker)
	return { w, h: U, grid }
}

/** Bookshelf. 1x1 tile. */
function shelf(): Grid {
	const { grid, box } = blank(1, 1)
	box(1, 1, 14, 14, P.woodDk)
	box(2, 2, 12, 5, P.wood)
	box(2, 8, 12, 6, P.wood)
	for (let i = 0; i < 4; i++) box(3 + i * 3, 2, 2, 5, [P.book, P.book2, P.book3, P.book2][i])
	for (let i = 0; i < 4; i++) box(3 + i * 3, 8, 2, 6, [P.book3, P.book, P.book2, P.book][i])
	return { w: U, h: U, grid }
}

const MAKERS: Record<PropKind, () => Grid> = {
	kitchen,
	pingpong,
	couch,
	lowtable,
	plant,
	cooler,
	whiteboard,
	shelf,
}
/** Footprint in tiles, so the office can reserve the right space. */
export const PROP_SIZE: Record<PropKind, { w: number; h: number }> = {
	kitchen: { w: 3, h: 1 },
	pingpong: { w: 2, h: 1 },
	couch: { w: 2, h: 1 },
	lowtable: { w: 2, h: 1 },
	plant: { w: 1, h: 1 },
	cooler: { w: 1, h: 1 },
	whiteboard: { w: 2, h: 1 },
	shelf: { w: 1, h: 1 },
}

const cache = new Map<PropKind, Grid>()
export function prop(kind: PropKind): Grid {
	const hit = cache.get(kind)
	if (hit) return hit
	const g = MAKERS[kind]()
	cache.set(kind, g)
	return g
}

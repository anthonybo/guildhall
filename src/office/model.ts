/**
 * The vocabulary of the room: geometry, timings, and what a facility is made of.
 *
 * Kept apart from the simulation so the numbers that shape how the room feels —
 * how long someone lingers at the kitchen, how wide a pod grows — can be read and
 * tuned without scrolling past the machinery that uses them.
 */
import type { Facing, Pose } from '../characters.ts'
import type { Session } from '../data/types.ts'
import type { PropKind } from '../props.ts'

/** 4px tiles: a tile is TILE/2 terminal rows, so TILE must stay even or image
 *  placements drift half a tile against the drawn grid. At 4 a worker renders
 *  ~32x68 real pixels, matching the reference's 32x64. */
export const TILE = 4
export const CHAR_W = TILE
export const CHAR_H = TILE * 2

/** Monitor image box, in cells. Whatever blocks text must match what is drawn. */
export const MON_COLS = TILE
export const MON_ROWS = TILE / 2 + 2 // screen plus the desk surface beneath it

/**
 * Nameplate image box, in cells.
 *
 * Four of the eight free columns beside a pod — `seatProjects` always leaves two
 * tiles between pods, so the fourth costs nothing that was being used. Two fits
 * the 6x13 font's 11px ink band but leaves no room to double it, so on a large
 * terminal font the word stayed a hairline in a wide bar. Three doubles and
 * triples it. The fourth is what lets a short name keep growing: the strip's
 * WIDTH caps the scale, not its height, so at three columns `willow` was pinned
 * to 3x with half its plate empty even though the height allowed 5x.
 */
export const PLATE_COLS = 4
export const PLATE_ROWS = 3 * (TILE / 2)

/** The typing frames have no legs — 6 of 32 source rows are empty padding — so
 *  seated characters shift down by that fraction to put the body on the seat. */
export const SIT_SINK = Math.round((CHAR_H * 6) / 32)

export const WALK_TILES_PER_SEC = 3
export const TYPE_FRAME_SEC = 0.3
export const WALK_FRAME_SEC = 0.15
export const IDLE_PAUSE_MIN = 2
export const IDLE_PAUSE_MAX = 12
export const SEAT_REST_MIN = 20
export const SEAT_REST_MAX = 60
export const DONE_BUBBLE_SEC = 8
export const CHAT_RADIUS = 10
/** how long a screen stays lit after its session pauses between turns */
export const SCREEN_HOLD = 25_000
export const MAX_RUN = 6 // widest desk pod before a project spills into a second one

/**
 * The screen standing on each desk, in TILES.
 *
 * This is the room's whole purpose now: every desk shows its own session's live terminal,
 * so the layout is decided by how wide a screen has to be to be worth reading rather than
 * by how many desks can be crammed in.
 *
 * `h` of 3 is the floor. Text is drawn one character per canvas column and a tile is two
 * canvas ROWS tall, so a screen of h tiles carries `2h - 2` lines after its frame: h=3 is a
 * header and three lines, h=2 is a header and one.
 *
 * `widths` is tried widest-first and the first one that seats everybody wins — so a wide
 * window spends its space on readable screens and a narrow one on fitting everybody. A
 * screen of w tiles holds `4w - 6` characters: 14 at w=5, 26 at w=8, 42 at w=12.
 */
export const SCREEN = { h: 3, widths: [12, 10, 8, 6, 5, 4] } as const
/** Rows a band needs: the screen, the worktop, the seat, and an aisle to walk in. */
export const BAND = SCREEN.h + 3

export type Kind = 'void' | 'floor' | 'wall' | 'desk' | 'solid'
export type Dir = Facing
export type SpotKind = 'desk' | 'kitchen' | 'pingpong' | 'couch' | 'talk' | 'window'
export type Posture = 'sit' | 'stand'

/** A tile someone can occupy, and who currently holds it. */
export type Spot = {
	id: string
	kind: SpotKind
	group: string
	col: number
	row: number
	facing: Dir
	posture: Posture
	zone: string | null
	taken: string | null
}

export type Activity = { kind: SpotKind; spotId: string | null; partner: string | null; timer: number }

export type Character = {
	id: string
	state: 'idle' | 'walk' | 'type' | 'act'
	dir: Dir
	x: number
	y: number
	col: number
	row: number
	path: { col: number; row: number }[]
	progress: number
	frame: number
	frameTimer: number
	idleTimer: number
	seatTimer: number
	seatId: string | null
	activity: Activity | null
	wasWorking: boolean
	/** rolled a social urge and is waiting for the broker to find a partner */
	chatWanted: boolean
	bubble: 'permission' | 'done' | 'chat' | null
	bubbleTimer: number
}

/** One character resolved to a sprite and a pixel position, ready to draw. */
export type Placed = { s: Session; ch: Character; facing: Dir; pose: Pose; step: number; x: number; y: number }

/** A run of desks belonging to one project, with the rows its parts occupy. */
export type Pod = { proj: string; c0: number; c1: number; seatRow: number; deskRow: number; monitorRow: number }

/** How long someone stays, per facility. A ping-pong rally should outlast a coffee. */
export const DWELL: Record<SpotKind, [number, number]> = {
	desk: [0, 0],
	kitchen: [8, 20],
	pingpong: [30, 90],
	couch: [40, 120],
	talk: [15, 45],
	window: [10, 30],
}

/** Facilities as data: spots are walkable, blocked tiles are the furniture. */
export const FACILITIES: Record<
	string,
	{
		w: number
		h: number
		kind: SpotKind
		spots: [number, number, Dir, Posture][]
		/** furniture drawn as an image; `under` means the occupant sits on it */
		props: { kind: PropKind; dc: number; dr: number; under?: boolean }[]
	}
> = {
	kitchen: {
		w: 3,
		h: 2,
		kind: 'kitchen',
		spots: [
			[0, 0, 'down', 'stand'],
			[1, 0, 'down', 'stand'],
			[2, 0, 'down', 'stand'],
		],
		props: [{ kind: 'kitchen', dc: 0, dr: 1 }],
	},
	pingpong: {
		w: 4,
		h: 1,
		kind: 'pingpong',
		spots: [
			[0, 0, 'right', 'stand'],
			[3, 0, 'left', 'stand'],
		],
		props: [{ kind: 'pingpong', dc: 1, dr: 0 }],
	},
	couch: {
		w: 2,
		h: 2,
		kind: 'couch',
		spots: [
			[0, 0, 'down', 'sit'],
			[1, 0, 'down', 'sit'],
		],
		// the couch is UNDER its occupants; a low table sits in front of it
		props: [
			{ kind: 'couch', dc: 0, dr: 0, under: true },
			{ kind: 'lowtable', dc: 0, dr: 1 },
		],
	},
	talk: {
		w: 2,
		h: 1,
		kind: 'talk',
		spots: [
			[0, 0, 'right', 'stand'],
			[1, 0, 'left', 'stand'],
		],
		props: [],
	},
}

/** First to go when the room runs out of bands. */
export const DROP_ORDER = ['couch', 'pingpong', 'kitchen'] as const

/**
 * The wall display: one screen in the room showing a real session's terminal.
 *
 * Sized in TILES. Why one board and not a screen per desk: a desk is 8 canvas columns,
 * and both renderers draw one character per column, so a desk monitor holds EIGHT
 * characters — measured, in the terminal and the browser alike. Reaching a readable
 * width per desk would mean drawing at half the size of every other word in the room,
 * which the terminal cannot do at all. One board at room scale holds 42 columns in a
 * 90-column terminal and ~54 in the browser, which is a real viewport.
 *
 * WIDTH IS CAPPED BELOW THE ROOM'S. A full-width partition would cut the floor in two,
 * and `findPath` has no connectivity check — `office.test.ts` asserts every spot is
 * reachable from the door, and that test is the one that would catch it. Both ends stay
 * open by construction.
 *
 * ALL THREE NUMBERS ARE TILES. The terminal builds `new Canvas(cols, townRows * 2)` from
 * the terminal's own column count, so a 90-column terminal is a room about 22 tiles wide
 * — not 104. A threshold written in canvas columns would have dropped this board on every
 * real terminal there is, silently, because dropping is what it does when it does not
 * fit. 18 tiles leaves the 12-tile board a clear margin either side.
 */
/**
 * The wall display, in TILES — except `minGlass`, which is in characters.
 *
 * The minimum is stated as the width of the GLASS rather than of the room, because the
 * glass is the thing that either holds a line of terminal or does not. Stated as a room
 * width it demanded 18 tiles — a 73-column terminal — before it would place anything, and
 * a 68-column window got no board and no explanation. Thirty characters is the floor: a
 * 10-tile board carries 34, which is a readable line.
 */
export const BOARD = { w: 12, h: 3, minGlass: 30 } as const

/** Stable hash for anything that must look varied but never move between frames. */
export const hash = (s: string) => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

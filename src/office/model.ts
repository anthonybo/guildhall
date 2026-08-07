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
 * Three of the four free columns beside a pod. Two fits the 6x13 font's 11px ink
 * band but leaves no room to double it, so on a large terminal font the word
 * stayed a hairline in a wide bar. Three lets the glyphs scale with the cell.
 * One column only fits a 4px x-height and cannot be read at all.
 */
export const PLATE_COLS = 3
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

/** Stable hash for anything that must look varied but never move between frames. */
export const hash = (s: string) => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

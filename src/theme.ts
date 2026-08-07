/**
 * Colours. The status and gauge values come from headroom's PALETTE.md, which
 * has measured WCAG ratios against a dark terminal background.
 *
 * Two rules worth keeping: healthy states are low-energy rather than green, so
 * that colour means "look here" instead of meaning nothing; and bright-black is
 * only ever used for a gauge track, where shape carries the meaning, because
 * ANSI index 8 has no contrast guarantee across themes.
 */
import type { State } from './data.ts'

export type RGB = [number, number, number]

export const C = {
	// text
	label: [208, 208, 208] as RGB, // 10.72:1
	muted: [138, 138, 138] as RGB, // 4.79:1 — secondary text you actually read
	faint: [110, 118, 129] as RGB, // chrome that only has to be visible
	rule: [95, 95, 95] as RGB,
	gold: [255, 214, 92] as RGB,
	night: [26, 28, 40] as RGB,
	selBg: [48, 54, 78] as RGB,

	// gauge
	track: [68, 68, 68] as RGB,
	fillOk: [95, 175, 95] as RGB, // 6.13:1
	fillWarn: [215, 175, 95] as RGB, // 8.02:1
	fillHot: [255, 95, 95] as RGB, // 5.55:1

	// office interior
	floor: [72, 68, 88] as RGB,
	floorAlt: [66, 62, 82] as RGB,
	floorDark: [40, 38, 52] as RGB,
	wallStone: [96, 92, 118] as RGB,
	wallLip: [128, 122, 152] as RGB,
	deskTop: [138, 96, 62] as RGB,
	deskEdge: [104, 70, 44] as RGB,
	deskPaper: [232, 228, 214] as RGB,
	monitorCase: [40, 42, 54] as RGB,
	screenOn: [120, 226, 200] as RGB,
	// screen tint by what the session is doing, readable across the whole room
	screenEdit: [120, 170, 255] as RGB,
	screenRead: [110, 220, 235] as RGB,
	screenRun: [250, 180, 90] as RGB,
	screenSearch: [200, 160, 250] as RGB,
	screenAgent: [160, 235, 150] as RGB,
	screenOff: [58, 62, 78] as RGB,
	counter: [188, 176, 152] as RGB,
	counterEdge: [140, 128, 108] as RGB,
	tableTop: [96, 132, 108] as RGB,
	tableEdge: [64, 96, 76] as RGB,
	couch: [122, 108, 156] as RGB,
	couchEdge: [88, 76, 116] as RGB,

	// town (kept for the older renderer)
	grass: [104, 176, 96] as RGB,
	grassDk: [80, 152, 80] as RGB,
	grassLt: [128, 196, 112] as RGB,
	path: [232, 208, 152] as RGB,
	pathDk: [212, 184, 128] as RGB,
	pathEdge: [166, 128, 84] as RGB,
	wall: [246, 236, 208] as RGB,
	wallSh: [214, 200, 172] as RGB,
	door: [150, 98, 62] as RGB,
	doorDk: [110, 70, 44] as RGB,
	window: [126, 196, 236] as RGB,
	windowFrame: [250, 250, 250] as RGB,
	tree: [56, 128, 64] as RGB,
	treeDk: [38, 96, 50] as RGB,
	trunk: [110, 78, 48] as RGB,
	sign: [186, 140, 88] as RGB,
	signPost: [128, 92, 56] as RGB,
	paper: [252, 250, 244] as RGB,
	ink: [32, 34, 46] as RGB,
} as const

/**
 * Status carries three channels at once — glyph, word and colour — so it still
 * reads with colour stripped, piped, or by a colourblind viewer.
 * Glyphs are all East-Asian-Neutral or geometric; nothing here has an emoji
 * presentation or a variation selector, both of which shift column widths.
 */
/** Level tiers, coloured like ranks. The chip on a character is one cell, so the
 *  colour does the work and the digit only refines it. */
/**
 * A geometric ladder: each tier is roughly 2.4x the work of the one below, which
 * on a cube-root curve is an even step in level. Spacing them evenly in *levels*
 * instead would make the low tiers unreachably fast and the high ones static.
 *
 * Ten tiers, because a ladder that ran out at level 9 painted every serious
 * session the same colour — the exact failure this is here to avoid.
 */
export const TIERS: { min: number; color: RGB; name: string }[] = [
	{ min: 1, color: [150, 158, 185], name: 'new' },
	{ min: 5, color: [130, 190, 140], name: 'steady' },
	{ min: 8, color: [110, 200, 190], name: 'seasoned' },
	{ min: 11, color: [110, 200, 240], name: 'skilled' },
	{ min: 15, color: [120, 170, 250], name: 'veteran' },
	{ min: 20, color: [165, 150, 250], name: 'expert' },
	{ min: 27, color: [215, 140, 235], name: 'elder' },
	{ min: 37, color: [250, 150, 160], name: 'master' },
	{ min: 50, color: [255, 180, 100], name: 'legend' },
	{ min: 68, color: [255, 225, 130], name: 'mythic' },
]
export const tierOf = (level: number) => TIERS.filter((t) => level >= t.min).pop() ?? TIERS[0]
/** The number, always. The old star capped the scale at 9 and made every serious
 *  session look identical. */
export const levelGlyph = (level: number) => String(Math.max(1, Math.min(99, level)))
export const tierName = (level: number) => tierOf(level).name

export const LOOK: Record<State, { glyph: string; label: string; color: RGB }> = {
	error: { glyph: '✗', label: 'error', color: [255, 95, 95] },
	review: { glyph: '◆', label: 'unread', color: [140, 210, 255] },
	needs: { glyph: '▲', label: 'needs you', color: [255, 176, 60] },
	// amber is reserved for "your turn" everywhere else in the Claude tooling, so
	// working takes the cool colour its own lit screen already uses
	working: { glyph: '●', label: 'working', color: [120, 226, 200] },
	shell: { glyph: '◍', label: 'shell', color: [95, 175, 215] },
	// healthy and finished: deliberately cool and quiet, not green
	done: { glyph: '○', label: 'your turn', color: [135, 206, 250] },
	parked: { glyph: '·', label: 'parked', color: [138, 138, 138] },
}

/** Twelve hues spaced around the wheel, so a dozen projects can each have their
 *  own without two reading as the same colour. */
export const ROOFS: RGB[] = [
	[228, 96, 92],
	[240, 148, 64],
	[236, 200, 84],
	[176, 208, 88],
	[112, 200, 112],
	[96, 206, 176],
	[96, 190, 228],
	[110, 150, 238],
	[152, 130, 236],
	[200, 124, 224],
	[236, 120, 176],
	[196, 152, 116],
]

/* ── ansi ── */
export const R = '\x1b[0m'
export const fg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`
export const bg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`
export const bold = '\x1b[1m'

export const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
export const width = (s: string) => [...plain(s)].length
export const padR = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
export const padL = (s: string, n: number) => ' '.repeat(Math.max(0, n - width(s))) + s

/** Truncate to n visible columns, preserving escape sequences. */
export function clip(s: string, n: number) {
	let out = ''
	let seen = 0
	for (let i = 0; i < s.length; ) {
		if (s[i] === '\x1b') {
			const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
			if (m) {
				out += m[0]
				i += m[0].length
				continue
			}
		}
		if (seen >= n) return out + R
		out += s[i]
		seen++
		i++
	}
	return out
}

/**
 * Sub-cell gauge. Whole-cell bars collapse 88% and 94% into the same reading and
 * show 94% as completely full — disqualifying for a column whose only job is
 * predicting when a session will compact.
 */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export function gauge(frac: number, cells: number) {
	const total = Math.round(Math.max(0, Math.min(1, frac)) * cells * 8)
	const full = Math.floor(total / 8)
	let rem = total % 8
	// any non-zero usage must be visible, or 2% looks identical to empty
	if (frac > 0 && full === 0 && rem === 0) rem = 1
	const color = frac > 0.9 ? C.fillHot : frac >= 0.7 ? C.fillWarn : C.fillOk
	const filled = '█'.repeat(full) + EIGHTHS[rem]
	const empty = '░'.repeat(Math.max(0, cells - full - (rem ? 1 : 0)))
	return `${fg(color)}${filled}${fg(C.track)}${empty}${R}`
}

/** Fixed-width, never jittering, so the neighbouring column cannot shift. */
export function ago(ms: number) {
	const s = Math.floor(ms / 1000)
	if (s < 10) return 'now'
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h`
	const d = Math.floor(h / 24)
	return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`
}

export const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/**
 * Colours. The status and gauge values come from foxglove's PALETTE.md, which
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
	screenOff: [58, 62, 78] as RGB,

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
export const LOOK: Record<State, { glyph: string; label: string; color: RGB }> = {
	needs: { glyph: '▲', label: 'needs you', color: [255, 95, 95] },
	working: { glyph: '●', label: 'working', color: [255, 175, 95] },
	shell: { glyph: '◍', label: 'shell', color: [95, 175, 215] },
	// healthy and finished: deliberately cool and quiet, not green
	done: { glyph: '○', label: 'your turn', color: [135, 206, 250] },
	parked: { glyph: '·', label: 'parked', color: [138, 138, 138] },
}

export const ROOFS: RGB[] = [
	[224, 96, 84],
	[236, 152, 60],
	[104, 168, 220],
	[128, 196, 116],
	[196, 128, 208],
	[240, 196, 84],
	[110, 200, 196],
	[228, 128, 156],
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

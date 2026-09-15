/**
 * The wall of terminals: every active session's real screen, as text, all at once.
 *
 * WHY THIS EXISTS RATHER THAN A SCREEN PER DESK. Putting a readable terminal on each desk
 * monitor was tried and does not fit, and the arithmetic is not close. A monitor's screen
 * is about 58 grid pixels across; the 3x5 pixel font needs 3 of them per character, so a
 * desk shows 19 characters — a fragment of a line. Measured across seven live sessions the
 * median cleaned line is 65 characters. Reaching that per desk needs roughly eight tiles
 * of monitor, which is half the width of a 68-column room for ONE desk.
 *
 * A minimap was tried next — real line lengths and colours as bars, which is honest data
 * at that size. It was reported as "looks the exact same", and that is correct: at eleven
 * pixels of screen, real content and invented content are indistinguishable. Making the
 * data true without making it visible is not worth anything.
 *
 * So the terminals go where there is room for them: full width, stacked. At 68 columns
 * that is 65 characters per line, which fits 60% of real lines whole against 17% at the
 * two-column layout the same measurement ruled out.
 */
import { cut } from './data/describe.ts'
import { RANK, type Session } from './data/types.ts'
import { C, LOOK, fg } from './theme.ts'

const RESET = '\x1b[0m'
/** Colour is applied AFTER cutting, never before: `cut` counts characters, and an escape
 *  sequence inside the string would be counted as content and the line would come out
 *  short by exactly the length of the escape. */
const paint = (s: string, c: (typeof C)['gold']) => `${fg(c)}${s}${RESET}`

/** A session's screen, however the caller gets one. Passed in so this file never spends a
 *  cmux process and can be tested with no cmux on the machine. */
export type ScreenOf = (s: Session) => { lines: string[]; reading: boolean; error?: string }

/** Chrome per pane: one header line and one rule between panes. */
const OVERHEAD = 2
/** Below this a pane says nothing a table row does not already say. */
const MIN_BODY = 2

/**
 * Which sessions get a pane.
 *
 * The ask was "all the terminals that are ACTIVE", and that word is doing real work: a
 * pane each for seven sessions when two are running spends most of the screen on stopped
 * ones. Anything working, blocked on you, or holding output you have not read is active;
 * parked sessions are listed by the table below and are one keystroke away.
 *
 * `all` overrides it, because a promise that you can see everything is worth keeping.
 */
export function paneFor(list: Session[], all: boolean): Session[] {
	const withTab = list.filter((s) => s.workspace)
	const picked = all ? withTab : withTab.filter((s) => s.state === 'working' || s.state === 'needs' || s.state === 'review' || s.state === 'error')
	// BY STATE, not by `order()`, which is what the table uses. The table sorts most-idle
	// first — correct there, since it is a log you read downward — and it put four parked
	// sessions above the two that were running. Here the panes that fit have to be the ones
	// worth having, so it is state first and least-idle within a state.
	return (picked.length ? picked : withTab).slice().sort((a, b) => RANK[a.state] - RANK[b.state] || a.stale - b.stale || a.proj.localeCompare(b.proj))
}

/**
 * Lay the wall out.
 *
 * Every pane gets an equal share, and the remainder goes to the FIRST panes rather than
 * being dropped — with 7 panes in 47 rows the difference is a line each for five of them,
 * which at four lines a pane is a quarter more terminal.
 */
export function wall(list: Session[], cols: number, rows: number, screenOf: ScreenOf, all = false): string[] {
	const picked = paneFor(list, all)
	if (!picked.length) return ['', '  no session has a terminal to show', '', '  A session needs a cmux tab before its screen can be read.']
	// How many panes actually fit. Showing eight panes of one line each is worse than
	// showing four of four, so panes are dropped until the rest have something to say.
	let n = picked.length
	while (n > 1 && Math.floor(rows / n) < OVERHEAD + MIN_BODY) n--
	const shown = picked.slice(0, n)
	const share = Math.floor(rows / n)
	const spare = rows - share * n

	const out: string[] = []
	for (const [i, s] of shown.entries()) {
		const height = share + (i < spare ? 1 : 0)
		const body = height - OVERHEAD
		const scr = screenOf(s)
		out.push(head(s, cols))
		const lines = scr.lines.length ? scr.lines.slice(-body) : [scr.error ? `⚠ ${scr.error}` : scr.reading ? 'reading the screen…' : 'nothing on screen yet']
		// Bottom-aligned, so the newest line of every pane sits just above its rule and the
		// eye finds them all in the same place down the column.
		const pad = body - lines.length
		for (let j = 0; j < body; j++) {
			const line = lines[j - pad]
			out.push(line === undefined ? '' : paint(`  ${cut(line, cols - 2)}`, scr.lines.length ? C.label : C.faint))
		}
		out.push(paint('─'.repeat(Math.max(0, cols)), C.wallStone))
	}
	// The last rule is the bottom of the last pane, and the table follows it — but if the
	// wall owns the whole screen there is nothing below, so it is one wasted row.
	if (out.length > rows) out.length = rows
	// One line saying what is NOT on the wall, because a count that silently drops sessions
	// is the failure this project keeps rediscovering.
	if (shown.length < picked.length && out.length) out[out.length - 1] = paint(cut(`  ${picked.length - shown.length} more session${picked.length - shown.length === 1 ? '' : 's'} did not fit — a taller window shows them`, cols), C.faint)
	return out
}

/** Whose terminal this is, and how it is doing. */
function head(s: Session, cols: number): string {
	const look = LOOK[s.state]
	const tab = s.tab ? `⌘${s.tab}` : s.agent === 'codex' ? 'cx' : '  '
	const left = `${tab} ${s.proj}`
	const right = `${look.glyph} ${look.label}`
	const gap = Math.max(1, cols - left.length - right.length)
	// The state colour on the header is the whole reason this is scannable: one pane
	// turning amber down a column of seven is what tells you where to look.
	return paint(cut(left + ' '.repeat(gap) + right, cols), look.color)
}

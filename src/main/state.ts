/**
 * What the room is showing and who is in it: the view, the selection, the sessions,
 * and the office that places them — plus the layout and the animation step that move it.
 */
import { needsAttention, order, type Session } from '../data.ts'
import { Canvas } from '../canvas.ts'
import { Office } from '../office.ts'
import { OUT } from './screen.ts'
import { draw } from './draw.ts'

/* ── state ── */
export type Mode = 'town' | 'split' | 'table' | 'screens'
export let mode: Mode = 'split'
export let faultsOnly = false
/**
 * The desk-screens room: every desk carries a screen showing its own live terminal.
 *
 * OFF by default and toggled with `m`. It is a different room — a different pitch, no
 * project nameplates, no monitor sprites — so it is a view you choose rather than a change
 * to the one that was already there. The layout lives in office/desks.ts.
 */
export let deskScreens = false
/** All labels on, or only the ones that need you plus the selection. */
export let labels = true

// Written from the key handler and the polls, which an import cannot assign to.
export function setMode(next: Mode) {
	mode = next
}
export function setFaultsOnly(on: boolean) {
	faultsOnly = on
}
export function setDeskScreens(on: boolean) {
	deskScreens = on
}
export function setLabels(on: boolean) {
	labels = on
}
export function setSessions(next: Session[]) {
	sessions = next
}

export let selectedId: string | null = null
/** table rows opened with →, so their detail shows under them */
export const expanded = new Set<string>()
export let sessions: Session[] = []

// The office owns the characters' positions, so it is created once and refitted
// — never rebuilt — or everyone would jump back to the doorway.
export const office = new Office()
export let cv = new Canvas(80, 40)
export let geom = { cols: 0, rows: 0, townRows: 0, tableRows: 0, deskScreens: false }
let lastTick = 0
export let screenFrame = 0
let screenClock = 0
/** A stalled event loop must not teleport anyone across the room. */
const MAX_DT = 0.25

export const visible = () => (faultsOnly ? sessions.filter((s) => needsAttention(s)) : sessions)

export function moveSelection(delta: number) {
	const list = order(visible())
	if (!list.length) return
	const at = list.findIndex((s) => s.id === selectedId)
	const i = at < 0 ? 0 : at
	// hold the session, not the row index: rows can move, the session you were
	// reading does not
	selectedId = list[Math.min(list.length - 1, Math.max(0, i + delta))].id
}

/**
 * Terminal size, or what the caller says it is.
 *
 * `OUT.columns` is undefined whenever stdout is not a TTY — piped into a file, a
 * renderer, or a pager — and silently falling back to 90x44 meant a piped run
 * ignored the size it was asked for. COLUMNS/LINES are the conventional way to
 * say it, and honouring them is what makes the documentation images
 * reproducible at a chosen width.
 */
const sizeOf = (tty: number | undefined, env: string | undefined, fallback: number) =>
	tty ?? (Number(env) > 0 ? Number(env) : fallback)

/** Recompute geometry and re-place creatures. Safe to call as often as you like. */
export function layout() {
	/**
	 * Never wider than the terminal actually is.
	 *
	 * The floor here was 46, which meant a pane narrower than that got 46-column lines
	 * drawn into it and every one of them wrapped — the header's last badge landing on
	 * a second row, the table rows folding, the whole thing reading as a rendering
	 * fault rather than as a small window. Reported from a laptop with a smaller
	 * screen, and reproduced at 36 columns, where the header overflowed by 4.
	 *
	 * The floor was also unnecessary. Every renderer here already narrows: the table
	 * drops its context gauge and shortens project names, the room packs desks into
	 * more rows, and the header's badge ladder sheds badges. Measured at 44, 40, 34,
	 * 28, 22 and 20 columns, nothing throws and no line exceeds the width it was given.
	 *
	 * 20 is kept as a floor only to stop the arithmetic going degenerate; a terminal
	 * that narrow has bigger problems than this program.
	 */
	const cols = Math.max(20, sizeOf(OUT.columns, process.env.COLUMNS, 90) - 1)
	const rows = Math.max(14, sizeOf(OUT.rows, process.env.LINES, 44) - 2)
	const list = visible()
	if (!selectedId || !list.some((s) => s.id === selectedId)) selectedId = order(list)[0]?.id ?? null

	// the town is the hero, so the table is capped at roughly a third and the
	// town keeps the rest; press tab for a full-screen table when you want detail
	const wantTable = Math.min(list.length + 4, Math.max(6, Math.floor(rows * 0.34)))
	const tableRows = mode === 'town' || mode === 'screens' ? 0 : mode === 'table' ? rows : wantTable
	const townRows = rows - tableRows

	/**
	 * Re-plan on a size change OR a view change.
	 *
	 * The view was missing from this condition, so pressing `m` set the flag, redrew, and
	 * changed nothing: `fit` is the only thing that plans a room and it was never reached.
	 * `fit` has its own signature guard, so calling it when nothing has actually changed
	 * costs a string compare — the reason to name the view here rather than to widen that.
	 */
	if (cols !== geom.cols || townRows !== geom.townRows || deskScreens !== geom.deskScreens) {
		cv = new Canvas(cols, Math.max(2, townRows) * 2)
		// Only the desk-screens view wants a screen footprint per desk; the classic room is
		// the default and is planned exactly as it always was.
		office.fit(cv.w, cv.h, list, deskScreens)
	}
	geom = { cols, rows, townRows, tableRows, deskScreens }
	office.assign(list)
	// Only the first time. A re-layout must never re-settle: it would teleport
	// everyone mid-stride every time the window changed size.
	if (!settled && list.length) {
		settled = true
		office.settle(list)
	}
}
let settled = false

/** One simulation step, then redraw. Only the animation timer calls this. */
export function animate() {
	const now = Date.now()
	const dt = lastTick ? Math.min((now - lastTick) / 1000, MAX_DT) : 0
	lastTick = now
	office.update(dt, visible())
	screenClock += dt
	if (screenClock > 0.45) {
		screenClock = 0
		screenFrame++
	}
	draw()
}

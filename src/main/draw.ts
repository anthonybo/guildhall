/**
 * Turning the current state into a frame: the help panel, or the room (as half-blocks
 * or images, or as the wall of terminals) with the table, the remote-send line and the
 * header and footer around it.
 */
import { mixedHarness, type Session } from '../data.ts'
import { drawBoard } from '../board.ts'
import { glance, keepOnly } from '../peek.ts'
import { paneFor, wall } from '../wall.ts'
import { CHAR_H, CHAR_W, TILE } from '../office.ts'
import { frameOf, shrink } from '../characters.ts'
import { badgeFor, harnessColor, monitorFor } from '../screens.ts'
import { logo } from '../logos.ts'
import { tierOf } from '../theme.ts'
import { PROP_SIZE, prop } from '../props.ts'
import * as T from '../table.ts'
import * as H from '../help.ts'
import * as awake from '../awake.ts'
import { build } from '../version.ts'
import { addresses } from '../serve.ts'
import { passcode } from '../auth.ts'
import { hasControlPass } from '../controlauth.ts'
import { othersNote } from '../servers.ts'
import { IMAGES, cfg } from './run.ts'
import { paint } from './screen.ts'
import { LEVEL_LOOK, drawDeskScreens, drawImages, drawMonitors, drawPlates, drawProps, resetSentinel } from './images.ts'
import { remoteLog, serveError, serveHandover, server } from './serving.ts'
import { ctlNote, ctlPass, helpOpen, helpScroll, pin, pinNote, portEntry, portNote, showHelp } from './keys.ts'
import { cv, deskScreens, expanded, faultsOnly, geom, labels, mode, office, screenFrame, selectedId, sessions, visible } from './state.ts'

/**
 * What the help panel is told about sharing and control.
 *
 * Built here rather than inline at the draw call because the key handler needs
 * the same values to work out how far the panel can scroll. Two copies of this
 * would drift, and the symptom would be a scroll limit that does not match the
 * panel it is limiting.
 */
export const shareInfo = () => {
	const net = addresses()
	// `others()` is a directory read and a few kill(0) calls — microseconds — so it is
	// recomputed here on every draw rather than cached. The lsof version cost 90 cpu-ms,
	// which is what a registry exists to avoid; see src/servers.ts.
	return { on: !!server, port: cfg.port, token: passcode(), lan: net.lan, vpn: net.vpn, pin, pinNote, portEntry, portNote, others: othersNote() }
}
export const controlInfo = () => ({ on: cfg.control, isSet: hasControlPass(), typing: ctlPass, note: ctlNote })
export const envInfo = () => ({ awakeArmed: awake.isArmed(), awakeHolding: awake.isHolding(), awakeAlways: awake.isAlways(), labels: cfg.labels, codex: cfg.codex })

/** Render the current state. Draws only — advancing the animation is separate. */
export function draw() {
	const { cols, rows, townRows, tableRows } = geom
	if (showHelp) {
		// No image layer at all while this is up. Kitty images always draw above
		// text, so a panel with sprites still placed would have characters walking
		// across the sentence explaining them.
		// While something is being typed, the bottom row carries the prompt instead
		// of the footer.
		//
		// The panel is taller than a short terminal, so anything inside it can be
		// scrolled off — which is why ↑↓ now scroll it rather than dismiss it. Even
		// so, anything it needs you to DO stays on the bottom row: a key you cannot
		// see is a key you will never press, and control armed with no password is
		// exactly that case.
		const needsPass = cfg.control && !hasControlPass()
		const entry =
			ctlPass !== null
				? T.promptLine('control password', ctlPass.length, ctlNote, cols)
				: pin !== null
					? T.promptLine('new passcode', pin.length, pinNote, cols)
					: needsPass
						? T.hintLine('control is on but has no password — press c to set one', cols)
						: null
		paint(
			[
				...H.panel(cols, rows + 1, shareInfo(), controlInfo(), helpScroll, envInfo(), helpOpen),
				entry ?? T.footer(cols, 0, faultsOnly, mode, { armed: awake.isArmed(), holding: awake.isHolding(), always: awake.isAlways() }),
			],
			'',
		)
		return
	}
	const list = visible()
	let townLines: string[] = []
	let images = ''
	resetSentinel()
	if (mode === 'screens') {
		/**
		 * The wall of terminals, which is text and nothing else.
		 *
		 * No canvas and no images: this view is the one that has to show real lines of real
		 * terminal, and a kitty image drawn over text is exactly what would cover them. It
		 * also means the view works in a terminal with no image support at all.
		 *
		 * `wallScreens` is what spends the cmux processes, and it spends them only for the
		 * sessions with a pane on screen — see peek.ts for why that matters.
		 */
		townLines = wall(list, cols, townRows, wallScreens(list, true), true)
	} else if (townRows > 0) {
		// set before draw(), which is what decides whether to emit plate placements
		office.vertical = cfg.labels === 'vertical' && IMAGES
		const placed = office.draw(cv, list)
		// Workspaces whose screen is on the wall this frame, so `keepOnly` can forget the rest.
		const watched: string[] = []
		if (!IMAGES)
			for (const p of placed) {
				const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color)
				cv.blit(p.x, p.y, shrink(g, CHAR_W, CHAR_H))
			}
		office.overlay(cv, placed, selectedId ?? undefined, labels)
		/**
		 * The wall display, BEFORE `cv.render()`.
		 *
		 * This sat twenty lines below, after the canvas had already been serialized into
		 * strings, so every cell it wrote was discarded and `office.draw()`'s `cv.clear()`
		 * wiped the overlay on the next frame. The board was never on screen once.
		 *
		 * It looked as though it worked because the scratch harness read `cv.overlay`
		 * directly after calling this — one step past where the frame was already turned
		 * into text. That is `$?` after a pipe, with a canvas: a real reading answering a
		 * different question. Confirm this one by looking for the text in what the app
		 * PRINTS, never in the canvas it printed from.
		 */
		/**
		 * EVERY DESK'S OWN TERMINAL, on the screen standing on it.
		 *
		 * This replaced a single wall display showing one auto-picked session, which was
		 * reported — three times — as a random big screen in the middle of the room. The ask
		 * was always each monitor showing its own session, and the reason it took three tries
		 * is that the desks were two tiles apart: eight canvas columns, and text is one
		 * character per column. The room's pitch is now a screen wide, so there is something
		 * to read on each one.
		 */
		// ONLY without image support. With it, `drawDeskScreens` draws the same screens in a
		// font measured in pixels rather than in cells — and kitty draws images over text, so
		// this would be terminal-sized text rendered underneath a picture that hides it.
		const byId = new Map(list.map((s) => [s.id, s]))
		if (!IMAGES)
			for (const sc of office.screens) {
				const s = sc.id ? byId.get(sc.id) : undefined
				// A token that moves when the session does — see peek.ts.
				const screen = s?.workspace ? glance(s.workspace, `${s.turns}:${s.ctxUsed}:${s.doing}`) : null
				drawBoard(cv, sc, TILE, s, screen, true)
				if (s?.workspace) watched.push(s.workspace)
			}
		townLines = cv.render()
		// furniture first, then monitors, then people on top of both
		if (IMAGES) images = drawProps() + drawPlates() + drawMonitors() + drawImages(placed) + drawDeskScreens(list, watched)
		else {
			for (const pr of office.props) {
				const size = PROP_SIZE[pr.kind]
				cv.blit(pr.x, pr.y, shrink(prop(pr.kind), size.w * TILE, size.h * TILE))
			}
			for (const m of office.monitors) cv.blit(m.x, m.y, shrink(monitorFor(m, screenFrame), CHAR_W, CHAR_W))
			for (const b of office.badges) cv.blit(b.x, b.y, shrink(badgeFor(b, LEVEL_LOOK), TILE, TILE))
			for (const l of office.logos) cv.blit(l.x, l.y, shrink(logo(l.agent, harnessColor(l.agent)), TILE, TILE))
		}
		// Forget workspaces nothing on screen is reading. AFTER both draw paths, because
		// each adds its own: pruning before the images pass would drop every screen's
		// session on the frame it was read and re-read it on the next, which is a cmux
		// process per frame for a cache that never hits.
		keepOnly(watched)
	}

	const body: string[] = [...townLines]
	if (tableRows > 0) {
		// the room's own project colours, so a row and its carpet upstairs match
		const rowsOut = T.rows(list, cols, selectedId ?? undefined, (p) => office.colourOf(p), expanded)
		const sel = rowsOut.find((r) => r.s.id === selectedId)?.s
		const det = T.detail(sel, cols)
		body.push(T.header(cols, mixedHarness(sessions)))
		// An expanded row brings its detail with it, and the whole thing still has to
		// fit the space the table was given. Count the lines WE add — `body` already
		// holds the whole room, so budgeting against its length skipped every row.
		const budget = Math.max(0, tableRows - 3)
		let used = 0
		for (const r of rowsOut) {
			if (used >= budget) break
			body.push(r.line)
			used++
			for (const e of r.extra ?? []) {
				if (used >= budget) break
				body.push(e)
				used++
			}
		}
		while (body.length < townRows + tableRows - 2) body.push('')
		body.push(...det)
	}
	// The newest remote send, on this machine's own screen. It takes a row from
	// the room rather than being tucked somewhere quiet: the whole reason it
	// exists is that somebody typing here from a phone must be impossible to miss.
	const remote = cfg.control && remoteLog.length ? T.remoteLine(remoteLog[0], cols) : null
	if (remote) body.pop()
	while (body.length < rows) body.push('')
	const awakeState = { armed: awake.isArmed(), holding: awake.isHolding(), always: awake.isAlways() }
	// `server.listening`, not `!!server`: a socket that exists but has not bound yet is
	// not sharing, and reporting it as such is the other half of the flash above.
	const shareState = { on: !!server?.listening, port: cfg.port, error: serveError, handover: serveHandover }
	paint(
		[
			// build(), not the default frozen BUILD: this process is often left running
			// for days across releases, and the header is exactly where you look to ask
			// "is this the thing I just built?"
			T.summary(sessions, cols, awakeState, build(), shareState),
			...body.slice(0, rows - (remote ? 1 : 0)),
			...(remote ? [remote] : []),
			T.footer(cols, office.hiddenCount, faultsOnly, mode, awakeState, deskScreens),
		],
		images,
	)
}

/**
 * The screen lookup the wall draws from, and the only place it spends anything.
 *
 * Built once per frame rather than per pane so `keepOnly` sees exactly the set that has a
 * pane — a session that scrolls off the wall stops being read on the same frame it stops
 * being shown.
 */
function wallScreens(list: Session[], all: boolean) {
	const shown = paneFor(list, all)
	keepOnly(shown.flatMap((s) => (s.workspace ? [s.workspace] : [])))
	return (s: Session) => (s.workspace ? glance(s.workspace, `${s.turns}:${s.ctxUsed}:${s.doing}`) : { lines: [], reading: false })
}

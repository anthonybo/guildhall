#!/usr/bin/env node
/**
 * guildhall — every live Claude Code session as a pixel town, in a terminal.
 *
 * Read-only. It watches the sessions you already run (in cmux or anywhere else)
 * and never launches or modifies one. The only thing it writes is a cmux
 * "focus this tab" request, and only when you press enter.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
	clearAll,
	WATCH_OFF,
	WATCH_ON,
	clearPlacements,
	demux,
	cursorTo,
	encodePNG,
	place,
	supportsImages,
	cellFrom,
	DEFAULT_CELL,
	SYNC_END,
	SYNC_START,
	transmit,
	upscale,
} from './kitty.ts'
import { collect as collectReal, needsAttention, order, type Session } from './data.ts'
import { demoSessions } from './demo.ts'
import { Canvas } from './canvas.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, Office, TILE, type Placed } from './office.ts'
import { frameOf, shrink } from './characters.ts'
import { loadSheets } from './sheets.ts'
import { badge, monitor } from './screens.ts'
import { C, LOOK, tierOf } from './theme.ts'
import { PROP_SIZE, prop } from './props.ts'
import * as T from './table.ts'
import * as H from './help.ts'
import * as awake from './awake.ts'
import { BUILD } from './version.ts'
import * as cfgStore from './config.ts'
import { addresses, createServer } from './serve.ts'
import { choose, plate } from './nameplate.ts'
import { PLATE_COLS, PLATE_ROWS } from './office/model.ts'
import { passcode, setPasscode } from './auth.ts'
import { hasControlPass, setControlPass } from './controlauth.ts'
import * as update from './update.ts'
import { CMUX } from './data/cmux-bin.ts'

if (process.argv.includes('--version') || process.argv.includes('-v')) {
	console.log(BUILD)
	process.exit(0)
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(`guildhall ${BUILD} — every live Claude Code session as a pixel office

  guildhall              watch the room
  guildhall --guard      headless: hold sleep off while sessions work, draw nothing
  guildhall --once       print one frame and exit
  guildhall --no-awake   start with the sleep hold disarmed
  guildhall --serve      share read-only over the network (off by default)
  guildhall --no-serve   force sharing off for this run

keys   ? help · s share · ↑↓ move · ⏎ jump to tab · f faults · l labels · a awake · tab view · r redraw · q quit
env    GUILDHALL_CMUX    path to the cmux binary
       GUILDHALL_NO_IMAGES  force half-block rendering`)
	process.exit(0)
}

const ONCE = process.argv.includes('--once')
const BENCH = process.argv.includes('--bench')
/**
 * Headless: hold sleep off for working sessions and draw nothing.
 *
 * The room only protects the machine while it is on screen, which is the wrong
 * shape for the job — a build runs longest exactly when nobody is watching a
 * dashboard. This mode is what you leave running (or hand to a LaunchAgent).
 */
const GUARD = process.argv.includes('--guard')
/** A fictional office, for documentation and for looking at this with nothing
 *  running. Never touches the real registry. */
const DEMO = process.argv.includes('--demo')
const collect = () => (DEMO ? demoSessions() : collectReal())
/**
 * Sharing is off unless it was turned on deliberately, and the choice persists.
 * `--serve` / `--no-serve` override the stored setting for one run.
 */
const cfg = cfgStore.load()
if (process.argv.includes('--serve')) cfg.serve = true
if (process.argv.includes('--no-serve')) cfg.serve = false
const portArg = process.argv.indexOf('--port')
if (portArg > 0) cfg.port = Number(process.argv[portArg + 1]) || cfg.port

let server: import('node:http').Server | null = null
let serveError = ''
/**
 * What a remote device has typed into this machine, newest first.
 *
 * Shown in the footer while control is armed. A remote caller that can act here
 * must not be able to act invisibly, and the machine's own screen is the one
 * place the person who owns it is certain to be looking.
 */
const remoteLog: { at: number; proj: string; text: string; ok: boolean }[] = []

/** Start or stop the listener to match the setting. Returns what happened. */
function syncServe() {
	if (cfg.serve === !!server) return
	if (!cfg.serve) {
		server?.close()
		server = null
		return
	}
	try {
		server = createServer({
			port: cfg.port,
			host: cfg.host,
			demo: DEMO,
			// read at call time, so toggling control in the running app takes effect
			// at once rather than at the next restart
			control: () => cfg.control,
			onSend: (proj, text, ok) => {
				// Every remote send is announced here. Somebody typing into this
				// machine from a phone must not be able to do it without it appearing
				// on the machine's own screen.
				remoteLog.unshift({ at: Date.now(), proj, text, ok })
				remoteLog.length = Math.min(remoteLog.length, 20)
				draw()
			},
		})
		server.on('error', (e: NodeJS.ErrnoException) => {
			serveError = e.code === 'EADDRINUSE' ? `port ${cfg.port} in use` : (e.code ?? 'failed')
			server = null
			cfg.serve = false
		})
		server.listen(cfg.port, cfg.host)
		serveError = ''
	} catch {
		server = null
		cfg.serve = false
		serveError = 'failed to start'
	}
}
const IMAGES = supportsImages() && !ONCE && !BENCH && !GUARD
// observing should not change the machine's behaviour unless asked, but holding
// sleep off while a build runs is the common case, so it is on unless refused
// --once and --bench never hold anything; --demo arms it purely so the
// documentation image shows the state you actually run in, and the demo never
// reaches sync() to spawn anything
awake.configure(!process.argv.includes('--no-awake') && !BENCH && (!ONCE || DEMO), cfg.awakeDisplay)


/* ── sprites: transmit each creature once, then place it by id every frame ── */
const imageIds = new Map<string, number>()
/** ids we have already sent the pixels for. Cleared to force a re-transmit; the
 *  id itself never changes, so the terminal replaces an image rather than
 *  accumulating thousands and evicting the ones still in use. */
const sent = new Set<number>()
let nextId = 1000

/** One placement per frame goes out un-silenced so the terminal can report a
 *  missing image. It has to be whichever is drawn first, not a particular class:
 *  hanging it off the first monitor meant no sentinel at all in a room with none. */
/** Real pixels per cell, as reported by the terminal. Plates are authored at
 *  exactly this size: kitty and Ghostty bilinear-filter images, so anything
 *  bigger gets averaged on the way down and 1px stems wash out to grey. */
let cell = { ...DEFAULT_CELL }

let sentinelUsed = false
const loudOnce = () => (sentinelUsed ? false : ((sentinelUsed = true), true))

/** Get this key's stable id, and whether its pixels still need sending. */
function idFor(key: string) {
	let id = imageIds.get(key)
	if (!id) {
		id = nextId++
		imageIds.set(key, id)
	}
	const fresh = !sent.has(id)
	sent.add(id)
	return { id, fresh }
}
function ensureTransmitted(p: Placed, pre: string[]) {
	const key = `${p.s.palette}:${p.s.hueShift}:${p.facing}:${p.pose}:${p.step}:${p.s.level}`
	// via idFor, so a cleared `sent` re-sends the pixels. Returning early on a known
	// id meant characters were transmitted exactly once per process: when the
	// terminal dropped its image store, furniture healed on the next sweep and the
	// sprites stayed dangling ids forever, which is the bug you kept seeing.
	const { id, fresh } = idFor(key)
	if (!fresh) return id
	const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color)
	// nearest-neighbour 4x so the terminal has real pixels to scale from
	// 2x, not 4x: a 4x source made the terminal DOWNSCALE into the placement box,
	// which is a fractional resample and the reason sprites looked mushy
	const up = upscale(g.grid, 2)
	pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
	return id
}

/** Erase the display — and remember that it took the images with it.
 *
 *  Ghostty's ED handler calls kitty_images.delete(.{ .all = true }), which frees
 *  the pixel data and not merely the placements. (kitty itself does not.) So every
 *  clear has to re-arm the transmit set or the next frame places dangling ids. */
function eraseDisplay() {
	OUT.write('\x1b[2J')
	sent.clear()
}

/* ── screen ── */
const OUT = process.stdout
let prev: string[] = []
let hadImages = false
let alt = false
let quiet = false // --bench exercises the frame path without writing to the screen

function paint(lines: string[], images: string) {
	if (quiet) {
		prev = lines
		return
	}
	let buf = SYNC_START
	// Also clear on the frame that stops drawing images — switching to the
	// full-screen table used to leave every sprite pinned above the text, since
	// nothing emitted a delete once `images` went empty.
	if (images || hadImages) buf += clearPlacements()
	hadImages = !!images
	for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) buf += `${cursorTo(i + 1, 1)}\x1b[2K${lines[i]}`
	prev = lines
	buf += images + SYNC_END
	OUT.write(buf)
}

/**
 * Jump to a tab by its POSITION, the number the user sees.
 *
 * `select-workspace --workspace N` resolves a bare number as a ref, and cmux's
 * refs do not follow its display order — ref 1 was the fourth tab here — so
 * passing the position directly lands on the wrong session. Ask cmux for its own
 * ordering and translate.
 */
function jump(position: number) {
	try {
		const out = execFileSync(CMUX, ['workspace', 'list'], {
			encoding: 'utf8',
			env: { ...process.env, CMUX_QUIET: '1' },
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		const refs = out
			.split('\n')
			.map((l) => /workspace:(\d+)/.exec(l)?.[1])
			.filter((r): r is string => !!r)
		const ref = refs[position - 1]
		if (!ref) return
		spawn(CMUX, ['select-workspace', '--workspace', `workspace:${ref}`], { stdio: 'ignore', detached: true }).unref()
	} catch {}
}

/* ── state ── */
type Mode = 'town' | 'split' | 'table'
let mode: Mode = 'split'
let faultsOnly = false
/** All labels on, or only the ones that need you plus the selection. */
let labels = true
/** the help panel, which suppresses the image layer while it is up */
let showHelp = false
/** digits typed so far while changing the passcode, or null when not changing it */
let pin: string | null = null
/**
 * The control passphrase being typed, or null when it is not being changed.
 *
 * Typed here rather than generated, because it has to be entered on a phone —
 * and typed HERE rather than in the browser, because the machine is the trust
 * boundary. It is never echoed: only a count of characters shows on screen.
 */
let ctlPass: string | null = null
let ctlNote = ''
/** what happened last time it was changed, shown until the panel closes */
let pinNote = ''
let selectedId: string | null = null
/** table rows opened with →, so their detail shows under them */
const expanded = new Set<string>()
let sessions: Session[] = []
let timers: NodeJS.Timeout[] = []

// The office owns the characters' positions, so it is created once and refitted
// — never rebuilt — or everyone would jump back to the doorway.
const office = new Office()
let cv = new Canvas(80, 40)
let geom = { cols: 0, rows: 0, townRows: 0, tableRows: 0 }
let lastTick = 0
let screenFrame = 0
let screenClock = 0
/** A stalled event loop must not teleport anyone across the room. */
const MAX_DT = 0.25

const visible = () => (faultsOnly ? sessions.filter((s) => needsAttention(s)) : sessions)

function moveSelection(delta: number) {
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
function layout() {
	const cols = Math.max(46, sizeOf(OUT.columns, process.env.COLUMNS, 90) - 1)
	const rows = Math.max(14, sizeOf(OUT.rows, process.env.LINES, 44) - 2)
	const list = visible()
	if (!selectedId || !list.some((s) => s.id === selectedId)) selectedId = order(list)[0]?.id ?? null

	// the town is the hero, so the table is capped at roughly a third and the
	// town keeps the rest; press tab for a full-screen table when you want detail
	const wantTable = Math.min(list.length + 4, Math.max(6, Math.floor(rows * 0.34)))
	const tableRows = mode === 'town' ? 0 : mode === 'table' ? rows : wantTable
	const townRows = rows - tableRows

	if (cols !== geom.cols || townRows !== geom.townRows) {
		cv = new Canvas(cols, Math.max(2, townRows) * 2)
		office.fit(cv.w, cv.h, list)
	}
	geom = { cols, rows, townRows, tableRows }
	office.assign(list)
	// Only the first time. A re-layout must never re-settle: it would teleport
	// everyone mid-stride every time the window changed size.
	if (!settled && list.length) {
		settled = true
		office.settle(list)
	}
}
let settled = false

/** Render the current state. Draws only — advancing the animation is separate. */
function draw() {
	const { cols, rows, townRows, tableRows } = geom
	if (showHelp) {
		// No image layer at all while this is up. Kitty images always draw above
		// text, so a panel with sprites still placed would have characters walking
		// across the sentence explaining them.
		const net = addresses()
		paint([...H.panel(cols, rows + 1, { on: !!server, port: cfg.port, token: passcode(), lan: net.lan, vpn: net.vpn, pin, pinNote }, { on: cfg.control, isSet: hasControlPass(), typing: ctlPass, note: ctlNote }), T.footer(cols, 0, faultsOnly, mode, { armed: awake.isArmed(), holding: awake.isHolding() })], '')
		return
	}
	const list = visible()
	let townLines: string[] = []
	let images = ''
	sentinelUsed = false
	if (townRows > 0) {
		// set before draw(), which is what decides whether to emit plate placements
		office.vertical = cfg.labels === 'vertical' && IMAGES
		const placed = office.draw(cv, list)
		if (!IMAGES)
			for (const p of placed) {
				const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color)
				cv.blit(p.x, p.y, shrink(g, CHAR_W, CHAR_H))
			}
		office.overlay(cv, placed, selectedId ?? undefined, labels)
		townLines = cv.render()
		// furniture first, then monitors, then people on top of both
		if (IMAGES) images = drawProps() + drawPlates() + drawMonitors() + drawImages(placed)
		else {
			for (const pr of office.props) {
				const size = PROP_SIZE[pr.kind]
				cv.blit(pr.x, pr.y, shrink(prop(pr.kind), size.w * TILE, size.h * TILE))
			}
			for (const m of office.monitors) cv.blit(m.x, m.y, shrink(monitor(m.lit, screenFrame, m.seed, m.kind), CHAR_W, CHAR_W))
			for (const b of office.badges)
				cv.blit(b.x, b.y, shrink(badge(b.level, b.asking ? LOOK.needs.color : tierOf(b.level).color, b.asking ? '?' : ''), TILE, TILE))
		}
	}

	const body: string[] = [...townLines]
	if (tableRows > 0) {
		// the room's own project colours, so a row and its carpet upstairs match
		const rowsOut = T.rows(list, cols, selectedId ?? undefined, (p) => office.colourOf(p), expanded)
		const sel = rowsOut.find((r) => r.s.id === selectedId)?.s
		const det = T.detail(sel, cols)
		body.push(T.header(cols))
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
	const awakeState = { armed: awake.isArmed(), holding: awake.isHolding() }
	const shareState = { on: !!server, port: cfg.port, error: serveError }
	paint(
		[
			T.summary(sessions, cols, awakeState, undefined, shareState),
			...body.slice(0, rows - (remote ? 1 : 0)),
			...(remote ? [remote] : []),
			T.footer(cols, office.hiddenCount, faultsOnly, mode, awakeState),
		],
		images,
	)
}

/** One simulation step, then redraw. Only the animation timer calls this. */
function animate() {
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

/**
 * Place each worker as a real image. The footprint is the world-scale one — one
 * tile wide, two tall — but the terminal draws it at font resolution, so the
 * sprite is far more detailed than the canvas grid it occupies.
 */
function drawImages(placements: Placed[]) {
	const pre: string[] = []
	let out = ''
	let pid = 1
	const cols = CHAR_W
	const rows = CHAR_H / 2
	for (const p of placements) {
		const id = ensureTransmitted(p, pre)
		out += cursorTo((p.y >> 1) + 2, p.x + 1) + place(id, cols, rows, pid++, 3)
	}
	return pre.join('') + out
}

/** Static furniture. Sent once per kind and then only re-placed each frame. */
function drawProps() {
	const pre: string[] = []
	let out = ''
	let pid = 200
	for (const pr of office.props) {
		const { id, fresh } = idFor(`prop:${pr.kind}`)
		if (fresh) {
			const up = upscale(prop(pr.kind).grid, 2)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		const size = PROP_SIZE[pr.kind]
		// furniture behind, workstations above it, people above everything
		out += cursorTo((pr.y >> 1) + 2, pr.x + 1) + place(id, size.w * TILE, (size.h * TILE) / 2, pid++, 1, loudOnce())
	}
	return pre.join('') + out
}

/** Monitors sit on the desk row, which no character overlaps, so no z conflict. */
function drawPlates() {
	const pre: string[] = []
	let out = ''
	let pid = 700
	const w = PLATE_COLS * cell.w
	const h = PLATE_ROWS * cell.h
	for (const p of office.plates) {
		const pick = choose(p.proj, w, h)
		if (!pick) continue // too small to read; RimWorld's rule — draw nothing
		const { id, fresh } = idFor(`plate:${p.proj}:${w}x${h}`)
		if (fresh) {
			const g = plate(pick.font, pick.text, w, h, p.colour, C.ink, C.night, pick.scale)
			// factor 1, deliberately: see the note on `cell`
			const up = upscale(g.grid, 1)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((p.y >> 1) + 2, p.x + 1) + place(id, PLATE_COLS, PLATE_ROWS, pid++, 2, loudOnce())
	}
	return pre.join('') + out
}

function drawMonitors() {
	const pre: string[] = []
	let out = ''
	let pid = 500
	for (const m of office.monitors) {
		const { id, fresh } = idFor(`mon:${m.lit ? 'on' : 'off'}:${m.lit ? screenFrame % 4 : 0}:${m.seed % 8}:${m.kind}`)
		if (fresh) {
			const up = upscale(monitor(m.lit, screenFrame, m.seed, m.kind).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		// the first workstation is the sentinel; if the store was wiped it answers
		// ENOENT and the reader below re-arms every transmit
		out += cursorTo((m.y >> 1) + 2, m.x + 1) + place(id, MON_COLS, MON_ROWS, pid++, 2, loudOnce())
	}
	for (const b of office.badges) {
		const { id, fresh } = idFor(b.asking ? 'badge:ask' : `badge:${b.level}`)
		if (fresh) {
			const up = upscale(badge(b.level, b.asking ? LOOK.needs.color : tierOf(b.level).color, b.asking ? '?' : '').grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((b.y >> 1) + 2, b.x + 1) + place(id, TILE, TILE / 2, pid++, 2)
	}
	return pre.join('') + out
}

function cleanup() {
	server?.close()
	if (alt) OUT.write(clearAll() + WATCH_OFF + '\x1b[?25h\x1b[?1049l')
	process.exit(0)
}

/** Terminal replies arrive on stdin mixed in with keystrokes. Peel off complete
 *  reports, act on them, and pass whatever is left through as typing. A reply can
 *  be split across reads, so hold a partial one until it completes. */
let inbox = ''
function onInput(b: Buffer) {
	const raw = inbox + b.toString('binary')
	const size = cellFrom(raw)
	if (size && size.w > 0 && size.h > 0 && (size.w !== cell.w || size.h !== cell.h)) {
		// a font-size change means every plate is now the wrong size for its box
		cell = size
		imageIds.clear()
		sent.clear()
	}
	const { keys, rest, lost } = demux(raw)
	inbox = rest
	if (lost) {
		// the surface was hidden, moved, or lost its images: re-send every pixel on
		// the next frame. 27KB, and only when something actually went missing.
		sent.clear()
		draw()
	}
	if (keys) onKey(Buffer.from(keys, 'binary'))
}

function onKey(b: Buffer) {
	const k = b.toString()

	// Typing a new passcode swallows every key, including q — otherwise a 4 in the
	// code would be fine but a q would quit the app mid-entry.
	// Same swallow-everything rule as the passcode: a `q` inside a passphrase must
	// be a character, not a quit.
	if (ctlPass !== null) {
		if (k === '\x1b') ((ctlPass = null), (ctlNote = 'left as it was'))
		else if (k === '\x7f' || k === '\b') ctlPass = ctlPass.slice(0, -1)
		else if (k === '\r' || k === '\n') {
			const r = setControlPass(ctlPass)
			ctlNote = r.ok ? 'saved — every device must enter it again' : r.why
			if (r.ok) ctlPass = null
		} else if (k >= ' ' && k <= '~') ctlPass += k
		draw()
		return
	}

	if (pin !== null) {
		if (k === '\x1b') ((pin = null), (pinNote = 'left as it was'))
		else if (k === '\x7f' || k === '\b') pin = pin.slice(0, -1)
		else if (/^\d$/.test(k)) {
			pin += k
			if (pin.length === 4) {
				const r = setPasscode(pin)
				pinNote = r.ok ? 'saved — every paired device must sign in again' : r.why
				pin = null
			}
		}
		draw()
		return
	}

	if (k === 'q' || k === '\x03') return cleanup()
	if (showHelp) {
		// `p` starts a passcode change; anything else dismisses the panel, because
		// hunting for the right key to close a help panel is its own small indignity
		if (k === 'p') {
			pin = ''
			pinNote = ''
			draw()
			return
		}
		if (k === 'c') {
			ctlPass = ''
			ctlNote = ''
			draw()
			return
		}
		showHelp = false
		pinNote = ''
		prev = []
		eraseDisplay()
		layout()
		draw()
		return
	}
	if (k === '?') {
		showHelp = true
		prev = []
		eraseDisplay()
		OUT.write(clearAll())
		imageIds.clear()
		sent.clear()
		draw()
		return
	}
	if (k === '\x1b[A') moveSelection(-1)
	else if (k === '\x1b[B') moveSelection(1)
	else if (k === '\x1b[C') {
		// → opens the selected row, ← closes it. Arrows because the hand is already
		// there choosing a row, and nothing else in the table uses left or right.
		if (selectedId) expanded.add(selectedId)
	} else if (k === '\x1b[D') {
		if (selectedId) expanded.delete(selectedId)
	}
	else if (k === '\r' || k === '\n') {
		const s = sessions.find((x) => x.id === selectedId)
		if (s?.tab) jump(s.tab)
	} else if (k === '\t') {
		mode = mode === 'split' ? 'town' : mode === 'town' ? 'table' : 'split'
		prev = []
		eraseDisplay()
		layout()
	} else if (k === 'f') {
		faultsOnly = !faultsOnly
		layout()
	} else if (k === 'r') {
		// Full image teardown and rebuild. A terminal can drop the images it holds
		// with no event we can see; until that is properly diagnosed this is the
		// manual way back.
		OUT.write(clearAll())
		imageIds.clear()
		sent.clear()
		prev = []
		eraseDisplay()
		layout()
	} else if (k === 'v') {
		// the room re-reads this every frame, so nothing needs re-planning
		cfg.labels = cfg.labels === 'vertical' ? 'horizontal' : 'vertical'
		cfgStore.save(cfg)
		prev = []
		eraseDisplay()
	} else if (k === 'l') {
		labels = !labels
	} else if (k === 's') {
		// Persisted, because a network listener you have to remember to re-enable is
		// one you will eventually leave on with a flag instead.
		cfg.serve = !cfg.serve
		syncServe()
		cfgStore.save(cfg)
	} else if (k === 'a') {
		// Toggling off drops any assertion immediately rather than waiting for the
		// next poll — the point of reaching for this key is usually "let it sleep now".
		awake.configure(!awake.isArmed())
		awake.sync(sessions)
	} else if (/^[0-9]$/.test(k)) jump(k === '0' ? 10 : Number(k))
	// keys only ever redraw; they must not advance the animation or the creatures
	// lurch forward once per keystroke
	draw()
}

function start() {
	for (const t of timers) clearInterval(t)
	timers = []
	prev = []
	eraseDisplay()
	layout()
	draw()
	timers.push(setInterval(animate, 110))
	// Backstop only. Measured against cmux directly, a workspace switch loses
	// neither the image store nor the renderer's textures, so this exists purely
	// for a terminal that does drop them without reporting it. The real triggers
	// are events — focus-in, a size report, or an ENOENT reply — so this runs a
	// minute apart rather than every five seconds, which was re-sending every
	// image twelve times a minute to fix a problem that turned out to be elsewhere.
	timers.push(
		setInterval(() => {
			// forget only that the pixels were sent; the ids stay stable so the
			// terminal replaces each image instead of accumulating new ones
			sent.clear()
		}, 60_000),
	)
	timers.push(
		setInterval(() => {
			sessions = collect()
			// hold the machine open while anyone is mid-task, and let go when they stop
			awake.sync(sessions)
			layout()
			draw()
		}, 2000),
	)
}

/**
 * Headless keep-awake. No canvas, no images, no input — just the poll and the
 * power assertion, logging each transition so it is auditable after the fact.
 *
 * Unlike the room, it does not exit when no sessions are live: a machine with
 * nothing running now is exactly the one that will have something running in ten
 * minutes, and a guard that quits on an empty room protects nothing.
 */
function guard() {
	// local time, not ISO/UTC: this log is read by a person on this machine, and a
	// timestamp seven hours off their clock is worse than none
	const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 19)
	let last = false
	const tick = () => {
		sessions = collect()
		awake.sync(sessions)
		const now = awake.isHolding()
		if (now !== last) {
			const who = awake.holders(sessions)
			console.log(now ? `${stamp()}  holding sleep off — ${who.join(', ')}` : `${stamp()}  released`)
			last = now
		}
	}
	console.log(`${stamp()}  guildhall guard started (pid ${process.pid})`)
	tick()
	timers.push(setInterval(tick, 5000))
	const stop = () => {
		for (const t of timers) clearInterval(t)
		awake.configure(false)
		console.log(`${stamp()}  guard stopped`)
		process.exit(0)
	}
	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)
}

function main() {
	loadSheets()
	sessions = collect()
	if (GUARD) return guard()
	if (!sessions.length) {
		console.log('no live claude sessions found')
		process.exit(0)
	}
	if (BENCH) {
		quiet = true
		layout()
		const N = 200
		const t0 = process.cpuUsage()
		for (let i = 0; i < N; i++) animate()
		const u = process.cpuUsage(t0)
		const ms = (u.user + u.system) / 1000 / N
		process.stderr.write(`${ms.toFixed(2)} ms/frame · ${((ms * 9) / 10).toFixed(2)}% of one core at 9fps\n`)
		return
	}
	if (ONCE) {
		// A one-shot dump has no reason to address the cursor, and every reason not
		// to: piped into a file or a renderer it arrives as one enormous line, since
		// the row breaks were `ESC[n;1H` rather than newlines. Render, then print
		// what the frame would have contained.
		quiet = true
		layout()
		draw()
		OUT.write(prev.join('\n') + '\n')
		return
	}
	// asked once in the background; the header picks it up whenever it arrives
	update.check(() => draw())
	syncServe()
	alt = true
	OUT.write('\x1b[?1049h\x1b[?25l' + (IMAGES ? WATCH_ON : ''))
	eraseDisplay()
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		process.stdin.on('data', onInput)
	}
	process.on('SIGINT', cleanup)
	process.on('SIGTERM', cleanup)
	// A resize makes the terminal drop the images it is holding, so every id we
	// cached is stale and re-placing them renders nothing. Tear the whole image
	// layer down, forget the ids, and rebuild. Debounced because a drag fires
	// this dozens of times.
	let resizeTimer: NodeJS.Timeout | null = null
	OUT.on('resize', () => {
		if (resizeTimer) clearTimeout(resizeTimer)
		resizeTimer = setTimeout(() => {
			resizeTimer = null
			OUT.write(clearAll())
			imageIds.clear()
			sent.clear()
			prev = []
			eraseDisplay()
			start()
		}, 80)
	})
	start()
}

main()

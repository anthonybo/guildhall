#!/usr/bin/env node
/**
 * guildhall — every live Claude Code session as a pixel town, in a terminal.
 *
 * Read-only. It watches the sessions you already run (in cmux or anywhere else)
 * and never launches or modifies one. The only thing it writes is a cmux
 * "focus this tab" request, and only when you press enter.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	clearAll,
	WATCH_OFF,
	MOUSE_ON,
	MOUSE_OFF,
	MOUSE_PRESS,
	clipboard,
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
import { collect as collectReal, mixedHarness, needsAttention, order, type Session } from './data.ts'
import { demoSessions } from './demo.ts'
import { Canvas } from './canvas.ts'
import { CHAR_H, CHAR_W, MON_COLS, MON_ROWS, Office, TILE, type Placed } from './office.ts'
import { frameOf, shrink } from './characters.ts'
import { loadSheets } from './sheets.ts'
import { badgeFor, badgeKey, monitorFor, monitorKey } from './screens.ts'
// the tier/needs colours the badge takes, passed in so screens.ts stays theme-free
const LEVEL_LOOK = { needs: LOOK.needs.color, tierOf: (n: number) => tierOf(n).color }
import { C, LOOK, tierOf } from './theme.ts'
import { PROP_SIZE, prop } from './props.ts'
import * as T from './table.ts'
import * as H from './help.ts'
import * as awake from './awake.ts'
import { BUILD, build } from './version.ts'
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
/**
 * Set the control password from another program, reading it from STDIN.
 *
 * This exists so the menu bar app can offer the field without owning the
 * credential. It calls the same `setControlPass` the key handler does, so the
 * length rule, the character-variety rule and the scrypt hashing are the one
 * implementation they have always been — a second copy in Swift would be a second
 * thing to get wrong about the only password here that can run commands.
 *
 * **STDIN, never an argument.** Anything in argv is readable by every process on
 * the machine through `ps`, so a password passed that way is a password published
 * to every other user and every script running as you.
 *
 * `{ live: true }` for the same reason the key handler passes it: this is a person
 * deliberately setting a password, which is exactly what the guard is meant to
 * allow. The guard's purpose is to stop a module import or a stray script from
 * silently replacing a real credential, not to insist the person be in a terminal.
 */
if (process.argv.includes('--set-control-password')) {
	const typed = fs.readFileSync(0, 'utf8')
	const r = setControlPass(typed, { live: true })
	console.log(r.ok ? 'ok' : r.why)
	process.exit(r.ok ? 0 : 1)
}
/**
 * Print the plan quota and today's spend, refreshing the cache first.
 *
 * So anything on this machine can have these numbers without going through the
 * server. The menu bar reads the cache file directly and runs this when it is
 * stale, which means it does not care whether the process holding the port is old
 * enough to have the endpoint — a dependency that had the quota invisible for
 * hours purely because a long-running room predated it.
 */
/**
 * Pull the latest and set everything up again, from anywhere.
 *
 * The installer already existed as `npm run install:mac`, which is useless from
 * another directory — and "go and find the checkout first" is the step that does
 * not happen on the second machine. This is the same script, reachable from the
 * command that is already on the PATH.
 *
 * The project root comes from where this bundle lives (`<root>/dist/main.mjs`), so
 * it works wherever it is invoked and whatever the checkout is called.
 *
 * `--ff-only`: an upgrade must never merge or rebase on somebody's behalf. If the
 * pull cannot fast-forward, that is a working tree with its own commits or changes
 * in it, and the right move is to say so and stop.
 */
if (process.argv.includes('--upgrade')) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
	const run = (cmd: string, args: string[]) => {
		console.log(`\n\u001b[1m${cmd} ${args.join(' ')}\u001b[0m`)
		const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
		if (r.status !== 0) {
			console.error(`\nguildhall --upgrade stopped: ${cmd} exited ${r.status ?? 'abnormally'}`)
			process.exit(r.status ?? 1)
		}
	}
	console.log(`upgrading guildhall in ${root}`)
	if (!fs.existsSync(path.join(root, '.git'))) {
		console.error(`${root} is not a git checkout — nothing to pull`)
		process.exit(1)
	}
	run('git', ['pull', '--ff-only'])
	// `npm install` rather than `npm ci`: this is somebody's working checkout, not a
	// clean-room build, and `prepare` rebuilds the bundle either way.
	run('npm', ['install'])
	run('sh', ['tools/install-mac.sh'])
	process.exit(0)
}

/**
 * Set the view passcode from another program, reading it from STDIN.
 *
 * The menu bar was writing the passcode FILE directly, which looked equivalent and
 * was not: `setPasscode` also refuses the weak list and rotates the session key, so
 * a code set from the bar was accepted when the terminal would have refused it —
 * `1234` among them — and every paired device stayed signed in while the panel
 * said "signs every device out". Cookies survive a restart by design, so restarting
 * the service did not cover for it either.
 *
 * Same rule as the control password: one implementation of storing a credential,
 * whatever types it in.
 */
if (process.argv.includes('--set-passcode')) {
	const r = setPasscode(fs.readFileSync(0, 'utf8').trim())
	console.log(r.ok ? 'ok' : r.why)
	process.exit(r.ok ? 0 : 1)
}
/**
 * Refuse an unknown flag rather than starting the room.
 *
 * Anything unrecognised used to fall through to the full interactive app. A caller
 * that shelled out with a flag this build does not have — a menu bar app against a
 * stale `dist/` — got a whole guildhall running detached, holding the sleep
 * assertion, while the caller blocked forever on a child that was never going to
 * exit.
 */
{
	const known = /^--(once|bench|guard|headless|demo|serve|no-serve|no-awake|port|version|help|usage|sessions|config|set-serve|codex|no-codex|upgrade|set-control-password|set-passcode)$|^-[vh]$/
	const stray = process.argv.slice(2).filter((a) => a.startsWith('-') && !known.test(a))
	if (stray.length) {
		console.error(`guildhall: unknown option ${stray[0]} — see guildhall --help`)
		process.exit(2)
	}
}
if (process.argv.includes('--usage')) {
	const { fetchNow } = await import('./data/usage.ts')
	console.log(JSON.stringify((await fetchNow()) ?? { limits: [], at: 0 }))
	process.exit(0)
}
/**
 * Turn the browser-view service on or off, and say what happened.
 *
 * The menu bar toggle and `install:mac --serve` both call this, so there is one
 * implementation of what the service is. It also updates `serve` in the config, so
 * the terminal and the panel agree afterwards.
 */
{
	const i = process.argv.indexOf('--set-serve')
	if (i > 0) {
		const want = process.argv[i + 1]
		if (want !== 'on' && want !== 'off') {
			console.error('guildhall --set-serve on|off')
			process.exit(2)
		}
		const { serviceOn, serviceOff } = await import('./service.ts')
		const r = want === 'on' ? serviceOn() : serviceOff()
		if (!r.ok) {
			console.error(r.why)
			process.exit(1)
		}
		const cur = cfgStore.load()
		cur.serve = want === 'on'
		cfgStore.save(cur)
		console.log(r.note)
		process.exit(0)
	}
}
/**
 * The resolved settings as JSON, then exit.
 *
 * So that nothing else has to re-implement the defaults or the validation. The
 * installer read config.json itself and applied its own fallback, which is how a
 * third opinion about the default port got into the tree — and a file without a
 * `port` key made it report "nothing answering on port undefined" for a service
 * that was running fine. It asks now.
 */
if (process.argv.includes('--config')) {
	console.log(JSON.stringify(cfgStore.load()))
	process.exit(0)
}
/**
 * One snapshot of the room as JSON, then exit.
 *
 * This is how the menu bar app reads sessions, and the reason the browser server
 * can be off by default. It used to poll `http://127.0.0.1:4318/api/sessions`,
 * which meant the icon only worked if an HTTP server was listening — so installing
 * the app installed a server, and a machine started answering on every interface
 * for something that only ever needed to talk to itself.
 *
 * Same `snapshot()` the HTTP route serves, so the two cannot drift.
 */
if (process.argv.includes('--sessions')) {
	const { snapshot } = await import('./serve.ts')
	console.log(snapshot(process.argv.includes('--demo'), cfgStore.load().codex))
	process.exit(0)
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(`guildhall ${BUILD} — every live Claude Code session as a pixel office

watching
  guildhall                watch the room
  guildhall --once         print one frame and exit
  guildhall --codex        show Codex sessions too (--no-codex for one run without)
  guildhall --sessions     print the room as JSON and exit
  guildhall --config       print the resolved settings as JSON and exit
  guildhall --set-serve on|off   serve the browser view at login, or stop
  guildhall --demo         a fictional office; never reads the real registry

serving the browser view — these draw nothing and want no terminal
  guildhall --headless     serve it and nothing else (what the LaunchAgent runs)
  guildhall --guard        hold sleep off while sessions work, but do NOT serve
  guildhall --port 4400    listen elsewhere; default 4318, remembered in the config

alongside the room
  guildhall --serve        share while the room is on screen
  guildhall --no-serve     force sharing off for this run
  guildhall --no-awake     start with the sleep hold disarmed

  guildhall --upgrade      pull the latest and set it all up again
  guildhall --version      print the version and exit

keys   ? help · in it: click a value to change it · h explanations · y copy address · ⏎ jump to tab · f faults · l labels · a awake · tab view · r redraw · q quit
env    GUILDHALL_CMUX       path to the cmux binary
       GUILDHALL_CONFIG_DIR  settings elsewhere (default ~/.config/guildhall)
       GUILDHALL_NO_IMAGES   force half-block rendering
files  ~/.config/guildhall/config.json   port, host, and what is switched on

Run it from anywhere by linking it once, from the project: npm link
Start the browser view at login: see contrib/dev.guildhall.headless.plist`)
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
/**
 * Serve the browser view and nothing else — no canvas, no images, no keys.
 *
 * The web server used to exist only alongside the room, which tied it to a
 * terminal. That is fine at the desk and wrong everywhere else: away from the
 * machine, every change to the server needed somebody physically there to quit
 * the app and start it again. Headless, it is a service that can be restarted by
 * anything, including a watcher, and the room stays a thing you open when you
 * happen to want to look at it.
 */
const HEADLESS = process.argv.includes('--headless')
/** A fictional office, for documentation and for looking at this with nothing
 *  running. Never touches the real registry. */
const DEMO = process.argv.includes('--demo')
// `cfg.codex` is read here rather than at each call site: this wrapper is already
// the one place that decides where sessions come from.
const collect = () => (DEMO ? demoSessions() : collectReal(cfg.codex))
/**
 * Sharing is off unless it was turned on deliberately, and the choice persists.
 * `--serve` / `--no-serve` override the stored setting for one run.
 */
const cfg = cfgStore.load()
if (process.argv.includes('--serve')) cfg.serve = true
if (process.argv.includes('--no-serve')) cfg.serve = false
// `--codex` / `--no-codex`, for one run, like `--serve`.
//
// The containment story for the second harness was "turn it off" — and the only way to
// do that was to hand-edit config.json, which is not a recovery a person carries out
// while something looks broken. Every other switch has a flag or a key; this one had
// neither, and was not in --help either.
if (process.argv.includes('--codex')) cfg.codex = true
if (process.argv.includes('--no-codex')) cfg.codex = false
/** Was it given on the command line? Then the file must not take it back — see
 *  `adoptDiskSettings`, whose whole job is letting the file win. */
const CODEX_PINNED = process.argv.includes('--codex') || process.argv.includes('--no-codex')
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
			// read at call time, like `control` below, so pressing x or flipping the
			// menu bar switch reaches the browser without a restart
			codex: () => cfg.codex,
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
			// A busy port is the NORMAL case once the headless service exists: it holds
			// the port at login, so a room opened afterwards cannot have it and does not
			// need it. Saying only "in use" made the expected arrangement read as a
			// fault, and the fault it suggested — something is broken, sharing is down —
			// is the opposite of the truth, since the browser view is being served by
			// the thing that took the port.
			// Do not name a culprit that may not be the culprit. This said "the daemon has
			// it", and the thing holding the port is just as often an interactive room —
			// which is what made a real conflict read like a daemon problem.
			serveError = e.code === 'EADDRINUSE' ? `port ${cfg.port} is already served by another process` : (e.code ?? 'failed')
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
/**
 * `--bench` deliberately does NOT disable images.
 *
 * It used to, which made the benchmark measure a renderer nobody runs: with images
 * off the frame takes the half-block path and never calls `drawPlates`,
 * `drawMonitors`, `drawProps` or `drawImages` at all — and `drawPlates` was 77.6%
 * of the real frame. So the one number anybody consulted before changing the
 * renderer was blind to the most expensive thing in it, and stayed blind while a
 * per-frame call that could be cached sat there for months.
 *
 * A benchmark that measures a path production does not take is worse than no
 * benchmark, because it is trusted.
 */
const IMAGES = supportsImages() && !ONCE && !GUARD
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
/**
 * First line of the help shown, when it is taller than the window.
 *
 * Reset every time the panel opens: reopening it and finding yourself halfway
 * down somebody else's scroll position is worse than starting at the top.
 */
let helpScroll = 0
/**
 * Which explanatory sections are open. Empty is the point: the panel opens as a
 * short list of settings and headings, and the ninety lines of prose are there
 * when asked for rather than by default.
 */
let helpOpen = new Set<string>()

/**
 * What the help panel is told about sharing and control.
 *
 * Built here rather than inline at the draw call because the key handler needs
 * the same values to work out how far the panel can scroll. Two copies of this
 * would drift, and the symptom would be a scroll limit that does not match the
 * panel it is limiting.
 */
const shareInfo = () => {
	const net = addresses()
	return { on: !!server, port: cfg.port, token: passcode(), lan: net.lan, vpn: net.vpn, pin, pinNote, portEntry, portNote }
}
const controlInfo = () => ({ on: cfg.control, isSet: hasControlPass(), typing: ctlPass, note: ctlNote })
const envInfo = () => ({ awakeArmed: awake.isArmed(), awakeHolding: awake.isHolding(), labels: cfg.labels, codex: cfg.codex })

/**
 * The three toggles, extracted so the help panel and the global keys run the same
 * code. Two copies of "flip this and persist it" is how one of them ends up not
 * saving, or not taking effect until the next poll.
 */
function toggleShare() {
	// Persisted, because a network listener you have to remember to re-enable is one
	// you will eventually leave on with a flag instead.
	cfg.serve = !cfg.serve
	syncServe()
	cfgStore.save(cfg)
}
function toggleAwake() {
	// Toggling off drops any assertion immediately rather than waiting for the next
	// poll — the point of reaching for this is usually "let it sleep now".
	awake.configure(!awake.isArmed())
	awake.sync(sessions)
}
function toggleLabels() {
	// the room re-reads this every frame, so nothing needs re-planning
	cfg.labels = cfg.labels === 'vertical' ? 'horizontal' : 'vertical'
	cfgStore.save(cfg)
	prev = []
}
/**
 * Take up the settings another surface may have changed on disk.
 *
 * Every process here loaded `cfg` once at launch, so the menu bar's switches wrote
 * config.json and reached nothing that was already running: the headless service
 * kept serving what it started with, and a room went one worse — its next
 * `cfgStore.save(cfg)` wrote the stale value straight back over the change.
 *
 * Called before the save-capable code in each poll for that reason: disk wins, then
 * a keystroke here beats disk, which is the order that cannot lose an edit.
 *
 * Only the two fields built to be read live. `port` and `host` cannot move under a
 * bound listener, `serve` is the headless process's entire job, and `labels` is
 * already re-read every frame.
 */
function adoptDiskSettings() {
	const disk = cfgStore.load()
	// A one-run flag outranks the file for the whole run. Without this the first poll
	// two seconds in silently undid `--no-codex`, which is the flag somebody reaches
	// for precisely because something looks wrong.
	if (!CODEX_PINNED) cfg.codex = disk.codex
	cfg.control = disk.control
}
function toggleCodex() {
	cfg.codex = !cfg.codex
	cfgStore.save(cfg)
	// Re-collect NOW rather than waiting up to two seconds for the next poll. Every
	// other toggle here shows its effect on the keystroke, and a switch whose whole
	// visible result is "desks appear" is the one where a delay reads as it not
	// having worked.
	// The same four steps the two-second poll runs, because desks are appearing or
	// disappearing — a redraw alone would paint new sessions into the old floor plan.
	sessions = collect()
	awake.sync(sessions)
	layout()
	prev = []
}
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
/** digits typed so far while changing the port, or null when not changing it */
let portEntry: string | null = null
/** what happened last time the port was changed */
let portNote = ''

/**
 * Move the listener to `next`, and put it back if that fails.
 *
 * Without the restore, mistyping a port that something else already holds would
 * disable sharing outright: the EADDRINUSE handler in `syncServe` sets serve to
 * false, so the panel would go from "sharing on port 4318" to off, and the address
 * you were reading would be gone. Changing a setting must not be able to turn the
 * feature off.
 *
 * The old listener is closed first because binding the new port while the old one
 * is held is not what "change the port" means — one process, one address.
 */
/**
 * Put an address on the clipboard, and say so on the port line.
 *
 * OSC 52 has no reply, so there is nothing to check: some terminals refuse it
 * outright and none of them answer. The note therefore says what was sent rather
 * than that it arrived — claiming a copy that silently failed is worse than
 * saying nothing, because the address is then pasted from memory.
 */
function copyAddress(url: string) {
	OUT.write(clipboard(url))
	portNote = `sent ${url} to the clipboard`
}

function movePort(next: number) {
	const was = cfg.port
	server?.close()
	server = null
	cfg.port = next
	cfg.serve = true
	syncServe()
	// `listen` is asynchronous, so a bind failure lands on the error handler rather
	// than here. Give it a tick, then judge by whether a listener actually exists.
	setTimeout(() => {
		if (server) {
			cfgStore.save(cfg)
			portNote = `moved to ${next} — the old address stops working`
		} else {
			cfg.port = was
			cfg.serve = true
			serveError = ''
			syncServe()
			portNote = `${next} is in use — kept ${was}`
		}
		draw()
	}, 150)
}
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
				entry ?? T.footer(cols, 0, faultsOnly, mode, { armed: awake.isArmed(), holding: awake.isHolding() }),
			],
			'',
		)
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
			for (const m of office.monitors) cv.blit(m.x, m.y, shrink(monitorFor(m, screenFrame), CHAR_W, CHAR_W))
			for (const b of office.badges)
				cv.blit(b.x, b.y, shrink(badgeFor(b, LEVEL_LOOK), TILE, TILE))
		}
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
	const awakeState = { armed: awake.isArmed(), holding: awake.isHolding() }
	const shareState = { on: !!server, port: cfg.port, error: serveError }
	paint(
		[
			// build(), not the default frozen BUILD: this process is often left running
			// for days across releases, and the header is exactly where you look to ask
			// "is this the thing I just built?"
			T.summary(sessions, cols, awakeState, build(), shareState),
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
		// Key and picture from the same descriptor, so they cannot describe different
		// desks — see the note on `Desk` for the version of this that shipped.
		const { id, fresh } = idFor(monitorKey(m, screenFrame))
		if (fresh) {
			const up = upscale(monitorFor(m, screenFrame).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		// the first workstation is the sentinel; if the store was wiped it answers
		// ENOENT and the reader below re-arms every transmit
		out += cursorTo((m.y >> 1) + 2, m.x + 1) + place(id, MON_COLS, MON_ROWS, pid++, 2, loudOnce())
	}
	for (const b of office.badges) {
		const { id, fresh } = idFor(badgeKey(b))
		if (fresh) {
			const up = upscale(badgeFor(b, LEVEL_LOOK).grid, 3)
			pre.push(transmit(id, encodePNG(up.rgba, up.w, up.h)))
		}
		out += cursorTo((b.y >> 1) + 2, b.x + 1) + place(id, TILE, TILE / 2, pid++, 2)
	}
	return pre.join('') + out
}

function cleanup() {
	server?.close()
	// MOUSE_OFF unconditionally, even though it is only turned on for the help
	// panel: quitting with the panel open would otherwise hand the shell back a
	// terminal that still reports clicks, and the person would find selection
	// broken in a program that is no longer running.
	if (alt) OUT.write(clearAll() + WATCH_OFF + MOUSE_OFF + '\x1b[?25h\x1b[?1049l')
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

/**
 * One read, split into individual keys.
 *
 * A terminal delivers a burst as a single read: typing a password and pressing
 * return arrives as the one string `"my pass\r"`, not eight of them. Comparing
 * that whole chunk against `'\r'` never matches, so the return was appended to
 * the password as a character and there was no way to save it. The passcode had
 * the same fault — `/^\d$/` against a chunk of several digits fails too, so a
 * fast typist could not enter one either.
 *
 * Escape sequences stay whole, or an arrow key would arrive as ESC, `[`, `A` and
 * the ESC would read as "cancel".
 */
function eachKey(chunk: string): string[] {
	const out: string[] = []
	for (let i = 0; i < chunk.length; i++) {
		if (chunk[i] === '\x1b' && i + 1 < chunk.length) {
			const m = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e]|.)/.exec(chunk.slice(i))
			if (m) {
				out.push(m[0])
				i += m[0].length - 1
				continue
			}
		}
		out.push(chunk[i])
	}
	return out
}

function onKey(b: Buffer) {
	const k = b.toString()

	// Typing a new passcode swallows every key, including q — otherwise a 4 in the
	// code would be fine but a q would quit the app mid-entry.
	// Same swallow-everything rule as the passcode: a `q` inside a passphrase must
	// be a character, not a quit.
	if (ctlPass !== null) {
		for (const key of eachKey(k)) {
			if (ctlPass === null) break // saved mid-chunk; the rest is not password
			if (key === '\x1b') ((ctlPass = null), (ctlNote = 'left as it was'))
			else if (key === '\x7f' || key === '\b') ctlPass = ctlPass.slice(0, -1)
			else if (key === '\r' || key === '\n') {
				// `live` only here: a person is at the keyboard and just typed it. Every
				// other caller is refused, so no script can replace the real credential.
				const r = setControlPass(ctlPass, { live: true })
				ctlNote = r.ok ? 'saved — every device must enter it again' : r.why
				if (r.ok) ctlPass = null
			} else if (key.length === 1 && key >= ' ' && key <= '~') ctlPass += key
		}
		draw()
		return
	}

	// Same swallow-everything rule as the two above: a `q` typed while entering a
	// port must not quit the app. Enter commits, because unlike a 4-digit passcode
	// a port has no fixed length to commit on.
	if (portEntry !== null) {
		for (const key of eachKey(k)) {
			if (portEntry === null) break
			if (key === '\x1b') ((portEntry = null), (portNote = 'left as it was'))
			else if (key === '\x7f' || key === '\b') portEntry = portEntry.slice(0, -1)
			else if (key === '\r' || key === '\n') {
				const n = Number(portEntry)
				// 1024 rather than 1: binding below it needs root, and the failure would
				// arrive as a permissions error that reads like a bug in this app
				if (!Number.isInteger(n) || n < 1024 || n > 65535) portNote = 'a port is 1024 to 65535'
				else if (n === cfg.port) portNote = `already on ${n}`
				else movePort(n)
				portEntry = null
			} else if (/^\d$/.test(key) && portEntry.length < 5) portEntry += key
		}
		draw()
		return
	}

	if (pin !== null) {
		for (const key of eachKey(k)) {
			if (pin === null) break // finished mid-chunk
			if (key === '\x1b') ((pin = null), (pinNote = 'left as it was'))
			else if (key === '\x7f' || key === '\b') pin = pin.slice(0, -1)
			else if (/^\d$/.test(key)) {
				pin += key
				if (pin.length === 4) {
					const r = setPasscode(pin)
					pinNote = r.ok ? 'saved — every paired device must sign in again' : r.why
					pin = null
				}
			}
		}
		draw()
		return
	}

	if (k === 'q' || k === '\x03') return cleanup()
	if (showHelp) {
		// Scroll, when there is more than the window can hold. This has to come
		// before the catch-all below, which dismisses on any key: an arrow pressed at
		// a help panel that ran off the bottom used to CLOSE it, so the sections past
		// the fold — the address and the passcode — could not be reached at all on a
		// terminal shorter than 41 rows.
		const hidden = H.overflow(geom.cols, geom.rows + 1, shareInfo(), controlInfo(), envInfo(), helpOpen)
		if (hidden > 0 && (k === '\x1b[A' || k === '\x1b[B' || k === 'k' || k === 'j' || k === ' ')) {
			const by = k === '\x1b[A' || k === 'k' ? -1 : k === ' ' ? Math.max(1, geom.rows - 3) : 1
			helpScroll = Math.max(0, Math.min(helpScroll + by, hidden + 1))
			draw()
			return
		}
		// A click on a line that does something. Both the picture and the map come
		// from H.view, so a row can never carry a different line's action.
		//
		// Release events (`m`) are swallowed rather than acted on, or every click
		// would fire twice — and the second one would land on whatever the first
		// just drew.
		const press = MOUSE_PRESS.exec(k)
		if (press || /\x1b\[<\d+;\d+;\d+m/.test(k)) {
			if (press) {
				const v = H.view(geom.cols, geom.rows + 1, shareInfo(), controlInfo(), helpScroll, envInfo(), helpOpen)
				// paint() puts line i on screen row i+1, so a 1-based click row maps back
				// by subtracting one
				const hit = v.hits.find((h) => h.row === Number(press[3]) - 1)
				if (hit?.act.kind === 'port' && cfg.serve) ((portEntry = ''), (portNote = ''))
				else if (hit?.act.kind === 'passcode') ((pin = ''), (pinNote = ''))
				else if (hit?.act.kind === 'control') ((ctlPass = ''), (ctlNote = ''))
				else if (hit?.act.kind === 'copy') copyAddress(hit.act.text)
				else if (hit?.act.kind === 'sharing') toggleShare()
				else if (hit?.act.kind === 'awake') toggleAwake()
				else if (hit?.act.kind === 'labels') toggleLabels()
				else if (hit?.act.kind === 'codex') toggleCodex()
				else if (hit?.act.kind === 'section') {
					const id = hit.act.id
					// Opening a section moves everything below it, so the scroll position
					// stops meaning what it did. Clamped rather than reset: closing a
					// section near the bottom would otherwise throw you back to the top.
					helpOpen.has(id) ? helpOpen.delete(id) : helpOpen.add(id)
					helpScroll = Math.min(helpScroll, H.overflow(geom.cols, geom.rows + 1, shareInfo(), controlInfo(), envInfo(), helpOpen) + 1)
				}
				draw()
			}
			return
		}
		// One key for all the prose, since the common want is either "show me the
		// settings" or "explain everything", not one section at a time.
		if (k === 'h') {
			helpOpen = helpOpen.size ? new Set() : new Set(H.SECTION_IDS)
			helpScroll = 0
			draw()
			return
		}
		if (k === 's') {
			toggleShare()
			draw()
			return
		}
		if (k === 'a') {
			toggleAwake()
			draw()
			return
		}
		if (k === 'v') {
			toggleLabels()
			draw()
			return
		}
		if (k === 'x') {
			toggleCodex()
			draw()
			return
		}
		if (k === 'y') {
			const first = [...shareInfo().vpn, ...shareInfo().lan][0]
			if (first) copyAddress(`http://${first}:${cfg.port}`)
			draw()
			return
		}
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
		// `o` rather than a second `p`, which the passcode already has. Only offered
		// while sharing is on, since the port of a server that is not running is not
		// a thing anybody is looking at.
		if (k === 'o' && cfg.serve) {
			portEntry = ''
			portNote = ''
			draw()
			return
		}
		showHelp = false
		pinNote = ''
		// Selection belongs to the terminal again the moment the panel closes.
		OUT.write(MOUSE_OFF)
		prev = []
		eraseDisplay()
		layout()
		draw()
		return
	}
	if (k === '?') {
		showHelp = true
		helpScroll = 0
		// Mouse on only while the panel is up; see MOUSE_ON for why not app-wide.
		OUT.write(MOUSE_ON)
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
		toggleLabels()
		eraseDisplay()
	} else if (k === 'l') {
		labels = !labels
	} else if (k === 's') {
		toggleShare()
	} else if (k === 'a') {
		toggleAwake()
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
			// so the menu bar's switches reach a room that is already open
			adoptDiskSettings()
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
/**
 * The browser view as a service. No canvas, no images, no input.
 *
 * Same polling the room does, without the drawing — the stream and every route
 * read `sessions`, so this is the whole app minus the picture. It logs to stdout
 * because whatever supervises it is the only thing watching, and it never exits on
 * an empty room: a machine with nothing running now is exactly the one that will
 * have something running in ten minutes.
 *
 * `--serve` is implied. Starting this and having it serve nothing because a config
 * file said `serve: false` would be a trap.
 */
function headless() {
	const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 19)
	cfg.serve = true
	syncServe()
	console.log(`${stamp()}  guildhall headless on ${cfg.host}:${cfg.port} (pid ${process.pid}) — ${BUILD}`)
	// Serving is the entire job, so failing to serve is failing to run.
	//
	// This used to log the error and carry on: a live process, polling every two
	// seconds, answering nothing, forever. Under launchd that is the worst of both
	// — KeepAlive sees a healthy process and never restarts it, so the browser view
	// stays down until somebody notices by hand, which from a phone is
	// indistinguishable from a sleeping machine.
	//
	// Exiting non-zero hands the decision to launchd, which retries. That also makes
	// "start the service before freeing the port" recover on its own rather than
	// having to be done in the right order.
	//
	// Checked on a timer, not straight after syncServe(), because `listen` is
	// ASYNCHRONOUS: the first version of this read `serveError` immediately, found
	// it empty because the EADDRINUSE handler had not run yet, and carried on
	// exactly as before. It looked right and did nothing.
	//
	// `server` rather than `serveError` is the real signal — the error handler nulls
	// it — so this covers a refused bind for any reason, not only a busy port.
	setTimeout(() => {
		if (server) return
		console.log(`${stamp()}  serve failed: ${serveError || 'no listener'} — exiting so it gets retried`)
		process.exit(1)
	}, 500)
	const tick = () => {
		adoptDiskSettings()
		sessions = collect()
		awake.sync(sessions)
	}
	tick()
	timers.push(setInterval(tick, 2000))
	const stop = () => {
		for (const t of timers) clearInterval(t)
		awake.configure(false)
		console.log(`${stamp()}  headless stopped`)
		process.exit(0)
	}
	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)
}

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
	if (HEADLESS) return headless()
	if (!sessions.length) {
		console.log('no live claude sessions found')
		process.exit(0)
	}
	if (BENCH) {
		// `quiet` still suppresses the WRITE — a benchmark must not scribble escape
		// codes over the terminal it was launched from — but everything up to the write
		// now runs, including the image layers and the diff.
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

/**
 * Running: the interactive room with its timers, the headless browser-view service,
 * and the sleep guard — the three long-lived ways this program can be started.
 */
import { WATCH_ON, clearAll } from '../kitty.ts'
import { sweepGhosts as sweepCodexGhosts } from '../data/codex.ts'
import { loadSheets } from '../sheets.ts'
import * as awake from '../awake.ts'
import * as update from '../update.ts'
import { BUILD } from '../version.ts'
import { othersNote, withdraw } from '../servers.ts'
import { BENCH, GUARD, HEADLESS, IMAGES, ONCE, cfg, collect } from './run.ts'
import { OUT, eraseDisplay, prev, resetPrev, setAlt, setQuiet } from './screen.ts'
import { imageIds, sent } from './images.ts'
import { adoptDiskSettings, serveError, serveHandover, server, syncServe } from './serving.ts'
import { animate, layout, sessions, setSessions } from './state.ts'
import { draw } from './draw.ts'
import { cleanup, onInput } from './keys.ts'

let timers: NodeJS.Timeout[] = []

function start() {
	for (const t of timers) clearInterval(t)
	timers = []
	resetPrev()
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
			/**
			 * Retry a bind that lost to another guildhall.
			 *
			 * Only in that case: something which is not guildhall will not let go, so
			 * retrying it is a loop that cannot end, and the message already says to
			 * change the port. A guildhall will — when the daemon is stopped, or the port
			 * moves — and without this the room stayed dark until it was restarted.
			 *
			 * A failed bind costs microseconds, so once per poll is free.
			 */
			if (cfg.serve && !server && serveHandover) syncServe()
			setSessions(collect())
			// hold the machine open while anyone is mid-task, and let go when they stop
			awake.sync(sessions)
			layout()
			draw()
		}, 2000),
	)
	/**
	 * Cull Codex locks nobody holds, on a slow timer and never in the poll.
	 *
	 * One `lsof` costs about 50 cpu-ms against a 3 cpu-ms budget for the whole Codex
	 * poll, so it cannot go per tick. A minute apart is 0.08% of a core, and the thing it
	 * catches — a lock orphaned by SIGKILL or a power cut — does not appear on a schedule
	 * that needs watching any closer.
	 */
	timers.push(
		setInterval(() => {
			if (cfg.codex) sweepCodexGhosts()
		}, 60_000),
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
	// Named at startup, because this log is the only thing a launchd service can say.
	// Two servers on different ports never collide, so nothing else notices: each is
	// about 1% of a core, both are reachable on the tailnet, and they can be running
	// different builds of the server while serving the same browser client.
	{
		const also = othersNote()
		if (also) console.log(`${stamp()}  ${also} — two servers cost twice as much and both are reachable`)
	}
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
		setSessions(collect())
		awake.sync(sessions)
	}
	tick()
	timers.push(setInterval(tick, 2000))
	// see the note on the interactive timer: too expensive per poll, cheap per minute
	timers.push(
		setInterval(() => {
			if (cfg.codex) sweepCodexGhosts()
		}, 60_000),
	)
	const stop = () => {
		for (const t of timers) clearInterval(t)
		awake.configure(false)
		// so the next room does not warn about a server that has gone
		withdraw()
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
		setSessions(collect())
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

export function main() {
	loadSheets()
	setSessions(collect())
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
		setQuiet(true)
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
		setQuiet(true)
		layout()
		draw()
		OUT.write(prev.join('\n') + '\n')
		return
	}
	// asked once in the background; the header picks it up whenever it arrives
	update.check(() => draw())
	syncServe()
	setAlt(true)
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
			resetPrev()
			eraseDisplay()
			start()
		}, 80)
	})
	start()
}

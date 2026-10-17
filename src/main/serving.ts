/**
 * The browser view's listener as this process runs it: starting and stopping it to match
 * the setting, moving its port, and taking up settings another surface changed on disk.
 */
import fs from 'node:fs'
import { clipboard } from '../kitty.ts'
import * as awake from '../awake.ts'
import * as cfgStore from '../config.ts'
import { createServer } from '../serve.ts'
import { isGuildhall, portHolder } from '../service.ts'
import { announce, withdraw } from '../servers.ts'
import { AWAKE_PINNED, CODEX_PINNED, DEMO, PORT_PINNED, cfg } from './run.ts'
import { OUT } from './screen.ts'
import { draw } from './draw.ts'
import { applyAwake } from './toggles.ts'
import { setPortNote } from './keys.ts'

export let server: import('node:http').Server | null = null
export let serveError = ''
/**
 * Whether the port is held by ANOTHER GUILDHALL, as a fact rather than as prose.
 *
 * The footer used to work this out by searching the error message for the words
 * "already served". That made a user-visible state depend on the wording of a
 * sentence, and the next commit to improve the wording — naming the holder and its
 * pid, which is strictly better text — silently flipped every handover from "the
 * browser view is up, served by the daemon" to "share failed". The view was working
 * the whole time.
 *
 * A boolean cannot be reworded.
 */
export let serveHandover = false
/**
 * What a remote device has typed into this machine, newest first.
 *
 * Shown in the footer while control is armed. A remote caller that can act here
 * must not be able to act invisibly, and the machine's own screen is the one
 * place the person who owns it is certain to be looking.
 */
export const remoteLog: { at: number; proj: string; text: string; ok: boolean }[] = []

/** Start or stop the listener to match the setting. Returns what happened. */
export function syncServe() {
	if (cfg.serve === !!server) return
	if (!cfg.serve) {
		server?.close()
		server = null
		withdraw()
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
			/**
			 * Name the holder, and say whether waiting will help.
			 *
			 * It said only "already served by another process", which under launchd becomes
			 * an identical line every ten seconds forever with nothing to act on. The two
			 * cases need different responses and the log could not tell them apart: another
			 * guildhall WILL let go, so retrying is right; anything else will not, so
			 * retrying is a loop that cannot end.
			 */
			if (e.code === 'EADDRINUSE') {
				const holder = portHolder(cfg.port)
				const mine = holder ? isGuildhall(holder.pid) : false
				serveHandover = mine
				serveError = holder
					? mine
						? `port ${cfg.port} is held by another guildhall (pid ${holder.pid}) — waiting for it to let go`
						: `port ${cfg.port} is held by ${holder.cmd} (pid ${holder.pid}), which is not guildhall — this will not clear on its own; change the port`
					: `port ${cfg.port} is already served by another process`
			} else serveError = e.code ?? 'failed'
			server = null
			// The INTENT to serve survives a handover. Clearing it meant the room gave up
			// permanently: the daemon holding the port at login is the normal arrangement,
			// and when it stops — or the port is changed from the menu bar — nothing was
			// left to notice. The poll retries while this is true; see `retryServe`.
			if (!serveHandover) cfg.serve = false
		})
		// Announced once the bind SUCCEEDS, not before: a failed listen must not leave a
		// file claiming this process is serving, or the next room would warn about a
		// server that never started.
		/**
		 * State is cleared when the bind SUCCEEDS, never before it is attempted.
		 *
		 * It used to be cleared synchronously after `.listen()`, which is asynchronous.
		 * With a once-a-poll retry behind it that produced a visible flash: for one frame
		 * `server` was non-null and the error was cleared, so the header read "◉ sharing",
		 * then the EADDRINUSE handler fired and it read "◉ :4208 by daemon" again. Twice a
		 * second, forever, on a machine where the daemon legitimately holds the port.
		 */
		server.on('listening', () => {
			serveError = ''
			serveHandover = false
			announce(cfg.port, cfg.host)
			draw()
		})
		server.listen(cfg.port, cfg.host)
	} catch {
		server = null
		cfg.serve = false
		serveError = 'failed to start'
	}
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
export function adoptDiskSettings() {
	const disk = cfgStore.load()
	/**
	 * The port and host, which used to be excluded from here on the grounds that
	 * "port and host cannot change under a bound listener". True, and the wrong
	 * conclusion: they cannot change under one, so the listener has to be REPLACED —
	 * and doing nothing meant changing the port in the menu bar reached the service
	 * and never reached a room that was already open. The room went on reporting the
	 * old port, and on failing to bind it.
	 */
	/**
	 * Only when the file is actually there.
	 *
	 * `load()` cannot distinguish "no config" from "config unreadable" — it catches and
	 * returns the defaults either way. Both writers are atomic, so a torn read is not
	 * possible; a MISSING file is, and without this guard that would silently move a
	 * running room to the default port and rebind it, which is a strange thing to have
	 * happen because a file went away.
	 */
	const present = fs.existsSync(cfgStore.configPath())
	if (present && !PORT_PINNED && (disk.port !== cfg.port || disk.host !== cfg.host)) {
		cfg.port = disk.port
		cfg.host = disk.host
		if (server) {
			server.close()
			server = null
		}
		serveError = ''
		serveHandover = false
		syncServe()
	}
	// A one-run flag outranks the file for the whole run. Without this the first poll
	// two seconds in silently undid `--no-codex`, which is the flag somebody reaches
	// for precisely because something looks wrong.
	if (!CODEX_PINNED) cfg.codex = disk.codex
	cfg.control = disk.control
	/**
	 * The awake settings, so the menu bar toggle reaches a room that is already open.
	 *
	 * `saveNow()` in the menu bar restarts the headless service only when it is SERVING,
	 * so without this a machine told never to sleep would keep sleeping until something
	 * restarted — the port lesson above, with a different setting. Applied through
	 * `configure` rather than by assignment because a live assertion has its flags baked
	 * into the running caffeinate and has to be dropped for them to change.
	 */
	if (present && !AWAKE_PINNED && (disk.awakeMode !== cfg.awakeMode || disk.awakeDisplay !== awake.holdsDisplay())) {
		cfg.awakeMode = disk.awakeMode
		cfg.awakeDisplay = disk.awakeDisplay
		applyAwake(disk.awakeMode)
	}
}

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
export function copyAddress(url: string) {
	OUT.write(clipboard(url))
	setPortNote(`sent ${url} to the clipboard`)
}

export function movePort(next: number) {
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
			setPortNote(`moved to ${next} — the old address stops working`)
		} else {
			cfg.port = was
			cfg.serve = true
			serveError = ''
			syncServe()
			setPortNote(`${next} is in use — kept ${was}`)
		}
		draw()
	}, 150)
}

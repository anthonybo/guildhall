/**
 * The one-shot flags: each prints an answer for another program (the menu bar, the
 * installer, a script) and exits without starting the room.
 *
 * Statement order is the contract here. These run top to bottom before anything of the
 * room exists, and an earlier flag wins over a later one — see main.ts for why the room
 * is not even loaded until this module has finished.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BUILD } from '../version.ts'
import * as cfgStore from '../config.ts'
import { okPort, pickPort, portFree } from '../port.ts'
import { setPasscode } from '../auth.ts'
import { setControlPass } from '../controlauth.ts'
import { others, stop as stopServer, supervisor } from '../servers.ts'
import { ROOT } from '../root.ts'

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
	const root = ROOT
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
	const known = /^--(once|bench|guard|headless|demo|serve|no-serve|no-awake|port|version|help|usage|sessions|config|set-serve|codex|no-codex|upgrade|set-control-password|set-passcode|pick-port|servers|stop-server|port-free|cmux-reach)$|^-[vh]$/
	const stray = process.argv.slice(2).filter((a) => a.startsWith('-') && !known.test(a))
	if (stray.length) {
		console.error(`guildhall: unknown option ${stray[0]} — see guildhall --help`)
		process.exit(2)
	}
}
/**
 * Print a free port, so the menu bar's randomize button and the terminal's port
 * prompt get the same answer from the same implementation.
 *
 * Here rather than in Swift because "which ports are safe" is a decision with real
 * reasoning behind it — see src/port.ts, and in particular why anything above 32768
 * is wrong on macOS. A second copy in another language would be a second chance to
 * get that wrong, which is the mistake the settings defaults already made once.
 *
 * Exits 1 with nothing on stdout if it cannot find one, so a caller can tell the
 * difference between "no answer" and a port number.
 */
/**
 * List the other guildhalls serving, as JSON, so the menu bar can offer to stop one.
 *
 * Includes whether each is SUPERVISED, because that changes what stopping it means: a
 * dev-watcher child comes straight back, so the button has to say it will stop the
 * watcher rather than silently doing something else.
 */
/**
 * Can we bind that port, and if not, who has it?
 *
 * So a caller can refuse BEFORE committing to a port, instead of saving it and leaving
 * launchd to retry a bind that cannot succeed. That is the hole this closes: the port
 * was validated for range and nothing else, so setting it to one already held started a
 * restart loop that only the log could see.
 */
{
	const i = process.argv.indexOf('--port-free')
	if (i > 0) {
		const port = Number(process.argv[i + 1])
		if (!okPort(port)) {
			console.log(JSON.stringify({ free: false, why: 'a port is 1024 to 65535' }))
			process.exit(0)
		}
		const { host } = cfgStore.load()
		const free = await portFree(port, host)
		if (free) {
			console.log(JSON.stringify({ free: true }))
			process.exit(0)
		}
		// Name the holder, and say whether it is one of ours: another guildhall is a
		// handover and recoverable, anything else means this port will never work.
		const { portHolder, isGuildhall } = await import('../service.ts')
		const holder = portHolder(port)
		console.log(
			JSON.stringify({
				free: false,
				pid: holder ? Number(holder.pid) : null,
				cmd: holder?.cmd ?? null,
				guildhall: holder ? isGuildhall(holder.pid) : false,
			}),
		)
		process.exit(0)
	}
}
/**
 * Can this machine's server drive cmux? Printed as JSON for the menu bar.
 *
 * So the panel can stop offering control as available when it structurally is not — the
 * switch said "on" while every send came back with cmux's own refusal.
 */
if (process.argv.includes('--cmux-reach')) {
	const { reach } = await import('../cmuxreach.ts')
	console.log(JSON.stringify(reach()))
	process.exit(0)
}
if (process.argv.includes('--servers')) {
	console.log(JSON.stringify(others().map((s) => ({ ...s, supervisor: supervisor(s.pid) }))))
	process.exit(0)
}
/**
 * Stop one of them, by pid.
 *
 * Here rather than in Swift because it refuses any pid this registry did not announce,
 * and that guard is the difference between a stop button and a menu bar app that can
 * signal arbitrary processes. One implementation of the refusal, in the place that owns
 * the registry.
 */
{
	const i = process.argv.indexOf('--stop-server')
	if (i > 0) {
		const pid = Number(process.argv[i + 1])
		const r = Number.isInteger(pid) ? stopServer(pid) : ({ ok: false, why: 'guildhall --stop-server <pid>' } as const)
		console.log(r.ok ? r.note : r.why)
		process.exit(r.ok ? 0 : 1)
	}
}
if (process.argv.includes('--pick-port')) {
	const host = cfgStore.load().host
	const port = await pickPort(host)
	if (port === null) {
		console.error('guildhall: could not find a free port')
		process.exit(1)
	}
	console.log(String(port))
	process.exit(0)
}
if (process.argv.includes('--usage')) {
	const { fetchNow } = await import('../data/usage.ts')
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
		const { serviceOn, serviceOff } = await import('../service.ts')
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
	const { snapshot } = await import('../serve.ts')
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
  guildhall --port 4400    listen elsewhere; default 4319, remembered in the config

alongside the room
  guildhall --serve        share while the room is on screen
  guildhall --no-serve     force sharing off for this run
  guildhall --no-awake     start with the sleep hold disarmed

  guildhall --upgrade      pull the latest and set it all up again
  guildhall --version      print the version and exit

ports and servers
  guildhall --pick-port    print a port nothing is listening on
  guildhall --servers      which guildhalls are serving right now, as JSON
  guildhall --stop-server <pid>  stop one of them, by the pid --servers printed

keys   ? help · in it: click a value to change it · h explanations · y copy address · ⏎ jump to tab · f faults · l labels · a awake · x codex · tab view · r redraw · q quit
env    GUILDHALL_CMUX       path to the cmux binary
       GUILDHALL_CONFIG_DIR  settings elsewhere (default ~/.config/guildhall)
       GUILDHALL_NO_IMAGES   force half-block rendering
files  ~/.config/guildhall/config.json   port, host, and what is switched on
       ~/.config/guildhall/cmux-password  cmux socket password, if the service needs one

Run it from anywhere by linking it once, from the project: npm link
Start the browser view at login: see contrib/dev.guildhall.headless.plist`)
	process.exit(0)
}

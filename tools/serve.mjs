#!/usr/bin/env node
/**
 * The browser view as a service that rebuilds and restarts itself.
 *
 * Why this exists: the web server used to run only inside the room, which tied it
 * to a terminal. Every change to a route or to the data layer then needed somebody
 * physically at the machine to quit the app and start it again — and the person who
 * wanted the change was, by definition, the one who was somewhere else.
 *
 * So: watch `src/` and `web/`, rebuild on change, restart the headless server. The
 * room stays exactly as it was, a thing you open when you want to look at it.
 *
 * No dependencies and no framework. `node --watch` was the obvious candidate and
 * does not fit: it watches the files the process has *loaded*, which after bundling
 * is only `dist/main.mjs`, so it would restart on the build rather than trigger it.
 *
 *   node tools/serve.mjs [--port 4319] [-- <extra guildhall flags>]
 */
import { spawn, spawnSync } from 'node:child_process'
import { watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Long enough to let an editor finish writing a file, and a build finish emitting. */
const SETTLE_MS = 400

const args = process.argv.slice(2)
const passThrough = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
const portArg = args.indexOf('--port')
let port = portArg > -1 ? args[portArg + 1] : null

const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 19)
const say = (msg) => console.log(`${stamp()}  ${msg}`)

/**
 * Move off a port something else already has, rather than fighting over it.
 *
 * This watcher and the installed service are both guildhall, and they used to be able to
 * want the same port: the service takes it from the config, and this takes it from
 * `--port` or, with no flag, the same config. So running both meant one of them looping
 * on a bind that could not succeed — and that got MORE likely, not less, when the
 * default became the port this was habitually started on.
 *
 * A dev watcher is the right half to give way. It is the disposable one, nothing is
 * bookmarked against it, and it has no business taking the port the service is
 * configured for. So it asks, and if the port is busy it takes a free one and says which
 * — loudly, because a tool that silently moves is worse than one that refuses.
 *
 * Synchronous and before anything is spawned: the whole point is that the child is never
 * launched into a port it cannot have.
 */
function freePort(want) {
	const held = (p) => {
		const r = spawnSync(process.execPath, ['dist/main.mjs', '--port-free', String(p)], { cwd: ROOT, encoding: 'utf8' })
		try {
			return JSON.parse(r.stdout).free !== true
		} catch {
			// The check could not run — say so and carry on rather than refusing to start a
			// dev tool over a failed probe.
			return false
		}
	}
	if (want && !held(want)) return want
	const r = spawnSync(process.execPath, ['dist/main.mjs', '--pick-port'], { cwd: ROOT, encoding: 'utf8' })
	const picked = Number((r.stdout || '').trim())
	if (!Number.isInteger(picked) || picked <= 0) {
		say(`port ${want ?? '(from config)'} looks busy and no free port could be found — starting anyway`)
		return want
	}
	say(`port ${want ?? '(from config)'} is already served — using ${picked} instead, so the installed service keeps its own port`)
	return String(picked)
}

let child = null
let timer = null
let building = false
let again = false

function build() {
	const r = spawnSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, encoding: 'utf8' })
	if (r.status !== 0) {
		// Keep serving the last good build rather than dying: a syntax error while
		// somebody is mid-edit must not take the remote view down with it.
		say(`build failed — still serving the previous build`)
		const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')
		if (detail) console.log(detail)
		return false
	}
	return true
}

// Resolved once, before the first launch. `dist/` has to exist for the check to run, so
// this happens after the initial build below rather than at import time.
let resolved = false

function launch() {
	if (!resolved) {
		resolved = true
		port = freePort(port)
	}
	const flags = ['dist/main.mjs', '--headless', ...(port ? ['--port', port] : []), ...passThrough]
	const proc = spawn(process.execPath, flags, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
	child = proc
	// The handler inspects ITS OWN process, not the module-level `child`.
	//
	// It used to read `child`, which by the time an exit event fired had already been
	// reassigned to the replacement — so a deliberate kill looked like a stranger
	// crashing, which scheduled another restart, which killed the replacement, which
	// looked like another crash. The service ended up down with the log accusing it of
	// crashing twice. `proc.restarting` is the flag we set before asking it to stop,
	// and `child !== proc` catches a process that has already been superseded.
	proc.on('exit', (code, signal) => {
		if (proc.restarting) return
		if (child !== proc) return
		say(`server exited (${signal ?? code}) — restarting in 2s`)
		setTimeout(() => restart('crash'), 2000)
	})
}

function restart(reason) {
	if (building) {
		again = true
		return
	}
	building = true
	say(`${reason} — rebuilding`)
	const ok = build()
	if (child) {
		child.restarting = true
		child.kill('SIGTERM')
		child = null
	}
	// Relaunch either way. A failed build leaves the previous bundle on disk, which
	// is the last thing known to work, and serving that beats serving nothing.
	if (!ok) say('serving the last good bundle')
	launch()
	building = false
	if (again) {
		again = false
		restart('more changes')
	}
}

/** One watcher per directory, debounced: an editor save fires several events. */
for (const dir of ['src', 'web']) {
	watch(join(ROOT, dir), { recursive: true }, (_type, file) => {
		if (!file) return
		// Ignore what the build itself writes, or every rebuild would trigger another.
		if (/^app\.(js|css)$/.test(file) || file.endsWith('.test.ts')) return
		if (!/\.(ts|tsx|css|html)$/.test(file)) return
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = null
			restart(`${dir}/${file} changed`)
		}, SETTLE_MS)
	})
}

const stop = () => {
	if (child) {
		child.restarting = true
		child.kill('SIGTERM')
	}
	say('watcher stopped')
	process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

say(`watching src/ and web/ — the browser view restarts itself on every change`)
if (build()) launch()
else launch()

/**
 * Serve the room over HTTP, so the other machines and the phone can see it.
 *
 * Read-only by construction: there is no endpoint that changes anything, on this
 * machine or in any session. That is a security decision rather than a missing
 * feature — the moment this is reachable from outside the house, "it can only
 * tell you things" is the property worth having.
 *
 * Authentication is a four-digit passcode, not "we are on the LAN". A network
 * boundary stops being a boundary the moment this goes behind a tunnel, and
 * retrofitting auth onto something already deployed is how it ends up never
 * happening. The code is typed into a page, verified here, and exchanged for a
 * session cookie — it never appears in a URL, in browser history, or in a proxy
 * log, and the browser never stores the code itself. Four digits are only safe
 * because of the throttle in auth.ts; see the note there.
 *
 * What it exposes is worth knowing: session titles, the last thing each one
 * said, filenames being edited and shell commands that were run.
 *
 * The routes live in serve/: control.ts for the ones that act on a session, reads.ts
 * for the ones that read a session's insides, static.ts for the client's files. This
 * file is the server itself — the live feed, the passcode, and which route answers.
 */
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { attempt, issue, lockedFor, triesLeft, valid } from './auth.ts'
import { build } from './version.ts'
import { available } from './update.ts'
import { collect } from './data.ts'
import { demoSessions } from './demo.ts'
import { press } from './data/press.ts'
import { usage } from './data/usage.ts'
import { type Call, MIME, type ServeOptions, addressOf, login, readBody, send, sessionOf } from './serve/http.ts'
import { clickRoute, keyRoute, sendRoute, spawnRoute, uploadRoute } from './serve/control.ts'
import { closedRoute, commandsRoute, projectsRoute, screenRoute, transcriptRoute } from './serve/reads.ts'
import { clientStamp, serveStatic } from './serve/static.ts'
import type { Session } from './data.ts'

export { screenTag } from './serve/reads.ts'
export type { ServeOptions }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The routes that change something, each behind the control gate. POST only. */
const ACTS = new Map<string, (c: Call) => Promise<void>>([
	['/api/send', sendRoute],
	['/api/spawn', spawnRoute],
	['/api/upload', uploadRoute],
	['/api/click', clickRoute],
	['/api/key', keyRoute],
])

/** The routes that read a session's insides, behind the control gate too. Reached only
 *  after the view passcode, like everything else that is not an act. */
const READS = new Map<string, (c: Call) => Promise<void>>([
	['/api/screen', screenRoute],
	['/api/transcript', transcriptRoute],
	['/api/commands', commandsRoute],
	['/api/projects', projectsRoute],
	['/api/closed', closedRoute],
])

/**
 * Every address this machine answers on, split by what kind of network it is.
 *
 * A VPN gives the machine another interface rather than needing another server,
 * so binding to 0.0.0.0 covers the LAN today and the tailnet later with no
 * change. Tailscale hands out addresses from the 100.64.0.0/10 carrier-grade NAT
 * range, which is how one is told apart from a home network here.
 */
export function addresses() {
	const lan: string[] = []
	const vpn: string[] = []
	for (const list of Object.values(os.networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family !== 'IPv4' || ni.internal) continue
			const [a, b] = ni.address.split('.').map(Number)
			// 100.64.0.0/10 — CGNAT, which in practice on a laptop means Tailscale
			if (a === 100 && b >= 64 && b <= 127) vpn.push(ni.address)
			else lan.push(ni.address)
		}
	}
	return { lan, vpn }
}

/**
 * One snapshot of everything a client is told, as JSON.
 *
 * Exported because there are now two callers and there must not be two shapes: the
 * HTTP route below, and `guildhall --sessions`, which is how the menu bar app reads
 * the room when the browser server is switched off. A second copy of this object
 * would drift the moment a field is added — which is exactly how four different
 * ideas of the settings defaults got into this codebase.
 *
 * `build()`, not the frozen `BUILD`: this process outlives releases, and a browser
 * that reads its version from here must not be told a stale one.
 */
export function snapshot(demo = false, codex = false): string {
	return JSON.stringify({
		sessions: demo ? demoSessions() : collect(codex),
		at: Date.now(),
		version: build(),
		update: available(),
		client: clientStamp(ROOT),
	})
}

export function createServer(opts: ServeOptions) {
	const sessions = () => (opts.demo ? demoSessions() : collect(!!opts.codex?.()))
	const payload = () => snapshot(opts.demo, !!opts.codex?.())
	const listeners = new Set<http.ServerResponse>()
	let last = ''
	/** When a message last went out, so the heartbeat below can be honest about ages. */
	let lastPush = 0

	/** Push only when something actually changed — a phone on wifi should not be
	 *  woken twice a second to be told nothing happened. */
	function tick() {
		// Nobody listening, nothing to compute.
		//
		// This built the entire payload — a full `collect()`, every two seconds —
		// whether or not a single browser was connected. Measured on a headless server
		// nobody had ever opened: 13.3 cpu-ms per tick, 0.67% of a core, forever.
		//
		// The same shape as the push bug below, one level up: that one stopped sending
		// what nobody needed, and left the WORK that produced it running regardless.
		//
		// Safe because the route writes `payload()` directly when a client connects, so
		// a new listener never waits for this timer. The only cost is a stale `last`
		// after an idle spell, which is one redundant push.
		if (!listeners.size) return
		const body = payload()
		// Ignore what changes on every tick BY CONSTRUCTION.
		//
		// `at` was already excluded. `stale` was not, and it is an age in milliseconds
		// — so it advanced by 2000 on every session every tick and this guard never
		// once matched. An office where nothing had happened for a day and a half still
		// pushed 8KB every two seconds to every client: ~350MB a day each, a phone
		// radio woken 43,000 times a day to say nothing, and a full list rebuild in
		// every browser. Measured by diffing consecutive messages — the only
		// differences were `at` and eleven `stale` values.
		//
		// `stale` is ignored outright and a heartbeat keeps the ages honest.
		//
		// Quantising it to 30s buckets was tried first and barely helped: eleven
		// sessions have eleven independent ages, so SOME bucket rolled over on nearly
		// every tick — measured 12 pushes in 40s against 20 unfixed, where the aim was
		// two. Ignoring it entirely would instead freeze the ages on screen, since the
		// rows render from this number.
		//
		// So: push when something real changed, and otherwise every 30 seconds
		// regardless. An idle office costs two messages a minute instead of thirty, and
		// no age on screen is ever more than half a minute stale.
		const same = body.replace(/"at":\d+/, '').replace(/"stale":\d+/g, '')
		const due = Date.now() - lastPush > 30_000
		if (same === last && !due) return
		last = same
		lastPush = Date.now()
		for (const res of listeners) res.write(`data: ${body}\n\n`)
	}
	const timer = setInterval(tick, 2000)
	timer.unref?.()

	/**
	 * Every request, wrapped so a handler cannot take the process with it.
	 *
	 * This listener was an unguarded `async` function, which means any rejection inside
	 * it is an unhandled rejection, and Node exits on those. It was not theoretical: a
	 * single POST whose message contained a NUL byte reached `execFile`, which throws
	 * synchronously on that, and the server died with no reply and no announcement.
	 *
	 * The specific hole is closed where it belongs, in the validation. This is here
	 * because "one bad request ends the service somebody is relying on remotely" is too
	 * sharp an edge to leave depending on every future handler being careful.
	 */
	const server = http.createServer((req, res) => {
		void handle(req, res).catch((e) => {
			// Its own words on the machine's screen; nothing but 500 to the caller, since
			// an internal error message is not the caller's business.
			console.error(`request failed: ${e instanceof Error ? e.message : String(e)}`)
			try {
				if (!res.headersSent) send(res, 500, MIME['.json'], '{"error":"failed"}')
				else res.end()
			} catch {
				// the socket went away, which is the normal way this ends
			}
		})
	})

	async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
		const addr = addressOf(req)
		const call: Call = { req, res, url, addr, opts, sessions }

		// The one place a request may carry a body, and the only one that changes
		// anything at all — and what it changes is who you are, never any session.
		if (req.method === 'POST' && url.pathname === '/auth') {
			const wait = lockedFor(addr)
			if (wait > 0) return login(res, 429, { waitSeconds: Math.ceil(wait / 1000) })
			const code = new URLSearchParams(await readBody(req)).get('code') ?? ''
			const result = attempt(addr, code)
			if (!result.ok) {
				const after = lockedFor(addr)
				return login(res, 401, after > 0 ? { waitSeconds: Math.ceil(after / 1000) } : { wrong: true, triesLeft: triesLeft(addr) })
			}
			res
				.writeHead(303, {
					location: '/',
					// the cookie is a session id, never the passcode, so a browser never
					// stores the code and restarting the server revokes every device
					'set-cookie': `gh_sid=${issue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
				})
				.end()
			return
		}

		const act = req.method === 'POST' ? ACTS.get(url.pathname) : undefined
		if (act) return act(call)

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			// nothing else here mutates anything; say so plainly rather than 404ing
			res.writeHead(405, { allow: 'GET, HEAD, POST /auth, POST /api/send, POST /api/upload, POST /api/click' }).end('read-only')
			return
		}

		if (!valid(sessionOf(req))) {
			const wait = lockedFor(addr)
			return login(res, 401, wait > 0 ? { waitSeconds: Math.ceil(wait / 1000) } : {})
		}

		/**
		 * Plan quota and today's spend.
		 *
		 * Its own endpoint rather than part of the session payload, which is fetched
		 * every couple of seconds by every client: this changes on the scale of hours
		 * and is fetched from someone else's API, so tying the two together would put
		 * a third-party call behind guildhall's own poll.
		 *
		 * Answers from cache always, refreshing behind the request. `null` before the
		 * first fetch lands, which the clients render as absent rather than as zero.
		 */
		if (url.pathname === '/api/usage') {
			send(res, 200, MIME['.json'], JSON.stringify(usage() ?? { limits: [], at: 0 }))
			return
		}

		if (url.pathname === '/api/sessions') {
			send(res, 200, MIME['.json'], payload())
			return
		}

		/**
		 * What has been committed and deployed, from pressroom.
		 *
		 * Behind the view passcode rather than the control token: this is commit
		 * subjects and deploy hostnames, which is the same order of disclosure as
		 * the session summaries already served here — not a terminal's contents.
		 *
		 * `?deploys=1` opts into the slow half. The local read is git only and takes
		 * about 2 seconds; adding workflow runs and Cloudflare deploys takes about
		 * 17, because every Worker repo spawns its own wrangler. Nobody should pay
		 * that on a poll they did not ask for.
		 */
		if (url.pathname === '/api/press') {
			press(url.searchParams.get('deploys') === '1')
				.then((snap) => send(res, 200, MIME['.json'], JSON.stringify(snap)))
				.catch(() => send(res, 200, MIME['.json'], '{"items":[],"repos":0,"local":true,"error":"could not read pressroom"}'))
			return
		}

		const read = READS.get(url.pathname)
		if (read) return read(call)

		if (url.pathname === '/api/stream') {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
				// a proxy that buffers turns a live feed into a slideshow
				'x-accel-buffering': 'no',
			})
			res.write(`data: ${payload()}\n\n`)
			listeners.add(res)
			// a comment line every 25s, so an idle connection is not reaped by a
			// phone radio going to sleep or a proxy timing it out
			const beat = setInterval(() => res.write(': ping\n\n'), 25_000)
			req.on('close', () => {
				clearInterval(beat)
				listeners.delete(res)
			})
			return
		}

		serveStatic(ROOT, res, url.pathname, String(req.headers['accept-encoding'] ?? ''))
	}

	server.on('close', () => clearInterval(timer))
	return server
}

export type { Session }

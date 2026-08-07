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
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { attempt, issue, lockedFor, triesLeft, valid } from './auth.ts'
import { loginPage } from './login.ts'
import { BUILD } from './version.ts'
import { available } from './update.ts'
import { collect } from './data.ts'
import { demoSessions } from './demo.ts'
import type { Session } from './data.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type ServeOptions = {
	port: number
	/** 0.0.0.0 reaches the LAN; 127.0.0.1 is localhost only, for tunnels. */
	host: string
	demo: boolean
}

/** The session this request carries, if any. Never the passcode itself. */
function sessionOf(req: http.IncomingMessage) {
	const auth = req.headers.authorization
	if (auth?.startsWith('Bearer ')) return auth.slice(7)
	const m = /(?:^|;\s*)gh_sid=([^;]+)/.exec(req.headers.cookie ?? '')
	return m ? decodeURIComponent(m[1]) : undefined
}

/** Who is asking, for throttling. Behind a proxy this is the proxy, which is
 *  acceptable here: there is no proxy on a home network or a tailnet. */
const addressOf = (req: http.IncomingMessage) => req.socket.remoteAddress ?? 'unknown'

/** Read a small form body. Capped, because nothing here needs more than 4 bytes. */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = ''
		req.on('data', (c) => {
			data += c
			if (data.length > 512) req.destroy()
		})
		req.on('end', () => resolve(data))
		req.on('error', () => resolve(''))
	})
}

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

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.json': 'application/json; charset=utf-8',
}

export function createServer(opts: ServeOptions) {
	const sessions = () => (opts.demo ? demoSessions() : collect())
	/** The browser shows the same version and update mark the terminal does, so a
	 *  stale phone tab is as visible as a stale terminal. */
	const payload = () => JSON.stringify({ sessions: sessions(), at: Date.now(), version: BUILD, update: available() })
	const listeners = new Set<http.ServerResponse>()
	let last = ''

	/** Push only when something actually changed — a phone on wifi should not be
	 *  woken twice a second to be told nothing happened. */
	function tick() {
		const body = payload()
		const same = body.replace(/"at":\d+/, '') // compare without the timestamp
		if (same === last) return
		last = same
		for (const res of listeners) res.write(`data: ${body}\n\n`)
	}
	const timer = setInterval(tick, 2000)
	timer.unref?.()

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
		const addr = addressOf(req)

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

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			// nothing else here mutates anything; say so plainly rather than 404ing
			res.writeHead(405, { allow: 'GET, HEAD, POST /auth' }).end('read-only')
			return
		}

		if (!valid(sessionOf(req))) {
			const wait = lockedFor(addr)
			return login(res, 401, wait > 0 ? { waitSeconds: Math.ceil(wait / 1000) } : {})
		}

		if (url.pathname === '/api/sessions') {
			send(res, 200, MIME['.json'], payload())
			return
		}

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

		serveStatic(res, url.pathname)
	})

	server.on('close', () => clearInterval(timer))
	return server
}

/** The passcode screen, in whichever state applies. Never cached — a stale copy
 *  of a lockout message would be wrong the moment the lock expires. */
function login(res: http.ServerResponse, code: number, state: Parameters<typeof loginPage>[0]) {
	res.writeHead(code, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }).end(loginPage(state))
}

function send(res: http.ServerResponse, code: number, type: string, body: string | Buffer) {
	res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
}

/** Static files, confined to web/ and assets/ — never an arbitrary path. */
function serveStatic(res: http.ServerResponse, pathname: string) {
	const rel = pathname === '/' ? '/index.html' : pathname
	const roots = [path.join(ROOT, 'web'), path.join(ROOT, 'assets')]
	for (const root of roots) {
		const file = path.resolve(root, '.' + rel)
		// resolve first, then check containment: `..` in the URL must not escape
		if (!file.startsWith(root + path.sep)) continue
		try {
			const body = fs.readFileSync(file)
			send(res, 200, MIME[path.extname(file)] ?? 'application/octet-stream', body)
			return
		} catch {}
	}
	send(res, 404, 'text/plain; charset=utf-8', 'not found')
}


export type { Session }

/**
 * Serve the room over HTTP, so the other machines and the phone can see it.
 *
 * Read-only by construction: there is no endpoint that changes anything, on this
 * machine or in any session. That is a security decision rather than a missing
 * feature — the moment this is reachable from outside the house, "it can only
 * tell you things" is the property worth having.
 *
 * Authentication is a shared token, not "we are on the LAN". LAN-only is the
 * plan today, but a network boundary stops being a boundary the moment this is
 * put behind a tunnel, and retrofitting auth onto something already deployed is
 * how it ends up never happening. The token arrives once in a URL, is exchanged
 * for a cookie, and the URL is replaced — so it is not left sitting in browser
 * history or in a proxy's access log.
 *
 * What it exposes is worth knowing: session titles, the last thing each one
 * said, filenames being edited and shell commands that were run.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { collect } from './data.ts'
import { demoSessions } from './demo.ts'
import type { Session } from './data.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type ServeOptions = {
	port: number
	/** 0.0.0.0 reaches the LAN; 127.0.0.1 is localhost only, for tunnels. */
	host: string
	token: string
	demo: boolean
}

/** Timing-safe, and length-safe: timingSafeEqual throws on a length mismatch. */
function tokenMatches(given: string | undefined, expected: string) {
	if (!given) return false
	const a = Buffer.from(given)
	const b = Buffer.from(expected)
	if (a.length !== b.length) return false
	return crypto.timingSafeEqual(a, b)
}

function presentedToken(req: http.IncomingMessage, url: URL) {
	const auth = req.headers.authorization
	if (auth?.startsWith('Bearer ')) return auth.slice(7)
	const cookie = req.headers.cookie ?? ''
	const m = /(?:^|;\s*)gh_token=([^;]+)/.exec(cookie)
	if (m) return decodeURIComponent(m[1])
	return url.searchParams.get('k') ?? undefined
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

/**
 * The token, kept across restarts.
 *
 * Regenerating it every launch would mean re-pairing the phone every time the
 * server bounces, which is exactly the friction that ends with someone turning
 * authentication off. Stored 0600 in the user's config directory.
 */
export function persistedToken(): string {
	const dir = path.join(os.homedir(), '.config', 'guildhall')
	const file = path.join(dir, 'token')
	try {
		const existing = fs.readFileSync(file, 'utf8').trim()
		if (existing.length >= 8) return existing
	} catch {}
	const token = makeToken()
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
		fs.writeFileSync(file, token + '\n', { mode: 0o600 })
	} catch {}
	return token
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
	const listeners = new Set<http.ServerResponse>()
	let last = ''

	/** Push only when something actually changed — a phone on wifi should not be
	 *  woken twice a second to be told nothing happened. */
	function tick() {
		const payload = JSON.stringify({ sessions: sessions(), at: Date.now() })
		const body = payload.replace(/"at":\d+/, '') // compare without the timestamp
		if (body === last) return
		last = body
		for (const res of listeners) res.write(`data: ${payload}\n\n`)
	}
	const timer = setInterval(tick, 2000)
	timer.unref?.()

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			// nothing here mutates anything; say so plainly rather than 404ing
			res.writeHead(405, { allow: 'GET, HEAD' }).end('read-only')
			return
		}

		if (!tokenMatches(presentedToken(req, url), opts.token)) {
			res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(
				'<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
					'<body style="font:16px system-ui;background:#191722;color:#d0d0d0;padding:2rem">' +
					'<h1 style="font-size:1.1rem">guildhall</h1><p>This link needs its passcode. ' +
					'Open the URL printed when the server started.</p>',
			)
			return
		}

		// Swap the token in the URL for a cookie, so it leaves the address bar and
		// the browser history, then reload clean.
		if (url.searchParams.has('k')) {
			res
				.writeHead(302, {
					location: url.pathname,
					'set-cookie': `gh_token=${encodeURIComponent(opts.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
				})
				.end()
			return
		}

		if (url.pathname === '/api/sessions') {
			send(res, 200, MIME['.json'], JSON.stringify({ sessions: sessions(), at: Date.now() }))
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
			res.write(`data: ${JSON.stringify({ sessions: sessions(), at: Date.now() })}\n\n`)
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

/** A token you can type on a phone: no ambiguous characters, still 60+ bits. */
export function makeToken() {
	const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
	const bytes = crypto.randomBytes(12)
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export type { Session }

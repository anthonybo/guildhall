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
import { controlAttempt, controlLockedFor, controlReachable } from './controlauth.ts'
import { ask, readGrid } from './control.ts'
import { demoSessions } from './demo.ts'
import { press } from './data/press.ts'
import type { Session } from './data.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A wait that means "may I do this?" rather than "what do you think?".
 *
 * Deliberately broader than the one string this codebase writes today. If Claude
 * Code ever words it differently, the failure that matters is the one where a
 * prompt slips through unmatched, so this errs toward refusing a send.
 */
const PERMISSION = /permission|approv|allow|trust/i

export type ServeOptions = {
	port: number
	/** 0.0.0.0 reaches the LAN; 127.0.0.1 is localhost only, for tunnels. */
	host: string
	demo: boolean
	/** Whether typing into a session is permitted at all. A function, not a
	 *  boolean, so turning it off in the running app takes effect immediately
	 *  rather than at the next restart. */
	control?: () => boolean
	/** Announce a remote send on this machine's own screen. A caller that can act
	 *  here must not be able to do it invisibly. */
	onSend?: (proj: string, text: string, ok: boolean) => void
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

/** Read a small request body. Capped: the passcode form needs four bytes and a
 *  prompt needs a few thousand, so 8KB is generous for both and refuses the rest. */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = ''
		req.on('data', (c) => {
			data += c
			if (data.length > 8192) req.destroy()
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

		/**
		 * Typing into a session's real terminal.
		 *
		 * The only route in this server that changes anything outside itself, and
		 * it is guarded four ways, each closing a different hole:
		 *
		 *  - the feature is off unless `control` was deliberately enabled;
		 *  - the caller must be on loopback or a tailnet, because a shared secret
		 *    on a LAN is one guest network away from running commands here;
		 *  - the control token is required, and it is not the view passcode — a
		 *    device that may watch has not thereby been trusted to type;
		 *  - the token goes in a header, never a query string, so it cannot be
		 *    captured by a proxy log, a referrer, or browser history.
		 */
		if (req.method === 'POST' && url.pathname === '/api/send') {
			if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
			if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
			const waitCtl = controlLockedFor(addr)
			if (waitCtl > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCtl / 1000)}s"}`)
			if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
			let body: { id?: string; text?: string }
			try {
				body = JSON.parse(await readBody(req))
			} catch {
				return send(res, 400, MIME['.json'], '{"error":"bad json"}')
			}
			const target = sessions().find((s) => s.id === body.id)
			if (!target) return send(res, 404, MIME['.json'], '{"error":"no such session"}')
			// The fifth guard, and the one the other four missed.
			//
			// control.ts refuses `y`, `n`, `a` and `d` so that no remote caller can
			// approve tool use. But a permission prompt is a NUMBERED list — "1. Yes,
			// 2. Yes and don't ask again, 3. No" — and `ask` sends text followed by
			// Enter, so "1" walks straight through a refusal list built out of
			// letters. The guard was letter-shaped and the prompt is number-shaped.
			//
			// Claude Code's own registry reports which sessions are sitting on a modal
			// prompt, so this reads a first-party fact rather than guessing from the
			// screen — and a prompt that asks to run a command stays answerable only
			// by someone at the machine, which was the point of the whole design.
			// Checked before the workspace lookup: this is a refusal about what the
			// session is being asked, not about whether the plumbing to reach it exists.
			if (PERMISSION.test(target.waitingFor ?? '')) return send(res, 409, MIME['.json'], '{"error":"this session is waiting on a permission prompt — that has to be answered at the machine"}')
			if (!target.workspace) return send(res, 404, MIME['.json'], '{"error":"no such session, or it is not in a cmux tab"}')
			const out = await ask(target.workspace, String(body.text ?? ''))
			// Every send is announced on the machine's own screen. A remote caller
			// must not be able to act here invisibly.
			opts.onSend?.(target.proj, String(body.text ?? '').slice(0, 200), out.ok)
			return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true } : { error: out.error }))
		}

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			// nothing else here mutates anything; say so plainly rather than 404ing
			res.writeHead(405, { allow: 'GET, HEAD, POST /auth, POST /api/send' }).end('read-only')
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

		/**
		 * What a session's terminal is showing right now.
		 *
		 * Behind the control token rather than the view passcode, even though it
		 * only reads. A screen is scrollback — source, command output, whatever a
		 * session has printed — which is a far larger disclosure than the summaries
		 * the rest of this serves, and it should not come with a four-digit code.
		 */
		if (url.pathname === '/api/screen') {
			if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
			if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
			const waitCtl = controlLockedFor(addr)
			if (waitCtl > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCtl / 1000)}s"}`)
			if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
			const target = sessions().find((s) => s.id === url.searchParams.get('id'))
			if (!target?.workspace) return send(res, 404, MIME['.json'], '{"error":"no such session, or it is not in a cmux tab"}')
			// The styled grid, not flattened text: a TUI is colour and position, and
			// plain text throws both away. cmux hands back JSON already, so this is
			// passed through rather than re-encoded.
			const out = await readGrid(target.workspace)
			if (!out.ok) return send(res, 400, MIME['.json'], JSON.stringify({ error: out.error }))
			return send(res, 200, MIME['.json'], out.text)
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

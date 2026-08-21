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
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { attempt, issue, lockedFor, triesLeft, valid } from './auth.ts'
import { loginPage } from './login.ts'
import { build } from './version.ts'
import { available } from './update.ts'
import { collect } from './data.ts'
import { controlAttempt, controlLockedFor, controlReachable } from './controlauth.ts'
import { ask, askCodex, press as pressKey, readGrid, spawn } from './control.ts'
import { reach } from './cmuxreach.ts'
import { demoSessions } from './demo.ts'
import { press } from './data/press.ts'
import { spawnable } from './data/projects.ts'
import { usage } from './data/usage.ts'
import type { Session } from './data.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Answering prompts from away: what changed, and what actually protects you.
 *
 * There used to be a guard here refusing any send to a session whose `waitingFor`
 * looked like a permission request. It has been removed because it did nothing.
 * `waitingFor` is not a field Claude Code writes: it is absent from the schema in
 * all thirteen live registry files on this machine, and the only value guildhall
 * ever puts there itself is the literal "answer a question", which the pattern did
 * not match. A guard that cannot fire is worse than no guard, because the README
 * described it as protection somebody was relying on.
 *
 * Answering prompts is now a deliberate feature — see `/api/key`. A session
 * blocked on a question is the exact moment being away from the machine hurts
 * most, and refusing to help then made the whole browser view decorative.
 *
 * What is actually holding the line, all of it real and all of it testable:
 *
 *  - control is off unless deliberately turned on, and it is its own switch
 *  - loopback or a tailnet only, never a plain LAN, whatever the config says
 *  - a separate password from the view passcode, scrypt-hashed, throttled
 *  - four keys and no more: up, down, enter, escape. No text, no letters, nothing
 *    that could type a command into a shell sitting at a prompt
 *  - every press is announced on the machine's own screen, so acting here
 *    remotely is possible and doing it unseen is not
 */

export type ServeOptions = {
	port: number
	/** 0.0.0.0 reaches the LAN; 127.0.0.1 is localhost only, for tunnels. */
	host: string
	demo: boolean
	/** Include Codex sessions as well as Claude Code ones. Off by default; see
	 *  docs/codex.md.
	 *
	 *  A function for the same reason `control` below is one, and it was a plain
	 *  boolean first: captured once at `createServer`, so flipping the setting in
	 *  the running app changed the room and left the browser serving Claude-only
	 *  until a restart. Two surfaces of one program disagreeing about which
	 *  harnesses exist is the shape of bug this whole setting was meant to avoid. */
	codex?: () => boolean
	/** Whether typing into a session is permitted at all. A function, not a
	 *  boolean, so turning it off in the running app takes effect immediately
	 *  rather than at the next restart. */
	control?: () => boolean
	/** Announce a remote send on this machine's own screen. A caller that can act
	 *  here must not be able to do it invisibly. */
	onSend?: (proj: string, text: string, ok: boolean) => void
}

/**
 * Refuse in guildhall's own words when this process cannot drive cmux at all.
 *
 * Checked alongside the other control gates rather than left to fail at the cmux call,
 * because what came back otherwise was cmux's sentence — "only processes started inside
 * cmux can connect" — shown on a phone under a panel that said control was on. True,
 * and useless: it names cmux's rule and not what to do about it.
 *
 * 503 rather than 403: nothing about the REQUEST is wrong. The caller is on the right
 * network with the right password, and the server simply cannot carry it out.
 */
function cmuxRefusal(res: http.ServerResponse): boolean {
	const r = reach()
	if (r.ok) return false
	send(res, 503, MIME['.json'], JSON.stringify({ error: `${r.why}. ${r.fix}` }))
	return true
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
		client: clientStamp(),
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
			// No cmux check HERE: this route serves both harnesses, and a Codex message goes
			// through the codex CLI, which has nothing to do with cmux. Gating the route
			// would have refused Codex sends on a machine where only cmux was unreachable.
			// The check sits below, on the branch that actually needs a cmux pane.
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
			// A Codex session is not a cmux pane, so it is reached by its own route rather
			// than being refused for lacking a tab. Every guard above still applied: this
			// is only about which CLI carries the message the last few inches.
			//
			// Both branches converge below, so the announcement on this machine's screen
			// and the throttle and the password are one implementation for both harnesses.
			// The 404 stays a 404. Folding it into the shared reply below turned "there is
			// no tab to reach this through" into a 400, which is a different statement —
			// one says the request named something unreachable, the other says the send was
			// attempted and failed. A test caught it.
			// A cmux pane is about to be driven, so this is where the ability to drive one
			// belongs — after the target is known to be a cmux session.
			if (target.agent !== 'codex' && cmuxRefusal(res)) return
			if (target.agent !== 'codex' && !target.workspace) {
				return send(res, 404, MIME['.json'], '{"error":"no such session, or it is not in a cmux tab"}')
			}
			const out =
				target.agent === 'codex'
					? await askCodex(target.id, String(body.text ?? ''))
					: await ask(target.workspace!, String(body.text ?? ''))
			// Every send is announced on the machine's own screen. A remote caller
			// must not be able to act here invisibly.
			opts.onSend?.(target.proj, String(body.text ?? '').slice(0, 200), out.ok)
			// `note` rides along with a SUCCESS. The send did happen; what it needs is a
			// caveat, because a message that has been queued behind a background job looks
			// exactly like one that vanished, and looking like it vanished is what made
			// somebody send everything twice.
			return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true, ...(target.deferred ? { note: target.deferred } : {}) } : { error: out.error }))
		}

		/**
		 * Start a new session, in a directory this server chose.
		 *
		 * The most powerful call here: a session can edit files and run commands, so
		 * being able to create one is being able to do both. It carries every guard
		 * the send path does — control armed, loopback or tailnet only, throttled,
		 * control password — plus one that only applies here: the directory must be
		 * one `spawnable()` offered. A path taken from the request body would be
		 * arbitrary code execution in a text field, and no amount of validation on a
		 * string makes a client-supplied cwd safe.
		 *
		 * No prompt is passed. The session comes up empty and is typed into through
		 * the same guarded path as every other message, which is also what lets Claude
		 * Code name it from the conversation exactly as it does normally.
		 */
		if (req.method === 'POST' && url.pathname === '/api/spawn') {
			if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
			if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
			if (cmuxRefusal(res)) return
			const waitCtl = controlLockedFor(addr)
			if (waitCtl > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCtl / 1000)}s"}`)
			if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
			let body: { dir?: string }
			try {
				body = JSON.parse(await readBody(req))
			} catch {
				return send(res, 400, MIME['.json'], '{"error":"bad json"}')
			}
			const out = await spawn(String(body.dir ?? ''))
			// Announced on the machine's own screen like a send. Starting a session
			// remotely is possible; doing it unseen is not.
			opts.onSend?.(path.basename(String(body.dir ?? '')), 'started a new session', out.ok)
			return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true, workspace: out.text } : { error: out.error }))
		}

		/**
		 * Move the caret in a prompt, or confirm it.
		 *
		 * Claude Code asks its questions as a list you arrow through, and from a phone
		 * there was no way to answer one — the moment a session most needs you was the
		 * moment you could do least. Four keys only; see `press` in control.ts for why
		 * that list is not longer.
		 */
		if (req.method === 'POST' && url.pathname === '/api/key') {
			if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
			if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
			if (cmuxRefusal(res)) return
			const waitKey = controlLockedFor(addr)
			if (waitKey > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitKey / 1000)}s"}`)
			if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
			let body: { id?: string; key?: string }
			try {
				body = JSON.parse(await readBody(req))
			} catch {
				return send(res, 400, MIME['.json'], '{"error":"bad json"}')
			}
			const target = sessions().find((s) => s.id === body.id)
			if (!target?.workspace) return send(res, 404, MIME['.json'], '{"error":"no such session, or it is not in a cmux tab"}')
			const out = await pressKey(target.workspace, String(body.key ?? ''))
			// Announced like a send. A key that answers a prompt is a decision, and a
			// decision made from away must still be visible to whoever is here.
			opts.onSend?.(target.proj, `pressed ${String(body.key ?? '').slice(0, 12)}`, out.ok)
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
			if (cmuxRefusal(res)) return
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
			// Do not send a screen that has not changed.
			//
			// This grid is 68KB — measured, from a real cmux pane — and it went over the
			// wire every two seconds whether or not a single character had moved. On a
			// phone that is 34KB/s, continuously, to watch a session that is thinking.
			//
			// Worse than the bytes is what they occupy: at 40KB/s a read takes 2.1s
			// against a 2s poll, so reads overlap, and a browser allows six connections
			// to one host — one of which is permanently the event stream. Overlapping
			// reads eat the rest, and then a send has nowhere to go and simply waits.
			// That is the reported "I pressed Send and nothing happened".
			//
			// The same lesson as the stream's push guard, one layer down: compute it if
			// you must, but do not SEND what nobody needs. An idle terminal now costs a
			// couple of hundred bytes a poll instead of 68KB.
			const tag = screenTag(out.text)
			if (req.headers['if-none-match'] === tag) {
				res.writeHead(304, { etag: tag, 'cache-control': 'no-store' }).end()
				return
			}
			res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store', etag: tag }).end(out.text)
			return
		}

		/** Directories a session can be started in. Behind the control token because
		 *  it is only useful to something that can spawn, and it names your folders. */
		if (url.pathname === '/api/projects') {
			if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
			if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
			if (cmuxRefusal(res)) return
			if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
			return send(res, 200, MIME['.json'], JSON.stringify({ projects: spawnable() }))
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
	}

	server.on('close', () => clearInterval(timer))
	return server
}

/**
 * A fingerprint of what a screen will actually DRAW.
 *
 * Not a hash of the reply, which was the obvious thing and would never once have
 * matched. Two reads of a terminal nobody has touched differ in exactly two
 * fields — `render_revision` and `terminal_theme_revision`, cmux's own
 * bookkeeping counters, which tick regardless — while every field the browser
 * draws from is byte-identical. Hashing the envelope would have shipped a
 * conditional request that could not fire, and looked like a saving.
 *
 * So the fingerprint covers exactly the six fields `paint()` reads and nothing
 * else. Anything cmux adds later is ignored by default, which is the safe
 * direction for a cache key: a new field that should have busted it costs a
 * missed repaint on an otherwise identical screen, where including everything
 * costs the whole optimisation.
 *
 * Falls back to the raw text if the reply is not what we expect. A screen that
 * cannot be parsed is still a screen that must be delivered.
 */
export function screenTag(text: string) {
	let key = text
	try {
		const g = JSON.parse(text).render_grid
		if (g) key = JSON.stringify([g.rows, g.columns, g.styles, g.row_spans, g.terminal_foreground, g.terminal_background])
	} catch {}
	return `"${crypto.createHash('sha1').update(key).digest('base64url').slice(0, 22)}"`
}

/** The passcode screen, in whichever state applies. Never cached — a stale copy
 *  of a lockout message would be wrong the moment the lock expires. */
function login(res: http.ServerResponse, code: number, state: Parameters<typeof loginPage>[0]) {
	res.writeHead(code, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }).end(loginPage(state))
}

function send(res: http.ServerResponse, code: number, type: string, body: string | Buffer) {
	res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
}

/**
 * A fingerprint of the browser client, so a tab can tell it has gone stale.
 *
 * `web/` is read from disk on every request, which means a rebuild is live the
 * moment it lands — but only to a browser that asks again, and a phone left open
 * on the sofa never does. So the fingerprint rides the feed the page is already
 * listening to, and the page reloads itself when it changes.
 *
 * Size and mtime rather than a hash of the contents: this is called on every
 * stream tick, hashing a 100KB bundle twice a second to detect a change that
 * happens twice a day is a poor trade, and stat is enough to notice a rebuild.
 */
function clientStamp() {
	let stamp = ''
	for (const name of ['app.js', 'app.css', 'index.html']) {
		try {
			const s = fs.statSync(path.join(ROOT, 'web', name))
			stamp += `${s.size}:${Math.round(s.mtimeMs)};`
		} catch {
			stamp += 'missing;'
		}
	}
	return stamp
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

/**
 * What every route in the server shares: its options, the shape of one call, and the
 * small helpers for reading a request and answering it.
 */
import http from 'node:http'
import { loginPage } from '../login.ts'
import { reachSoon } from '../cmuxreach.ts'
import type { Session } from '../data.ts'

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

/** One request, as a route sees it. */
export type Call = {
	req: http.IncomingMessage
	res: http.ServerResponse
	url: URL
	/** Who is asking, for throttling — see `addressOf`. */
	addr: string
	opts: ServeOptions
	/** The room as it is right now, demo or real. */
	sessions: () => Session[]
}

export const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.json': 'application/json; charset=utf-8',
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
export async function cmuxRefusal(res: http.ServerResponse): Promise<boolean> {
	const r = await reachSoon()
	if (r.ok) return false
	send(res, 503, MIME['.json'], JSON.stringify({ error: `${r.why}. ${r.fix}` }))
	return true
}

/** The session this request carries, if any. Never the passcode itself. */
export function sessionOf(req: http.IncomingMessage) {
	const auth = req.headers.authorization
	if (auth?.startsWith('Bearer ')) return auth.slice(7)
	const m = /(?:^|;\s*)gh_sid=([^;]+)/.exec(req.headers.cookie ?? '')
	return m ? decodeURIComponent(m[1]) : undefined
}

/** Who is asking, for throttling. Behind a proxy this is the proxy, which is
 *  acceptable here: there is no proxy on a home network or a tailnet. */
export const addressOf = (req: http.IncomingMessage) => req.socket.remoteAddress ?? 'unknown'

/** Read a small request body. Capped: the passcode form needs four bytes, so 8KB is
 *  generous for everything except a message, which passes its own cap.
 *
 *  A message got 8KB too, and a pasted log is bigger than that. Over the cap the
 *  connection is cut, which the browser can only report as "could not reach
 *  guildhall" — with the text handed back, so every retry failed the same way. */
export function readBody(req: http.IncomingMessage, cap = 8192): Promise<string> {
	return new Promise((resolve) => {
		let data = ''
		req.on('data', (c) => {
			data += c
			if (data.length > cap) req.destroy()
		})
		req.on('end', () => resolve(data))
		req.on('error', () => resolve(''))
	})
}

/** The passcode screen, in whichever state applies. Never cached — a stale copy
 *  of a lockout message would be wrong the moment the lock expires. */
export function login(res: http.ServerResponse, code: number, state: Parameters<typeof loginPage>[0]) {
	res.writeHead(code, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }).end(loginPage(state))
}

export function send(res: http.ServerResponse, code: number, type: string, body: string | Buffer) {
	res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
}

/**
 * The routes that read a session's insides: its screen, its whole conversation, the
 * commands it would take, and the folders and closed sessions a new one can start from.
 *
 * Read-only, and still behind the control token rather than the view passcode. Each
 * says why on its own route; the short version is that these disclose far more than
 * the summaries the room is built from.
 */
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { controlAttempt, controlLockedFor, controlReachable } from '../controlauth.ts'
import { readGrid } from '../control.ts'
import { historyPage } from '../data/history.ts'
import { commands } from '../data/commands.ts'
import { closedSessions } from '../data/closed.ts'
import { spawnable } from '../data/projects.ts'
import { type Call, MIME, cmuxRefusal, send } from './http.ts'

/**
 * What a session's terminal is showing right now.
 *
 * Behind the control token rather than the view passcode, even though it
 * only reads. A screen is scrollback — source, command output, whatever a
 * session has printed — which is a far larger disclosure than the summaries
 * the rest of this serves, and it should not come with a four-digit code.
 */
export async function screenRoute(c: Call) {
	const { req, res, url, addr, opts, sessions } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	if (await cmuxRefusal(res)) return
	const waitCtl = controlLockedFor(addr)
	if (waitCtl > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCtl / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	const target = sessions().find((s) => s.id === url.searchParams.get('id'))
	if (!target?.workspace) return send(res, 404, MIME['.json'], '{"error":"no such session, or it is not in a cmux tab"}')
	// The styled grid, not flattened text: a TUI is colour and position, and
	// plain text throws both away. cmux hands back JSON already, so this is
	// passed through rather than re-encoded.
	// The session's own pane, or another pane of the same tab when asked — only one
	// cmux listed for this tab, never an id taken on trust. Viewing only: sends and
	// keys always go to the session's own pane.
	const asked = url.searchParams.get('pane')
	const other = asked ? target.panes?.find((p) => p.surface === asked) : undefined
	if (asked && !other) return send(res, 404, MIME['.json'], '{"error":"no such pane in this tab"}')
	const out = await readGrid({ workspace: target.workspace, surface: other?.surface ?? target.surface })
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
	// Compressed. The grid is JSON that repeats itself — measured, a 51.4KB screen
	// gzips to 3.8KB in 5ms — and it was going to a phone raw, every two seconds.
	// That was most of why switching panes or tapping a backlog took seconds to show.
	if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
		res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store', etag: tag, 'content-encoding': 'gzip', vary: 'accept-encoding' }).end(zlib.gzipSync(out.text, { level: 6 }))
		return
	}
	res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store', etag: tag }).end(out.text)
	return
}

/**
 * A session's conversation, older than `before`, newest last.
 *
 * The terminal view can never show this. Claude Code draws on the alternate
 * screen and Ghostty hardcodes `scrollback-limit = 0` there, so the lines are
 * gone before cmux sees them — every Claude pane here reports
 * `scrollback_rows: 0` against 115 for a plain shell. Rebuilding it from polled
 * screens was tried and measured, and does not work; see MISTAKES.md.
 *
 * Behind the control token, exactly like `/api/screen` and for a stronger
 * version of the same reason: a screen is what a session is showing now, and
 * this is everything it has ever said.
 */
export async function transcriptRoute(c: Call) {
	const { req, res, url, addr, opts, sessions } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	const waitT = controlLockedFor(addr)
	if (waitT > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitT / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	const id = url.searchParams.get('id') ?? ''
	if (!sessions().some((s) => s.id === id)) return send(res, 404, MIME['.json'], '{"error":"no such session"}')
	const raw = url.searchParams.get('before')
	// A junk cursor must not become `NaN` and read as "from the end" — that would
	// silently restart the paging and loop the same page forever.
	const before = raw === null ? undefined : Number(raw)
	if (before !== undefined && !Number.isInteger(before)) return send(res, 400, MIME['.json'], '{"error":"bad cursor"}')
	const page = historyPage(id, before)
	if (!page) return send(res, 404, MIME['.json'], '{"error":"no transcript on disk for that session"}')
	return send(res, 200, MIME['.json'], JSON.stringify(page))
}

/**
 * The slash commands this session would accept.
 *
 * Behind the control token because it exists to be typed with, and because it
 * names your skills and your project's own commands. Read on demand — this is
 * reached when somebody opens the picker, not on any poll.
 *
 * A session id is optional. Without one the answer is what is available
 * everywhere; with one it also includes that project's own commands, which are
 * the ones that would actually run there.
 */
export async function commandsRoute(c: Call) {
	const { req, res, url, addr, opts, sessions } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	const waitCmd = controlLockedFor(addr)
	if (waitCmd > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCmd / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	const forId = url.searchParams.get('id')
	const cwd = forId ? sessions().find((s) => s.id === forId)?.cwd : undefined
	return send(res, 200, MIME['.json'], JSON.stringify({ commands: commands(cwd) }))
}

/** Directories a session can be started in. Behind the control token because
 *  it is only useful to something that can spawn, and it names your folders. */
export async function projectsRoute(c: Call) {
	const { req, res, addr, opts } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	if (await cmuxRefusal(res)) return
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	return send(res, 200, MIME['.json'], JSON.stringify({ projects: spawnable() }))
}

/**
 * Sessions you closed, which you can open again.
 *
 * Behind the control gate like `/api/projects`, and for a stronger reason than that
 * one: this lists the directories and opening prompts of past work, which is the
 * kind of thing that has no business being readable by anyone who can reach the
 * port. The list itself changes nothing — reopening goes through `/api/spawn`.
 */
export async function closedRoute(c: Call) {
	const { req, res, addr, opts } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	if (await cmuxRefusal(res)) return
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	return send(res, 200, MIME['.json'], JSON.stringify({ closed: closedSessions() }))
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

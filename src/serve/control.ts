/**
 * The routes that act on a session: type into it, press a key, click a pane, attach an
 * image, start one. Everything here is behind the control gate, never the view passcode.
 *
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
import path from 'node:path'
import { claim, finish, release } from '../once.ts'
import { controlAttempt, controlLockedFor, controlReachable } from '../controlauth.ts'
import { MAX_ASK, ask } from '../ask.ts'
import { MAX_UPLOAD, readBytes, saveUpload } from '../upload.ts'
import { askCodex, click, press as pressKey, spawn, trustNew } from '../control.ts'
import { createProject } from '../data/projects.ts'
import { type Call, MIME, cmuxRefusal, readBody, send } from './http.ts'

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
export async function sendRoute(c: Call) {
	const { req, res, addr, opts, sessions } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	// No cmux check HERE: this route serves both harnesses, and a Codex message goes
	// through the codex CLI, which has nothing to do with cmux. Gating the route
	// would have refused Codex sends on a machine where only cmux was unreachable.
	// The check sits below, on the branch that actually needs a cmux pane.
	const waitCtl = controlLockedFor(addr)
	if (waitCtl > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCtl / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	let body: { id?: string; text?: string; key?: string }
	try {
		// Room for the longest message ask() takes, as JSON: a control character
		// escapes to six bytes, so that is the worst case, plus the envelope.
		body = JSON.parse(await readBody(req, MAX_ASK * 6 + 1024))
	} catch {
		return send(res, 400, MIME['.json'], '{"error":"bad json"}')
	}
	/**
	 * At most once, however many times this is asked for.
	 *
	 * A lost reply looks exactly like a lost request, so a send that succeeded and
	 * failed to say so gets typed again by whoever is holding the phone. See
	 * once.ts, and MISTAKES.md for the five fixes that missed this.
	 *
	 * An absent key still sends: an older client must keep working, and it is no
	 * worse off than it was.
	 */
	const key = typeof body.key === 'string' && body.key.length >= 8 && body.key.length <= 128 ? body.key : null
	if (key) {
		const already = claim(key)
		if (already && 'done' in already) {
			// Byte-identical to what the first attempt returned, so a retry cannot be
			// told apart from the send that worked.
			res.writeHead(already.done.status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' }).end(already.done.body)
			return
		}
		if (already) return send(res, 202, MIME['.json'], '{"ok":true,"note":"already sending that message"}')
	}
	/** Answer, and remember the answer against the key. */
	const reply = (status: number, payload: string) => {
		if (key) finish(key, { status, body: payload })
		return send(res, status, MIME['.json'], payload)
	}
	/** Refused before anything was typed: the key must stay usable. */
	const refuse = (status: number, payload: string) => {
		if (key) release(key)
		return send(res, status, MIME['.json'], payload)
	}
	const target = sessions().find((s) => s.id === body.id)
	if (!target) return refuse(404, '{"error":"no such session"}')
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
	// A Codex session IN a cmux pane is typed into like any other — exactly what the
	// person at the machine would do, and the terminal panel shows it land. Measured
	// on a scratch Codex pane: 60 to 8,000 characters each arrived once and was
	// answered. `codex queue` stays for a Codex session with no pane to type into.
	const queued = target.agent === 'codex' && !target.workspace
	if (!queued && (await cmuxRefusal(res))) return
	if (!queued && !target.workspace) {
		return refuse(404, '{"error":"no such session, or it is not in a cmux tab"}')
	}
	const out = queued ? await askCodex(target.id, String(body.text ?? '')) : await ask({ workspace: target.workspace!, surface: target.surface }, String(body.text ?? ''))
	// Every send is announced on the machine's own screen. A remote caller
	// must not be able to act here invisibly.
	opts.onSend?.(target.proj, String(body.text ?? '').slice(0, 200), out.ok)
	// `note` rides along with a SUCCESS. The send did happen; what it needs is a
	// caveat, because a message that has been queued behind a background job looks
	// exactly like one that vanished, and looking like it vanished is what made
	// somebody send everything twice.
	// Recorded against the key on BOTH outcomes. A failed send that is retried with
	// the same key must not be attempted a second time either — the whole point is
	// that one composed message reaches the session at most once.
	return reply(out.ok ? 200 : 400, JSON.stringify(out.ok ? { ok: true, ...(target.deferred ? { note: target.deferred } : {}) } : { error: out.error }))
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
export async function spawnRoute(c: Call) {
	const { req, res, addr, opts } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	if (await cmuxRefusal(res)) return
	const waitCtl = controlLockedFor(addr)
	if (waitCtl > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitCtl / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	let body: { dir?: string; resume?: string; create?: string }
	try {
		body = JSON.parse(await readBody(req))
	} catch {
		return send(res, 400, MIME['.json'], '{"error":"bad json"}')
	}
	// `create` makes a new project folder first and starts there. A name, not a
	// path — see createProject — and the folder it makes then has to pass the same
	// allowlist as any other, so this adds a way in only for a fresh empty repo.
	if (body.create !== undefined) {
		const made = createProject(String(body.create))
		if (!made.ok) return send(res, 400, MIME['.json'], JSON.stringify({ error: made.error }))
		body.dir = made.dir
		body.resume = undefined
	}
	/**
	 * `resume` reopens a session you closed instead of starting an empty one.
	 *
	 * The same endpoint and the same gate, because it is the same act: a process
	 * started in a directory this machine offered. What it is NOT is a second writer
	 * on a live conversation — a session with a process attached is not in the closed
	 * list, so the id can only ever name one nothing is holding.
	 */
	const resume = body.resume ? String(body.resume) : undefined
	const dir = String(body.dir ?? '')
	const created = body.create !== undefined
	const out = await spawn(dir, created ? path.basename(dir) : resume ? 'reopened' : 'new session', resume)
	// Not awaited: the trust prompt arrives half a minute later, long after this
	// reply. Only for a folder this request just made — see trustNew.
	if (out.ok && created) void trustNew(out.text)
	// Announced on the machine's own screen like a send. Starting a session
	// remotely is possible; doing it unseen is not.
	opts.onSend?.(path.basename(dir), created ? 'started a new project' : resume ? 'reopened a closed session' : 'started a new session', out.ok)
	return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true, workspace: out.text, dir } : { error: out.error }))
}

/**
 * An image to mention in a message — see upload.ts for why a path is the way in.
 *
 * Behind exactly the guards of /api/send: putting a file on this machine is
 * typing in all but name. The body is the raw image, not JSON or a multipart
 * form, so there is nothing to parse but the bytes themselves.
 */
export async function uploadRoute(c: Call) {
	const { req, res, addr, opts } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	const waitUp = controlLockedFor(addr)
	if (waitUp > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitUp / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	const bytes = await readBytes(req)
	if (!bytes) return send(res, 413, MIME['.json'], `{"error":"image too large, the limit is ${MAX_UPLOAD / 1024 / 1024}MB"}`)
	const out = saveUpload(bytes)
	return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true, path: out.path } : { error: out.error }))
}

/**
 * A tap on one of the OTHER panes of a session's tab — see `click` in control.ts.
 *
 * The guards of /api/key, and two more. The pane must be one cmux lists in this
 * tab, never an id taken on trust; and it must not be the session's own pane. The
 * chat is driven by typing and the four keys, and a stray tap while reading it
 * should select text, not click whatever the TUI drew under the finger.
 */
export async function clickRoute(c: Call) {
	const { req, res, addr, opts, sessions } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	if (await cmuxRefusal(res)) return
	const waitClick = controlLockedFor(addr)
	if (waitClick > 0) return send(res, 429, MIME['.json'], `{"error":"too many wrong tries, wait ${Math.ceil(waitClick / 1000)}s"}`)
	if (!controlAttempt(addr, req.headers['x-guildhall-control'] as string | undefined)) return send(res, 401, MIME['.json'], '{"error":"wrong control password"}')
	let body: { id?: string; pane?: string; row?: number; col?: number }
	try {
		body = JSON.parse(await readBody(req))
	} catch {
		return send(res, 400, MIME['.json'], '{"error":"bad json"}')
	}
	const target = sessions().find((s) => s.id === body.id)
	if (!target?.workspace) return send(res, 404, MIME['.json'], '{"error":"no such session, or it is not in a cmux tab"}')
	const pane = target.panes?.find((p) => p.surface === body.pane && p.surface !== target.surface)
	if (!pane) return send(res, 404, MIME['.json'], '{"error":"no such pane beside this session"}')
	const out = await click({ workspace: target.workspace, surface: pane.surface }, Number(body.row), Number(body.col))
	opts.onSend?.(target.proj, `clicked in ${pane.title.slice(0, 20)}`, out.ok)
	return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true } : { error: out.error }))
}

/**
 * Move the caret in a prompt, or confirm it.
 *
 * Claude Code asks its questions as a list you arrow through, and from a phone
 * there was no way to answer one — the moment a session most needs you was the
 * moment you could do least. Four keys only; see `press` in control.ts for why
 * that list is not longer.
 */
export async function keyRoute(c: Call) {
	const { req, res, addr, opts, sessions } = c
	if (!opts.control?.()) return send(res, 403, MIME['.json'], '{"error":"control is off"}')
	if (!controlReachable(addr)) return send(res, 403, MIME['.json'], '{"error":"control is loopback or tailnet only"}')
	if (await cmuxRefusal(res)) return
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
	const out = await pressKey({ workspace: target.workspace, surface: target.surface }, String(body.key ?? ''))
	// Announced like a send. A key that answers a prompt is a decision, and a
	// decision made from away must still be visible to whoever is here.
	opts.onSend?.(target.proj, `pressed ${String(body.key ?? '').slice(0, 12)}`, out.ok)
	return send(res, out.ok ? 200 : 400, MIME['.json'], JSON.stringify(out.ok ? { ok: true } : { error: out.error }))
}

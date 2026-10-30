/**
 * "Fit to window": size a session's terminal to the desktop browser viewing it, for as
 * long as it is being viewed, through cmux's shared terminal sizing.
 *
 * A Claude session in a split cmux pane can be 47 columns wide, and Claude Code (an Ink
 * TUI) wraps everything it draws at that width. No viewer can widen text that was broken
 * that way — measured, and researched: tmux, ttyd and the asciinema player all either
 * resize the source or pad the view. The browser joins prose back up by itself
 * (web/reflow.ts); this is the exact alternative, on demand: cmux lets several viewers of
 * one terminal agree on its size, so the browser registers as a viewer as wide as its
 * panel and asks for the largest viewer to win. Measured on a scratch pane: 99 columns
 * became 200, Claude Code redrew its whole screen at the new width in about 0.6s, and
 * disconnecting put it straight back.
 *
 * The cost is everywhere else at once: while it is on, that session IS 200 columns, so
 * its own narrow pane on the Mac shows it cut off and a phone gets the wide grid too.
 * Hence on demand, and let go the moment the browser stops looking:
 *
 *  - the browser re-asks every few seconds while the panel is open and the tab visible,
 *    and lets go on closing, hiding or switching away;
 *  - a fit not re-asked for within STALE_MS is let go here, for a browser that crashed or
 *    lost its network — cmux never drops a viewer by itself (measured: still there after
 *    2m43s with nothing touching it);
 *  - what is held is written to disk, so a server that crashed is let go of on restart.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type Pane, type Result, rpcAt } from './control.ts'

/** Three missed check-ins: the browser asks every 10s. */
export const STALE_MS = 30_000

type Held = { workspace: string; surface: string; client: string; mode: string; generation: number; seen: number }

const held = new Map<string, Held>()

type Rpc = (method: string, where: Pane, extra?: Record<string, unknown>) => Promise<Result>
let rpc: Rpc = rpcAt

/** For the tests: a stand-in for cmux, and a fresh slate. */
export function useRpc(fn: Rpc) {
	rpc = fn
	held.clear()
}

const file = () => path.join(process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall'), 'fits.json')

function save() {
	try {
		fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), JSON.stringify([...held.values()]), { mode: 0o600 })
	} catch {
		// Not fatal: the stale sweep still lets go of these while this process lives.
	}
}

/** Sizes are integers within what a terminal can be; anything else is refused. */
const sane = (n: number, max: number) => Number.isInteger(n) && n >= 20 && n <= max

/**
 * Hold `where` at least `cols` x `rows` while the browser looks at it. Called again to
 * keep it held, and with new numbers when the window is resized.
 */
export async function fitOn(where: { workspace: string; surface: string }, cols: number, rows: number): Promise<Result> {
	if (!sane(cols, 1000) || !sane(rows, 500)) return { ok: false, error: 'not a terminal size' }
	let h = held.get(where.surface)
	if (!h) {
		// The policy it had, so letting go restores exactly that rather than a default.
		const state = await rpc('terminal.size_state', where)
		if (!state.ok) return state
		let mode = 'smallest'
		try {
			mode = String(JSON.parse(state.text)?.size_state?.policy?.mode ?? 'smallest')
		} catch {
			// an unreadable answer: the default is what an untouched pane has
		}
		// A fresh viewer id each time: cmux refuses an id once it has been disconnected.
		h = { ...where, client: `guildhall-${crypto.randomUUID()}`, mode, generation: 0, seen: 0 }
	}
	h.generation++
	h.seen = Date.now()
	const view = await rpc('terminal.viewport', where, {
		client_id: h.client,
		viewport_columns: cols,
		viewport_rows: rows,
		viewport_generation: h.generation,
		device_kind: 'browser',
		device_name: 'guildhall',
	})
	if (!view.ok) return view
	if (!held.has(where.surface)) {
		held.set(where.surface, h)
		save()
		const set = await rpc('terminal.size_policy.set', where, { mode: 'largest' })
		if (!set.ok) {
			await fitOff(where.surface)
			return set
		}
	}
	return { ok: true, text: '' }
}

/** Let go: the viewer leaves and the policy goes back to what it was. */
export async function fitOff(surface: string): Promise<Result> {
	const h = held.get(surface)
	if (!h) return { ok: true, text: '' }
	held.delete(surface)
	save()
	const where = { workspace: h.workspace, surface: h.surface }
	const gone = await rpc('terminal.participant.disconnect', where, { participant_id: `mobile:${h.client}` })
	const back = await rpc('terminal.size_policy.set', where, { mode: h.mode })
	return gone.ok ? back : gone
}

/** Let go of every fit nobody has asked for lately. */
export async function sweep(now = Date.now()) {
	for (const h of [...held.values()]) if (now - h.seen > STALE_MS) await fitOff(h.surface)
}

/**
 * On starting: let go of whatever a previous server was holding when it stopped. Read
 * from the file it kept, so only what guildhall itself took is touched.
 */
export async function releaseLeftovers() {
	let left: Held[] = []
	try {
		left = JSON.parse(fs.readFileSync(file(), 'utf8'))
	} catch {
		return
	}
	for (const h of left) {
		if (!h?.surface || !h.workspace || !h.client) continue
		held.set(h.surface, h)
		await fitOff(h.surface)
	}
}

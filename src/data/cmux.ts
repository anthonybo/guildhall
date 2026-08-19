/**
 * Which cmux tab a session is sitting in, so we can offer to jump there.
 *
 * Read-only, and deliberately so: sessions stay organised wherever they already
 * are. Guildhall observes the layout, it never rearranges it.
 */
import fs from 'node:fs'
import { CMUX_STATE } from './paths.ts'

/**
 * Session id → tab POSITION (1-based), the workspace's UUID, and whether the tab
 * is showing unread.
 *
 * Two identifiers because they answer different questions. The POSITION is what
 * a person sees and can act on — cmux's own `workspace:N` refs are not in tab
 * order, so showing one would name a tab that is somewhere else entirely.
 *
 * The UUID is what a machine must use. `--workspace 2` and the second tab are
 * different workspaces, and addressing a terminal you are about to type into by
 * a number that means something else is exactly the mistake worth designing out.
 * It is stable across reorders, which a position is not.
 */
const byTty = new Map<string, { tab: number; workspace: string; unread: boolean }>()

export function cmuxMap() {
	const m = new Map<string, { tab: number; workspace: string; unread: boolean }>()
	let st: any
	try {
		st = JSON.parse(fs.readFileSync(CMUX_STATE, 'utf8'))
	} catch {
		return m
	}
	for (const win of st.windows ?? []) {
		;(win.tabManager?.workspaces ?? []).forEach((ws: any, i: number) => {
			const at = { tab: i + 1, workspace: String(ws.workspaceId ?? ''), unread: !!ws.hasUnreadIndicator }
			for (const pn of ws.panels ?? []) {
				// Every panel by its terminal device — the exact session-to-tab key. See
				// `tabForTty`.
				if (pn.ttyName) {
					byTty.set(String(pn.ttyName), at)
					byTty.set(String(pn.ttyName).replace(/^\/dev\//, ''), at)
				}
				const t = pn.terminal
				// `terminal.agent` is not the panel's identity, it is its *attachment*:
				// cmux drops the whole object once its hooks stop hearing from the agent
				// (`wasAgentRunning: false`) even though the process is alive and the tab
				// is right there. Measured on this machine: of 13 panels holding an agent,
				// the 11 with `wasAgentRunning: true` had both fields and the 2 with it
				// false had only `resumeBinding` — one of them a busy `claude --resume`
				// with a live pid. Reading `agent` alone silently lost those two tabs.
				//
				// `resumeBinding.checkpointId` is the id cmux itself would resume, and in
				// all 11 panels carrying both it was byte-identical to `agent.sessionId`,
				// so it is the same fact with a longer shelf life. `agent` still wins when
				// present: a binding outlives the attachment, so it is the staler of the
				// two if a session ever moves panels.
				const live = t?.agent?.sessionId
				const resumable = t?.resumeBinding?.checkpointId
				if (live) m.set(live, at)
				else if (resumable && !m.has(resumable)) m.set(resumable, at)
			}
			// A tab with no agent recorded on it at all, remembered by the directory it
			// is sitting in. See `unclaimed` — this is what lets a session guildhall
			// started be found, since cmux writes no agent fields for a workspace made
			// from the CLI.
			if (!(ws.panels ?? []).some((pn: any) => pn.terminal?.agent?.sessionId || pn.terminal?.resumeBinding?.checkpointId)) {
				const dir = String(ws.currentDirectory ?? '')
				if (dir) free.push({ dir, at })
			}
		})
	}
	return m
}

/**
 * Tabs holding no agent, by the directory they are open in.
 *
 * For sessions cmux does not know are sessions. `cmuxMap` matches a tab to a
 * Claude session through `terminal.agent.sessionId` or
 * `resumeBinding.checkpointId`, and neither is ever written for a workspace
 * created from the CLI — measured at 30s, 60s and 90s after `cmux workspace
 * create --command claude`, the whole `terminal` object stays empty. A session
 * started that way therefore has no tab, no terminal button, and no way to be
 * typed into, which is the entire point of starting one.
 *
 * cmux does record `currentDirectory` per workspace, so the directory is the
 * fact both sides share. This is offered as a LAST resort and only when it is
 * unambiguous — see `pairByDirectory`.
 */
const free: { dir: string; at: { tab: number; workspace: string; unread: boolean } }[] = []

export function unclaimed() {
	// Populated as a side effect of cmuxMap, which is the only thing that parses the
	// state file; calling it here keeps the two answers from the same read.
	free.length = 0
	byTty.clear()
	cmuxMap()
	return free.slice()
}

/**
 * Which tab a terminal device belongs to.
 *
 * The exact answer, and it should have been the first thing tried. cmux records
 * `ttyName` on every panel; a Claude process has a tty; a tty belongs to exactly
 * one terminal. There is nothing to infer and nothing to remember.
 *
 * This replaces two worse attempts. Matching by directory was ambiguous — seven
 * sessions share `~/projects` here, and the browser opened whichever was busiest,
 * which meant a terminal for an unrelated session mid-conversation. Remembering
 * the workspace guildhall created worked but was in-memory bookkeeping that a
 * server restart erased, and the dev watcher restarts on every source change.
 *
 * Measured on this machine: 13 of 13 live Claude processes matched to a tab,
 * including the one cmux had recorded no agent for.
 */
export function tabForTty(tty: string) {
	if (!tty || tty === '??') return undefined
	if (!byTty.size) cmuxMap()
	// `ps` reports `ttysNNN`; cmux records `/dev/ttysNNN`. Accept either.
	return byTty.get(tty) ?? byTty.get(`/dev/${tty}`) ?? byTty.get(tty.replace(/^\/dev\//, ''))
}

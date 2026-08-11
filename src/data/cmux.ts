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
		})
	}
	return m
}

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
			for (const pn of ws.panels ?? []) {
				const agent = pn.terminal?.agent
				if (agent?.sessionId) m.set(agent.sessionId, { tab: i + 1, workspace: String(ws.workspaceId ?? ''), unread: !!ws.hasUnreadIndicator })
			}
		})
	}
	return m
}

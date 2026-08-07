/**
 * Which cmux tab a session is sitting in, so we can offer to jump there.
 *
 * Read-only, and deliberately so: sessions stay organised wherever they already
 * are. Guildhall observes the layout, it never rearranges it.
 */
import fs from 'node:fs'
import { CMUX_STATE } from './paths.ts'

/**
 * Session id → tab POSITION (1-based) and whether the tab is showing unread.
 *
 * Position, not cmux's internal workspace ref: the two do not agree, and the
 * number shown to a person has to be the one they can act on.
 */
export function cmuxMap() {
	const m = new Map<string, { tab: number; unread: boolean }>()
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
				if (agent?.sessionId) m.set(agent.sessionId, { tab: i + 1, unread: !!ws.hasUnreadIndicator })
			}
		})
	}
	return m
}

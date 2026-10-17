/**
 * The other panes in a session's tab, one tap away from the chat.
 *
 * A tab can be split: a project can have Claude on one side and a backlog TUI on the
 * other. The panel used to show whichever pane cmux had focused — usually the
 * backlog — so the chat could not be read from a phone at all. Now the session's own
 * pane is always what opens, and the rest of the tab is a row of chips above it.
 *
 * Viewing only. Messages and the prompt keys always go to the session's own pane,
 * whichever is on screen — a backlog that took typed text meant for Claude would be
 * the same bug pointing the other way.
 */
import { tap } from './dom.ts'

export type PaneInfo = { surface: string; title: string }

/**
 * Taps on the drawn screen, as terminal cells — so a TUI in another pane can be
 * clicked from a phone (src/control.ts `click`).
 *
 * A TAP, decided on release: the finger moved less than a few pixels and lifted
 * quickly. Anything else was a scroll or a selection and is left to the browser —
 * nothing here cancels an event, so the screen still scrolls and text still selects.
 * The same shape as `tapList` in dom.ts, for the same reason.
 */
export function onCellTap(pre: HTMLElement, hit: (x: number, y: number) => void) {
	let start: { x: number; y: number; at: number } | null = null
	pre.addEventListener('pointerdown', (e) => {
		start = e.isPrimary ? { x: e.clientX, y: e.clientY, at: Date.now() } : null
	})
	pre.addEventListener('pointerup', (e) => {
		const s = start
		start = null
		if (!s || !e.isPrimary) return
		if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8 || Date.now() - s.at > 600) return
		// Not if the tap finished a text selection.
		if (String(getSelection() ?? '').length) return
		hit(e.clientX, e.clientY)
	})
	pre.addEventListener('pointercancel', () => (start = null))
}

/** The chips, or null when the tab has only the one pane and there is nothing to pick. */
export function paneStrip(panes: PaneInfo[] | undefined, own: string | undefined, pick: (surface: string | null) => void) {
	if (!panes || panes.length < 2 || !own) return null
	const strip = document.createElement('div')
	strip.id = 'panestrip'
	strip.className = 'flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-panel px-3 py-1.5'
	const hint = document.createElement('span')
	hint.className = 'shrink-0 text-[0.72rem] text-faint'
	const chips: [HTMLButtonElement, string | null][] = []
	// The chat first and named as such: it is what the panel is for, and its own title
	// is usually the conversation's subject, which says nothing about being the chat.
	const ordered = [...panes.filter((p) => p.surface === own), ...panes.filter((p) => p.surface !== own)]
	const paint = (on: string | null) => {
		for (const [b, s] of chips) {
			const active = s === on
			b.setAttribute('aria-pressed', String(active))
			b.className = `min-h-9 max-w-[12rem] shrink-0 cursor-pointer truncate rounded border bg-transparent px-3 text-[0.78rem] ${active ? 'border-gold text-gold' : 'border-line text-muted'}`
		}
		hint.textContent = on ? 'tap to click it · messages still go to the chat' : ''
	}
	for (const p of ordered) {
		const mine = p.surface === own
		const b = document.createElement('button')
		b.type = 'button'
		b.textContent = mine ? 'Chat' : p.title
		b.title = mine ? 'The session itself' : `${p.title} — another pane in this tab, view only`
		const value = mine ? null : p.surface
		chips.push([b, value])
		tap(b, () => {
			paint(value)
			pick(value)
		})
		strip.append(b)
	}
	strip.append(hint)
	paint(null)
	return strip
}

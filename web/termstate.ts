/**
 * What the terminal panel's modules share: its state, and the one way it talks to
 * the server.
 *
 * One object rather than a `let` per module. The panel is split by concern —
 * bar, password, message form, slash menu, polling — and every one of them reads
 * and writes the same few facts: which session is open, which pane is showing,
 * the last screen's tag. A module cannot assign another module's `let`, so the
 * alternative was copies, and two copies of `lastTag` that drift apart is exactly
 * the stuck-screen bug this panel has already had once.
 */
import type { Grid } from './grid.ts'
import type { PaneInfo } from './panes.ts'

export const KEY = 'guildhall.control'
const WRAP = 'guildhall.terminal.wrap'
const KEYPAD = 'guildhall.terminal.keys'

/** The panel that was open, so a reload for a new build can put it back. */
export const OPEN = 'guildhall.terminal.open'

export type Seat = { surface?: string; panes?: PaneInfo[] }

/**
 * The shape, with each field's reason. Written on a TYPE rather than on the object
 * below because esbuild keeps comments inside an object literal and drops them from
 * a type: on the object they shipped to every phone, measured as 1.5KB gzipped of prose.
 */
type TermState = {
	/**
	 * What to do when the grid is wider than the glass — which only ever happens on
	 * a phone, because every desktop width fits every pane at a readable size.
	 *
	 * `exact` keeps the true grid and scrolls sideways: alignment survives, and you
	 * drag to read. `wrap` reflows the rows like any other text, which breaks the
	 * status bar's columns but means you can actually read the prose.
	 *
	 * Wrapping is the default because the thing you open this view to do is read
	 * what the session said. Shrinking the grid to fit was measured and rejected: a
	 * 193-column screen on a 390px phone lands at 2.89px, which is a grey texture
	 * rather than small type — it fits in the sense that a photograph of a page fits.
	 */
	wrap: boolean

	/**
	 * Whether the answer keys are showing.
	 *
	 * Off by default and remembered. They are only wanted when a session is actually
	 * asking something, which is a small fraction of the time a terminal is open, and
	 * a row of controls that is usually useless costs the screen it sits on — the
	 * thing this view is shortest of on a phone.
	 */
	keypad: boolean

	/** The last screen drawn, so an unchanged one is not rebuilt under your selection. */
	lastSig: string

	/** The last screen's ETag, so an unchanged one is answered with 304 and no body.
	 *  Cleared when the panel closes, or reopening a session would ask about the
	 *  screen it was showing last time and be told, correctly, that nothing changed —
	 *  while the panel sat empty. */
	lastTag: string

	openId: string | null
	/** Which of the tab's OTHER panes is on screen, or null for the session's own. */
	viewing: string | null
	/**
	 * Where to scroll once the pane just switched to is first drawn. The scroll position
	 * belonged to the pane before: leaving the chat at its bottom landed the backlog on
	 * its empty bottom half, and coming back left the chat short of its newest lines.
	 * The chat opens at its end; another pane at its top, where a TUI draws its content.
	 */
	jump: 'top' | 'bottom' | null
	/** Where a session sits, from the live list — so the panel can offer its tab's panes. */
	seatOf: (id: string) => Seat | undefined
	openName: string
	/** The idempotency key for the message currently in the box, if one has been sent. */
	msgKey: string | null
	/** The slash commands this session takes, fetched once per open. */
	slash: { name: string; description: string; scope: string }[]

	// a handle, not an integer — see the note in press.ts
	timer: ReturnType<typeof setTimeout> | undefined
	el: HTMLElement
	onClose: () => void

	/**
	 * A poll or a send is in flight. Neither may overlap itself, and a poll gives way
	 * to a send.
	 *
	 * The screen is 68KB — measured, not estimated — and it was fetched every two
	 * seconds by a bare `setInterval` with nothing checking whether the previous one
	 * had come back. On a desktop it always had. On a phone over a tailnet it often
	 * had not, so the polls stacked up, and a browser will only hold six connections
	 * to one host — one of which this client permanently spends on the event stream.
	 * Five outstanding screen reads is the whole budget, and the Send request then
	 * queues behind them rather than being sent.
	 *
	 * That is the delay: not the machine, which answers a send in about 200ms, but a
	 * request that had nowhere to go. Sitting on the disabled button for twenty
	 * seconds and then failing was the same bug reaching its deadline.
	 */
	polling: boolean
	sending: boolean
	/** A read was asked for while one was in flight: run another as soon as it lands. */
	again: boolean
}

export const term: TermState = {
	wrap: localStorage.getItem(WRAP) !== 'exact',
	keypad: localStorage.getItem(KEYPAD) === 'on',
	lastSig: '',
	lastTag: '',
	openId: null,
	viewing: null,
	jump: null,
	seatOf: () => undefined,
	openName: '',
	msgKey: null,
	slash: [],
	timer: undefined,
	// set by mountTerminal before anything can open the panel
	el: undefined as unknown as HTMLElement,
	onClose: () => {},
	polling: false,
	sending: false,
	again: false,
}

/** Remember the two display choices across visits. */
export const saveWrap = () => localStorage.setItem(WRAP, term.wrap ? 'wrap' : 'exact')
export const saveKeypad = () => localStorage.setItem(KEYPAD, term.keypad ? 'on' : 'off')

/**
 * The two panel actions the parts call back into, set by terminal.ts when it loads.
 * Hooks rather than imports so the bar and the password form do not import the module
 * that imports them.
 */
export const hooks = {
	show: (_id: string, _name: string) => {},
	close: () => {},
}

/**
 * What you had typed, per session, kept for the life of the tab.
 *
 * Reported as "I keep getting kicked out of the terminal after sending and have to
 * re-type everything", from a desktop pasting long logs. More than one thing closes
 * this panel — Esc, a page reload when a new build lands — and every one of them
 * threw away the box. Rather than bet on which it was, the text now outlives the
 * panel: reopen the session and it is still there. sessionStorage, like the control
 * token, so it never outlives the tab and never reaches another device.
 */
const DRAFT = 'guildhall.terminal.draft.'
export const draftOf = (id: string) => {
	try {
		return sessionStorage.getItem(DRAFT + id) ?? ''
	} catch {
		return ''
	}
}
export const keepDraft = (id: string | null, text: string) => {
	if (!id) return
	try {
		if (text) sessionStorage.setItem(DRAFT + id, text)
		else sessionStorage.removeItem(DRAFT + id)
	} catch {
		// Full or blocked: the box still works, it just will not survive a close.
	}
}

/**
 * Force the next poll to redraw even if the session has printed nothing.
 *
 * The repaint guard compares the grid, which is right for "has the session
 * changed" and wrong for everything else, because `paint()` is also the only thing
 * that applies the LAYOUT — type size, wrapping, height. Two cases were broken in
 * the dangerous direction and both are exactly the phone-reading-an-idle-session
 * case the guard was built for:
 *
 *  - Wrapped/Exact did nothing on a quiet screen. The button relabelled itself and
 *    the text did not reflow until the session next printed.
 *  - Rotating the phone never resized the type. Before the guard the 2s poll fixed
 *    it within two seconds; after, it waited for output that may never come.
 */
export function repaintSoon() {
	term.lastSig = ''
	// The ETag has to go too, or the conditional request reintroduces exactly the
	// bug this function exists to prevent, one layer further out. `lastSig` only
	// gets consulted if a body arrives, and an unchanged screen no longer sends
	// one — so on an idle session the server would answer 304, `poll()` would
	// return before `paint()`, and Wrapped/Exact and rotation would go back to
	// doing nothing until the session next printed. Forcing a repaint means asking
	// for the bytes to repaint FROM.
	term.lastTag = ''
}

/**
 * A random key for one composed message.
 *
 * NOT `crypto.randomUUID()`. That is gated on a SECURE CONTEXT — it exists on
 * localhost and over https and is `undefined` over plain http — and this app is served
 * over http on a tailnet address, which is the one place it actually runs. Calling it
 * there threw before the send was attempted, so the dedupe key broke sending outright:
 * reported as "I can no longer send messages, I had to come back to my laptop".
 *
 * `crypto.getRandomValues` is NOT secure-context gated and is the right primitive here.
 * The last fallback is only so that a missing crypto object cannot stop a message going
 * out; a key is a deduplication aid, and nothing about sending may depend on having one.
 */
export function newKey(): string | null {
	try {
		const b = new Uint8Array(16)
		crypto.getRandomValues(b)
		return Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('')
	} catch {
		try {
			return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
		} catch {
			return null
		}
	}
}

export const token = () => sessionStorage.getItem(KEY) ?? ''

export async function api(path: string, init: RequestInit = {}, deadline = 20_000) {
	// Every call gets a deadline. A fetch without one never settles — a phone
	// changing networks or a sleeping laptop leaves the promise pending forever, and
	// the send path awaits it with the button disabled, so the button stays dead and
	// pressing it "does nothing" for the rest of the session.
	try {
		const res = await fetch(path, { ...init, signal: AbortSignal.timeout(deadline), headers: { 'x-guildhall-control': token(), ...(init.headers ?? {}) } })
		// 304 has no body by definition, and asking for one gets "unreadable reply" —
		// an error message for the case where everything worked and nothing changed.
		if (res.status === 304) return { status: 304 }
		term.lastTag = res.headers.get('etag') ?? term.lastTag
		const body = await res.json().catch(() => ({ error: 'unreadable reply' }))
		return { status: res.status, ...body } as { status: number; render_grid?: Grid; error?: string; ok?: boolean; note?: string }
	} catch (e) {
		const timedOut = e instanceof DOMException && e.name === 'TimeoutError'
		return { status: 0, error: timedOut ? 'the machine did not answer in time' : 'could not reach guildhall' }
	}
}

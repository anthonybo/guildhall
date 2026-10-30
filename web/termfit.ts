/**
 * The "Fit" button: size this session's terminal to the window while you look at it, so
 * Claude Code itself lays out at the browser's width — see src/fit.ts for how, and for
 * what it costs elsewhere.
 *
 * On demand, and only while it is actually being looked at. That session is that wide
 * everywhere while this holds it — its own pane on the Mac shows it cut off, and a phone
 * gets the wide grid — so it lets go on hiding the tab or switching away, takes it back
 * on returning, and lets go for good when the panel closes. The joined-up prose of
 * Wrapped mode (reflow.ts) is the default because it changes nothing anywhere else.
 */
import { api, term } from './termstate.ts'
import { fullScreen } from './viewport.ts'

/** The size the text is drawn at when the grid fits (grid.ts COMFORTABLE). */
const TYPE = 15
/** How often the browser says it is still looking: well inside the server's 30s. */
const BEAT = 10_000

let wanted = false
let beat: ReturnType<typeof setInterval> | undefined
let button: HTMLButtonElement | null = null

/** Columns and rows of TYPE-sized cells that fit the screen box. */
function size(pre: HTMLElement) {
	const probe = document.createElement('span')
	probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-size:${TYPE}px`
	probe.textContent = '0'.repeat(100)
	pre.append(probe)
	const cell = probe.getBoundingClientRect().width / 100 || TYPE * 0.6
	probe.remove()
	// The screen's own padding is 12px a side.
	return { cols: Math.floor((pre.clientWidth - 24) / cell), rows: Math.floor(pre.clientHeight / (TYPE * 1.25)) }
}

async function ask(on: boolean) {
	const pre = document.getElementById('screen')
	if (!term.openId || !pre) return
	const body = on ? { id: term.openId, on, ...size(pre) } : { id: term.openId, on }
	const r = await api('/api/fit', { method: 'POST', body: JSON.stringify(body) })
	if (r.error && on) {
		// Could not take it: say so on the button rather than pretend.
		wanted = false
		label(`Fit failed: ${r.error}`)
	}
}

function label(problem?: string) {
	if (!button) return
	button.textContent = 'Fit'
	button.setAttribute('aria-pressed', String(wanted))
	button.title =
		problem ??
		(wanted
			? "This session's terminal is as wide as this window while you look at it. Its pane on the Mac shows it cut off until this is off. Tap to give it back."
			: "Make this session's terminal as wide as this window while you look at it, so Claude lays out at full width. Its pane on the Mac shows it cut off meanwhile.")
	button.className = `flex min-h-11 cursor-pointer items-center rounded border bg-transparent px-3 text-[0.78rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${wanted ? 'border-gold text-gold' : 'border-line text-muted hover:border-gold hover:text-gold'}`
}

function start() {
	void ask(true)
	clearInterval(beat)
	beat = setInterval(() => {
		if (wanted && !document.hidden) void ask(true)
	}, BEAT)
}

function stop() {
	clearInterval(beat)
	beat = undefined
	void ask(false)
}

/** The button for the bar. Hidden on a phone, where this is not offered. */
export function fitButton(): HTMLButtonElement {
	button = document.createElement('button')
	button.type = 'button'
	button.hidden = fullScreen()
	label()
	button.addEventListener('click', () => {
		wanted = !wanted
		label()
		if (wanted) start()
		else stop()
	})
	return button
}

/** The panel closed, or opened onto another session: give the terminal back. */
export function releaseFit() {
	if (wanted) stop()
	wanted = false
	label()
}

// Away and back: let go while nobody is looking, take it again on return.
document.addEventListener('visibilitychange', () => {
	if (!wanted) return
	if (document.hidden) stop()
	else start()
})
// A resized window wants a different size; debounced, since a drag fires this often.
let resized: ReturnType<typeof setTimeout> | undefined
addEventListener('resize', () => {
	if (button) button.hidden = fullScreen()
	if (!wanted) return
	clearTimeout(resized)
	resized = setTimeout(() => {
		// Narrowed to a phone layout: not offered there, so let go.
		if (fullScreen()) releaseFit()
		else void ask(true)
	}, 300)
})

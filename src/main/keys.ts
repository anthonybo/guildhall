/**
 * Everything typed at the room: the keys, mouse clicks on the help panel, the three
 * things that can be typed into it (passcode, control password, port), and terminal
 * replies that arrive mixed in with the keystrokes.
 */
import {
	MOUSE_OFF,
	MOUSE_ON,
	MOUSE_PRESS,
	WATCH_OFF,
	cellFrom,
	clearAll,
	demux,
} from '../kitty.ts'
import * as H from '../help.ts'
import { setPasscode } from '../auth.ts'
import { setControlPass } from '../controlauth.ts'
import { pickPort } from '../port.ts'
import { cfg } from './run.ts'
import { OUT, alt, eraseDisplay, resetPrev } from './screen.ts'
import { cell, imageIds, sent, setCell } from './images.ts'
import { copyAddress, movePort, server } from './serving.ts'
import { toggleAwake, toggleCodex, toggleLabels, toggleShare } from './toggles.ts'
import {
	deskScreens,
	expanded,
	faultsOnly,
	geom,
	labels,
	layout,
	mode,
	moveSelection,
	selectedId,
	sessions,
	setDeskScreens,
	setFaultsOnly,
	setLabels,
	setMode,
} from './state.ts'
import { controlInfo, draw, envInfo, shareInfo } from './draw.ts'
import { jump } from './tabs.ts'

/** the help panel, which suppresses the image layer while it is up */
export let showHelp = false
/**
 * First line of the help shown, when it is taller than the window.
 *
 * Reset every time the panel opens: reopening it and finding yourself halfway
 * down somebody else's scroll position is worse than starting at the top.
 */
export let helpScroll = 0
/**
 * Which explanatory sections are open. Empty is the point: the panel opens as a
 * short list of settings and headings, and the ninety lines of prose are there
 * when asked for rather than by default.
 */
export let helpOpen = new Set<string>()

/** digits typed so far while changing the passcode, or null when not changing it */
export let pin: string | null = null
/**
 * The control passphrase being typed, or null when it is not being changed.
 *
 * Typed here rather than generated, because it has to be entered on a phone —
 * and typed HERE rather than in the browser, because the machine is the trust
 * boundary. It is never echoed: only a count of characters shows on screen.
 */
export let ctlPass: string | null = null
export let ctlNote = ''
/** what happened last time it was changed, shown until the panel closes */
export let pinNote = ''
/** digits typed so far while changing the port, or null when not changing it */
export let portEntry: string | null = null
/** what happened last time the port was changed */
export let portNote = ''
/** Written by serving.ts too, which says on this line what became of a port change. */
export function setPortNote(note: string) {
	portNote = note
}

export function cleanup() {
	server?.close()
	// MOUSE_OFF unconditionally, even though it is only turned on for the help
	// panel: quitting with the panel open would otherwise hand the shell back a
	// terminal that still reports clicks, and the person would find selection
	// broken in a program that is no longer running.
	if (alt) OUT.write(clearAll() + WATCH_OFF + MOUSE_OFF + '\x1b[?25h\x1b[?1049l')
	process.exit(0)
}

/** Terminal replies arrive on stdin mixed in with keystrokes. Peel off complete
 *  reports, act on them, and pass whatever is left through as typing. A reply can
 *  be split across reads, so hold a partial one until it completes. */
let inbox = ''
export function onInput(b: Buffer) {
	const raw = inbox + b.toString('binary')
	const size = cellFrom(raw)
	if (size && size.w > 0 && size.h > 0 && (size.w !== cell.w || size.h !== cell.h)) {
		// a font-size change means every plate is now the wrong size for its box
		setCell(size)
		imageIds.clear()
		sent.clear()
	}
	const { keys, rest, lost } = demux(raw)
	inbox = rest
	if (lost) {
		// the surface was hidden, moved, or lost its images: re-send every pixel on
		// the next frame. 27KB, and only when something actually went missing.
		sent.clear()
		draw()
	}
	if (keys) onKey(Buffer.from(keys, 'binary'))
}

/**
 * One read, split into individual keys.
 *
 * A terminal delivers a burst as a single read: typing a password and pressing
 * return arrives as the one string `"my pass\r"`, not eight of them. Comparing
 * that whole chunk against `'\r'` never matches, so the return was appended to
 * the password as a character and there was no way to save it. The passcode had
 * the same fault — `/^\d$/` against a chunk of several digits fails too, so a
 * fast typist could not enter one either.
 *
 * Escape sequences stay whole, or an arrow key would arrive as ESC, `[`, `A` and
 * the ESC would read as "cancel".
 */
function eachKey(chunk: string): string[] {
	const out: string[] = []
	for (let i = 0; i < chunk.length; i++) {
		if (chunk[i] === '\x1b' && i + 1 < chunk.length) {
			const m = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e]|.)/.exec(chunk.slice(i))
			if (m) {
				out.push(m[0])
				i += m[0].length - 1
				continue
			}
		}
		out.push(chunk[i])
	}
	return out
}

export function onKey(b: Buffer) {
	const k = b.toString()

	// Typing a new passcode swallows every key, including q — otherwise a 4 in the
	// code would be fine but a q would quit the app mid-entry.
	// Same swallow-everything rule as the passcode: a `q` inside a passphrase must
	// be a character, not a quit.
	if (ctlPass !== null) {
		for (const key of eachKey(k)) {
			if (ctlPass === null) break // saved mid-chunk; the rest is not password
			if (key === '\x1b') ((ctlPass = null), (ctlNote = 'left as it was'))
			else if (key === '\x7f' || key === '\b') ctlPass = ctlPass.slice(0, -1)
			else if (key === '\r' || key === '\n') {
				// `live` only here: a person is at the keyboard and just typed it. Every
				// other caller is refused, so no script can replace the real credential.
				const r = setControlPass(ctlPass, { live: true })
				ctlNote = r.ok ? 'saved — every device must enter it again' : r.why
				if (r.ok) ctlPass = null
			} else if (key.length === 1 && key >= ' ' && key <= '~') ctlPass += key
		}
		draw()
		return
	}

	// Same swallow-everything rule as the two above: a `q` typed while entering a
	// port must not quit the app. Enter commits, because unlike a 4-digit passcode
	// a port has no fixed length to commit on.
	if (portEntry !== null) {
		for (const key of eachKey(k)) {
			if (portEntry === null) break
			if (key === '\x1b') ((portEntry = null), (portNote = 'left as it was'))
			else if (key === '\x7f' || key === '\b') portEntry = portEntry.slice(0, -1)
			else if (key === '\r' || key === '\n') {
				const n = Number(portEntry)
				// 1024 rather than 1: binding below it needs root, and the failure would
				// arrive as a permissions error that reads like a bug in this app
				if (!Number.isInteger(n) || n < 1024 || n > 65535) portNote = 'a port is 1024 to 65535'
				else if (n === cfg.port) portNote = `already on ${n}`
				else movePort(n)
				portEntry = null
			} else if (key === 'r') {
				// Fill the field with a free one, the same `--pick-port` the menu bar's
				// Random button calls. Async, so the field shows what it is doing rather
				// than appearing to ignore the key for a moment.
				portEntry = ''
				portNote = 'looking for a free port…'
				void pickPort(cfg.host).then((n) => {
					if (portEntry === null) return // the panel closed while we looked
					if (n === null) portNote = 'no free port found'
					else ((portEntry = String(n)), (portNote = `${n} is free — ⏎ to move`))
					draw()
				})
			} else if (/^\d$/.test(key) && portEntry.length < 5) portEntry += key
		}
		draw()
		return
	}

	if (pin !== null) {
		for (const key of eachKey(k)) {
			if (pin === null) break // finished mid-chunk
			if (key === '\x1b') ((pin = null), (pinNote = 'left as it was'))
			else if (key === '\x7f' || key === '\b') pin = pin.slice(0, -1)
			else if (/^\d$/.test(key)) {
				pin += key
				if (pin.length === 4) {
					const r = setPasscode(pin)
					pinNote = r.ok ? 'saved — every paired device must sign in again' : r.why
					pin = null
				}
			}
		}
		draw()
		return
	}

	if (k === 'q' || k === '\x03') return cleanup()
	if (showHelp) {
		// Scroll, when there is more than the window can hold. This has to come
		// before the catch-all below, which dismisses on any key: an arrow pressed at
		// a help panel that ran off the bottom used to CLOSE it, so the sections past
		// the fold — the address and the passcode — could not be reached at all on a
		// terminal shorter than 41 rows.
		const hidden = H.overflow(geom.cols, geom.rows + 1, shareInfo(), controlInfo(), envInfo(), helpOpen)
		if (hidden > 0 && (k === '\x1b[A' || k === '\x1b[B' || k === 'k' || k === 'j' || k === ' ')) {
			const by = k === '\x1b[A' || k === 'k' ? -1 : k === ' ' ? Math.max(1, geom.rows - 3) : 1
			helpScroll = Math.max(0, Math.min(helpScroll + by, hidden + 1))
			draw()
			return
		}
		// A click on a line that does something. Both the picture and the map come
		// from H.view, so a row can never carry a different line's action.
		//
		// Release events (`m`) are swallowed rather than acted on, or every click
		// would fire twice — and the second one would land on whatever the first
		// just drew.
		const press = MOUSE_PRESS.exec(k)
		if (press || /\x1b\[<\d+;\d+;\d+m/.test(k)) {
			if (press) {
				const v = H.view(geom.cols, geom.rows + 1, shareInfo(), controlInfo(), helpScroll, envInfo(), helpOpen)
				// paint() puts line i on screen row i+1, so a 1-based click row maps back
				// by subtracting one
				const hit = v.hits.find((h) => h.row === Number(press[3]) - 1)
				if (hit?.act.kind === 'port' && cfg.serve) ((portEntry = ''), (portNote = ''))
				else if (hit?.act.kind === 'passcode') ((pin = ''), (pinNote = ''))
				else if (hit?.act.kind === 'control') ((ctlPass = ''), (ctlNote = ''))
				else if (hit?.act.kind === 'copy') copyAddress(hit.act.text)
				else if (hit?.act.kind === 'sharing') toggleShare()
				else if (hit?.act.kind === 'awake') toggleAwake()
				else if (hit?.act.kind === 'labels') toggleLabels()
				else if (hit?.act.kind === 'codex') toggleCodex()
				else if (hit?.act.kind === 'section') {
					const id = hit.act.id
					// Opening a section moves everything below it, so the scroll position
					// stops meaning what it did. Clamped rather than reset: closing a
					// section near the bottom would otherwise throw you back to the top.
					helpOpen.has(id) ? helpOpen.delete(id) : helpOpen.add(id)
					helpScroll = Math.min(helpScroll, H.overflow(geom.cols, geom.rows + 1, shareInfo(), controlInfo(), envInfo(), helpOpen) + 1)
				}
				draw()
			}
			return
		}
		// One key for all the prose, since the common want is either "show me the
		// settings" or "explain everything", not one section at a time.
		if (k === 'h') {
			helpOpen = helpOpen.size ? new Set() : new Set(H.SECTION_IDS)
			helpScroll = 0
			draw()
			return
		}
		if (k === 's') {
			toggleShare()
			draw()
			return
		}
		if (k === 'a') {
			toggleAwake()
			draw()
			return
		}
		if (k === 'v') {
			toggleLabels()
			draw()
			return
		}
		if (k === 'x') {
			toggleCodex()
			draw()
			return
		}
		if (k === 'y') {
			const first = [...shareInfo().vpn, ...shareInfo().lan][0]
			if (first) copyAddress(`http://${first}:${cfg.port}`)
			draw()
			return
		}
		// `p` starts a passcode change; anything else dismisses the panel, because
		// hunting for the right key to close a help panel is its own small indignity
		if (k === 'p') {
			pin = ''
			pinNote = ''
			draw()
			return
		}
		if (k === 'c') {
			ctlPass = ''
			ctlNote = ''
			draw()
			return
		}
		// `o` rather than a second `p`, which the passcode already has. Only offered
		// while sharing is on, since the port of a server that is not running is not
		// a thing anybody is looking at.
		if (k === 'o' && cfg.serve) {
			portEntry = ''
			portNote = ''
			draw()
			return
		}
		showHelp = false
		pinNote = ''
		// Selection belongs to the terminal again the moment the panel closes.
		OUT.write(MOUSE_OFF)
		resetPrev()
		eraseDisplay()
		layout()
		draw()
		return
	}
	if (k === '?') {
		showHelp = true
		helpScroll = 0
		// Mouse on only while the panel is up; see MOUSE_ON for why not app-wide.
		OUT.write(MOUSE_ON)
		resetPrev()
		eraseDisplay()
		OUT.write(clearAll())
		imageIds.clear()
		sent.clear()
		draw()
		return
	}
	if (k === '\x1b[A') moveSelection(-1)
	else if (k === '\x1b[B') moveSelection(1)
	else if (k === '\x1b[C') {
		// → opens the selected row, ← closes it. Arrows because the hand is already
		// there choosing a row, and nothing else in the table uses left or right.
		if (selectedId) expanded.add(selectedId)
	} else if (k === '\x1b[D') {
		if (selectedId) expanded.delete(selectedId)
	}
	else if (k === '\r' || k === '\n') {
		const s = sessions.find((x) => x.id === selectedId)
		if (s?.tab) jump(s.tab)
	} else if (k === '\t') {
		setMode(mode === 'split' ? 'town' : mode === 'town' ? 'table' : mode === 'table' ? 'screens' : 'split')
		resetPrev()
		eraseDisplay()
		layout()
	} else if (k === 'f') {
		setFaultsOnly(!faultsOnly)
		layout()
	} else if (k === 'r') {
		// Full image teardown and rebuild. A terminal can drop the images it holds
		// with no event we can see; until that is properly diagnosed this is the
		// manual way back.
		OUT.write(clearAll())
		imageIds.clear()
		sent.clear()
		resetPrev()
		eraseDisplay()
		layout()
	} else if (k === 'v') {
		toggleLabels()
		eraseDisplay()
	} else if (k === 'l') {
		setLabels(!labels)
	} else if (k === 'm') {
		// The desk-screens room. A re-plan is required, not just a redraw: the two layouts
		// have different pitches, so `fit` has to run again — its signature includes the flag
		// for exactly this reason.
		setDeskScreens(!deskScreens)
		resetPrev()
		eraseDisplay()
		layout()
	} else if (k === 'w') {
		// The wall of terminals, on its own key rather than three presses into the `tab`
		// cycle: it is the reason somebody opens this program with sessions running, and a
		// view you reach by cycling past two others is a view nobody finds.
		setMode(mode === 'screens' ? 'split' : 'screens')
		resetPrev()
		eraseDisplay()
		layout()
	} else if (k === 's') {
		toggleShare()
	} else if (k === 'a') {
		toggleAwake()
	} else if (/^[0-9]$/.test(k)) jump(k === '0' ? 10 : Number(k))
	// keys only ever redraw; they must not advance the animation or the creatures
	// lurch forward once per keystroke
	draw()
}

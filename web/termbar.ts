/** The bars across the top of the terminal panel: the way out, and the view controls. */
import { tap } from './dom.ts'
import { openTranscript } from './transcript.ts'
import { fitButton } from './termfit.ts'
import { hooks, repaintSoon, saveKeypad, saveWrap, term, token } from './termstate.ts'

/**
 * The bar every state of this panel wears, including the ones that are not a
 * terminal.
 *
 * Extracted because the password branch did not have one, and full screen on a
 * phone that meant no way out. Any state this panel can be in has to carry its own
 * exit — that is the rule the missing cases kept breaking.
 */
export function titleBar(name: string, subtitle: string) {
	const bar = document.createElement('div')
	bar.className = 'flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2'
	const title = document.createElement('span')
	title.className = 'truncate font-bold text-label'
	title.textContent = name
	const live = document.createElement('span')
	live.className = 'shrink-0 text-[0.72rem] text-faint'
	live.textContent = subtitle
	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕ Close'
	x.title = 'Close the terminal (Esc)'
	x.className =
		'ml-auto flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot'
	tap(x, () => hooks.close())
	bar.append(title, live, x)
	return bar
}

/** The live terminal's bar: its name, Wrapped/Exact, the history, the keys, Close. */
export function screenBar(name: string, refresh: () => void) {
	// Not sticky, and that was a real bug rather than a preference: the panel sets
	// `overflow-hidden` to clip its rounded corners, which makes IT the scroll
	// container a sticky child resolves against — so `top: <header height>` offset
	// the bar that far down from the panel's own top instead of parking it under
	// the page header, and the screen showed through the gap above it.
	//
	// It does not need to be sticky. paint() sizes the screen to the window minus
	// this bar, the form and the header, so the whole panel fits by construction
	// and Close is on screen whenever the terminal is.
	const bar = document.createElement('div')
	bar.id = 'screenbar'
	bar.className = 'flex items-center gap-2 border-b border-line bg-panel px-3 py-2'
	// The one thing in this bar that gives way.
	//
	// A flex item defaults to `min-width: auto`, which means it refuses to shrink below
	// its own text — so with nothing marked shrinkable the whole row simply overflowed
	// and the LAST control was clipped. Close went off the edge of a phone when a
	// fourth button joined the row. `min-w-0` is what lets `truncate` actually engage,
	// and the name is the right thing to lose: it is the one piece of this bar you can
	// reconstruct from the list you opened it from.
	const title = document.createElement('span')
	title.className = 'min-w-0 flex-1 truncate font-bold text-label'
	title.textContent = name
	// A label, not a control. First thing to go, because at the widths where this bar
	// is tight the panel showing a live terminal is not in doubt.
	const live = document.createElement('span')
	live.className = 'hidden shrink-0 text-[0.72rem] text-faint min-[480px]:inline'
	live.textContent = 'live terminal'
	// Shown only when it does something. Both modes draw the same thing at any width
	// that fits the grid, so paint() reveals this from the same test that chooses
	// between them rather than from a breakpoint that only approximates it — a
	// desktop window dragged narrow enough gets the control too.
	const mode = document.createElement('button')
	mode.type = 'button'
	mode.id = 'screenmode'
	mode.hidden = true
	mode.className = 'flex min-h-11 cursor-pointer items-center rounded border border-line bg-transparent px-3 text-[0.78rem] text-muted hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold'
	const label = () => {
		mode.textContent = term.wrap ? 'Wrapped' : 'Exact'
		mode.title = term.wrap ? 'Lines are reflowed to fit the window. Tap for the true grid.' : 'The true grid, exactly as the terminal draws it. Tap to fit it to the window.'
	}
	label()
	mode.addEventListener('click', () => {
		term.wrap = !term.wrap
		saveWrap()
		label()
		// the grid has not changed — only how we draw it — so the guard has to be told
		repaintSoon()
		refresh()
	})

	// Was a bare ✕ at `px-1` — about a 20px target, unlabelled, sat next to a
	// bordered button that read as the real control. Now it says what it does and
	// clears 44px, which is the smallest thing a thumb reliably hits.
	//
	// The WORD drops below 400px, never the button. The note above is about a bare ✕
	// being a 20px target and it stands — but what fixed that was the 44px box, which
	// `min-w-11` keeps at every width, and `aria-label` keeps the name for a screen
	// reader. Four controls plus a readable session name do not fit a phone otherwise,
	// and what was there instead was Close running off the edge of the panel.
	const x = document.createElement('button')
	x.type = 'button'
	const xMark = document.createElement('span')
	xMark.textContent = '✕'
	const xWord = document.createElement('span')
	xWord.className = 'hidden min-[400px]:inline'
	xWord.textContent = 'Close'
	x.append(xMark, xWord)
	x.setAttribute('aria-label', 'Close the terminal')
	x.title = 'Close the terminal (Esc)'
	// Red outline, so the way out is the one thing in this bar that is not grey.
	// Not a red FILL — that reads as destructive, and this closes a panel. Not
	// gold either: the Send button below it is gold, and two identical buttons
	// where one sends and one closes is a mix-up waiting to happen. 5.41:1.
	x.className =
		'flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot'
	tap(x, () => hooks.close())
	// Grouped so the pair stays right-aligned when the mode button is hidden — two
	// separate `ml-auto`s would split the free space and strand them apart.
	// Show or hide the answer keys. Next to Close because that is where the hand
	// already is, and because both are things you reach for about as often.
	const keysBtn = document.createElement('button')
	keysBtn.type = 'button'
	keysBtn.id = 'keystoggle'
	const labelKeys = () => {
		keysBtn.textContent = '⌨'
		keysBtn.title = term.keypad ? 'Hide the prompt keys' : 'Show the keys: arrows and enter for a prompt, and Claude Code shortcuts'
		keysBtn.className = `flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded border bg-transparent px-2 text-[0.95rem] ${term.keypad ? 'border-gold text-gold' : 'border-line text-muted'}`
	}
	labelKeys()
	tap(keysBtn, () => {
		term.keypad = !term.keypad
		saveKeypad()
		labelKeys()
		const row = document.getElementById('promptkeys')
		if (row) row.hidden = !term.keypad
	})

	// Read the conversation back.
	//
	// Here, beside the other two, because this is the question the terminal view
	// provokes and cannot answer: the screen has no scrollback to give. Claude Code
	// draws on the alternate screen and Ghostty hardcodes `scrollback-limit = 0`
	// there, so the lines are gone before cmux sees them — measured as
	// `scrollback_rows: 0` on every Claude pane against 115 on a plain shell. The
	// history is read from the transcript instead, in its own view.
	const logBtn = document.createElement('button')
	logBtn.type = 'button'
	logBtn.id = 'transcripttoggle'
	logBtn.textContent = '☰'
	logBtn.title = 'Read the conversation history — the terminal itself keeps no scrollback'
	logBtn.setAttribute('aria-label', 'Read the conversation history')
	logBtn.className =
		'flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded border border-line bg-transparent px-2 text-[0.95rem] text-muted'
	tap(logBtn, () => {
		if (term.openId) openTranscript(term.openId, term.openName, token())
	})

	// `shrink-0`, so the controls are never the thing that gives way. Everything in
	// here is a target you have to be able to hit; the title above is not.
	const tail = document.createElement('div')
	tail.className = 'ml-auto flex shrink-0 items-center gap-2'
	tail.append(fitButton(), mode, logBtn, keysBtn, x)
	bar.append(title, live, tail)
	return bar
}

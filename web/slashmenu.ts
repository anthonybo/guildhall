/**
 * Picking a slash command instead of spelling it.
 *
 * Claude Code's own autocomplete cannot help here: guildhall sends a line and its
 * carriage return in ONE call, so the TUI never sees the keystrokes that would open
 * its menu. The name has to be right before it leaves the phone, and these names are
 * long — reported as "impossible to really add slash commands", with the name
 * misspelled twice in the report.
 *
 * Picking INSERTS rather than sends. You almost always want to add something after
 * the command, and a list where a mis-tap fires a command at a session is a worse
 * thing than a list where a mis-tap types six characters.
 */
import { insertCommand, tap, tapList } from './dom.ts'
import { api, keepDraft, term } from './termstate.ts'

/** The list and the button that opens it, both working on the message box `input`. */
export function slashMenu(input: HTMLInputElement) {
	const menu = document.createElement('div')
	menu.hidden = true
	// A column: the search field stays put and only the list scrolls under it. As one
	// scrolling box the field scrolled away, which on a list of a dozen is the moment
	// you want it.
	// 60% of the PANEL, not of the screen.
	//
	// It was a fixed 288px, which with 67px rows fitted 3.4 of them and made a list of
	// thirteen read as five — "it still only shows like 5 options". 60% is the fix, but
	// `60vh` is measured against the viewport, and the panel is shorter than the viewport
	// whenever the keyboard is up: measured at 434px inside a 380px panel, which pushes
	// the message box off the bottom. That is the failure this panel already has a note
	// about. A percentage of the panel cannot outgrow it, and `min-h-0` lets it shrink
	// further when there is genuinely no room.
	menu.className = 'flex max-h-[60%] min-h-0 flex-col border-t border-line bg-panel'
	/**
	 * Its own search box.
	 *
	 * Filtering from the message box works and is not discoverable: it needs a leading
	 * slash to engage, so somebody who opens the list with the button and types is
	 * filtering nothing. Reported as not being able to search the list at all.
	 */
	const find = document.createElement('input')
	find.type = 'search'
	find.autocomplete = 'off'
	find.placeholder = 'Search commands…'
	// 16px for the same reason as the message box: anything smaller makes iOS zoom the
	// whole page when it takes focus.
	find.className = 'm-2 min-h-11 shrink-0 rounded border border-muted/50 bg-bg px-2.5 py-2 font-mono text-[16px] text-label'
	find.addEventListener('input', () => paintMenu(find.value.replace(/^\//, '')))
	const count = document.createElement('div')
	count.className = 'shrink-0 px-3 pb-1 text-[0.62rem] tracking-wide text-muted'
	const list = document.createElement('div')
	list.className = 'min-h-0 flex-1 overflow-y-auto overscroll-contain'
	/** Draw the list, filtered by whatever follows the slash. */
	const paintMenu = (filter: string) => {
		const slash = term.slash
		const q = filter.toLowerCase()
		const hits = slash.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 40)
		list.replaceChildren()
		// How many, always. Somebody who can see four rows of a scrolling list has no way
		// to know whether that is all of them.
		count.textContent = slash.length ? (hits.length === slash.length ? `${slash.length} commands` : `${hits.length} of ${slash.length}`) : ''
		if (!hits.length) {
			const empty = document.createElement('div')
			empty.className = 'px-3 py-2 text-[0.72rem] text-muted'
			empty.textContent = slash.length ? `nothing matching "${filter}"` : 'no commands found on this machine'
			list.append(empty)
			return
		}
		for (const c of hits) {
			const row = document.createElement('button')
			row.type = 'button'
			row.className = 'flex min-h-11 w-full cursor-pointer flex-col justify-center border-b border-line/60 px-3 py-1 text-left'
			const name = document.createElement('span')
			name.className = 'text-[0.8rem] font-bold text-gold'
			name.textContent = `/${c.name}`
			row.append(name)
			if (c.description) {
				const desc = document.createElement('span')
				// One line, not two. Two lines made a 67px row, which is a third of what fits
				// on screen spent on a hint you are skimming past.
				desc.className = 'truncate text-[0.68rem] text-muted'
				desc.textContent = c.description
				row.append(desc)
			}
			// A plain `click`, NOT `tap()`.
			//
			// `tap` acts on `pointerdown` for touch and cancels the event, which is right
			// for a lone button that disappears under the finger and catastrophic in a
			// list: cancelling the press stops the browser scrolling, and acting on it
			// picks whatever the finger first landed on. Reported as "I cannot scroll
			// down that list". A click is only delivered when a tap did NOT become a
			// scroll, which is precisely the rule wanted here, and the browser already
			// knows it.
			tapList(row, () => {
				// INSERTED, never assigned. Assigning threw away whatever was already in the
				// box, which is almost always something: the command tends to be the last
				// thing added to a request rather than the first.
				const { value, caret } = insertCommand(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, c.name)
				input.value = value
				keepDraft(term.openId, value)
				term.msgKey = null
				closeMenu()
				input.focus()
				// After focus, or the browser puts the caret at the end of its own accord.
				input.setSelectionRange(caret, caret)
			})
			list.append(row)
		}
	}
	menu.append(find, count, list)
	const closeMenu = () => {
		menu.hidden = true
		labelSlash()
	}
	const openMenu = async (focusSearch = false) => {
		menu.hidden = false
		labelSlash()
		if (!term.slash.length) {
			// `api()` describes the screen reply; this route answers something else, so it
			// goes through `unknown` rather than pretending the shapes overlap.
			const r = (await api(`/api/commands${term.openId ? `?id=${encodeURIComponent(term.openId)}` : ''}`)) as unknown as { commands?: typeof term.slash }
			term.slash = Array.isArray(r.commands) ? r.commands : []
		}
		// What is already half-typed in the message box seeds the search, so opening the
		// list after typing `/imp` does not throw that away.
		const seed = input.value.startsWith('/') ? (input.value.slice(1).split(' ')[0] ?? '') : ''
		if (focusSearch) {
			find.value = seed
			// Focused only when the button was pressed. Focusing on every keystroke of
			// type-ahead would move the caret out of the message box mid-word.
			find.focus()
		}
		paintMenu(focusSearch ? seed : find.value || seed)
	}
	const slashBtn = document.createElement('button')
	slashBtn.type = 'button'
	slashBtn.textContent = '/'
	function labelSlash() {
		const open = !menu.hidden
		slashBtn.title = open ? 'Hide the commands' : 'Pick a slash command'
		slashBtn.setAttribute('aria-label', 'Pick a slash command')
		slashBtn.setAttribute('aria-expanded', String(open))
		slashBtn.className = `flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded border bg-transparent text-[16px] font-bold ${
			open ? 'border-gold text-gold' : 'border-muted/50 text-muted'
		}`
	}
	labelSlash()
	tap(slashBtn, () => (menu.hidden ? void openMenu(true) : closeMenu()))
	return { menu, slashBtn, openMenu, closeMenu }
}

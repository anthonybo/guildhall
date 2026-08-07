/**
 * Viewing preferences, and the panel that edits them.
 *
 * These stay in the browser rather than in the server's config.json, and that is
 * a deliberate line: the page is read-only, and a phone on the sofa changing how
 * the terminal on the desk draws itself would be a surprise nobody asked for.
 * They are also genuinely per-device — the room is hidden on a phone and shown on
 * a laptop, so one shared value would be wrong on one of them.
 *
 * SETTINGS is the whole spec. Adding an option means adding an entry and reading
 * `settings.<key>` where it applies; the panel, the persistence and the
 * round-tripping all follow from the declaration.
 */

export type Settings = {
	/** how a project's name sits by its desks: down the side, or along the aisle */
	labels: 'vertical' | 'horizontal'
	/** draw the office at all. Independent of the width rule, which still wins. */
	room: boolean
}

type Option<K extends keyof Settings> = { value: Settings[K]; label: string }
type Spec = { [K in keyof Settings]: { key: K; label: string; help: string; options: Option<K>[] } }[keyof Settings]

/** The default matches the terminal's, so the two views open looking alike. */
export const DEFAULTS: Settings = { labels: 'vertical', room: true }

const SETTINGS: Spec[] = [
	{
		key: 'labels',
		label: 'Project names',
		help: 'Down the side of a desk takes far less width, so more projects fit before the room runs out.',
		options: [
			{ value: 'vertical', label: 'Down the side' },
			{ value: 'horizontal', label: 'Along the aisle' },
		],
	},
	{
		key: 'room',
		label: 'Office',
		help: 'Hiding it stops the animation as well, which is most of what this page costs a laptop battery.',
		options: [
			{ value: true, label: 'Shown' },
			{ value: false, label: 'Hidden' },
		],
	},
]

const KEY = 'guildhall.settings'

/** Anything unrecognised falls back to the default, so a hand-edited or
 *  out-of-date value can never leave the page in a state the UI cannot show. */
function read(): Settings {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>
		const out = { ...DEFAULTS }
		for (const s of SETTINGS) {
			const v = raw[s.key]
			if (s.options.some((o) => o.value === v)) (out[s.key] as Settings[typeof s.key]) = v as never
		}
		return out
	} catch {
		return { ...DEFAULTS }
	}
}

export const settings: Settings = read()

/**
 * Wire up the gear and build the panel. `onChange` fires after every edit, and
 * after nothing else — the caller decides what a change means.
 */
export function mountSettings(button: HTMLButtonElement, panel: HTMLElement, onChange: () => void) {
	for (const s of SETTINGS) {
		const group = document.createElement('div')
		// a divider between groups, never above the first one
		group.className = 'not-first:mt-4 not-first:border-t not-first:border-line not-first:pt-4'
		const name = document.createElement('span')
		name.className = 'mb-1.5 block text-[0.82rem] text-label'
		name.id = `set-${s.key}`
		name.textContent = s.label

		const choices = document.createElement('div')
		// the controls stack rather than squeeze once the labels stop fitting
		choices.className = 'flex flex-wrap gap-1.5'
		choices.setAttribute('role', 'radiogroup')
		choices.setAttribute('aria-labelledby', name.id)
		for (const o of s.options) {
			const b = document.createElement('button')
			b.type = 'button'
			b.className =
				'flex-1 basis-32 cursor-pointer rounded border border-line bg-bg px-2 py-1.5 text-[0.78rem] text-muted hover:border-faint hover:text-label focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold aria-checked:border-gold aria-checked:bg-gold aria-checked:text-bg'
			b.setAttribute('role', 'radio')
			b.textContent = o.label
			const sync = () => b.setAttribute('aria-checked', String(settings[s.key] === o.value))
			sync()
			b.addEventListener('click', () => {
				;(settings[s.key] as Settings[typeof s.key]) = o.value as never
				try {
					localStorage.setItem(KEY, JSON.stringify(settings))
				} catch {
					// private browsing refuses writes; the choice still applies for this visit
				}
				for (const el of choices.querySelectorAll('[role=radio]')) el.setAttribute('aria-checked', 'false')
				b.setAttribute('aria-checked', 'true')
				onChange()
			})
			choices.append(b)
		}

		const help = document.createElement('p')
		help.className = 'mt-1.5 mb-0 text-[0.72rem]/[1.4] text-faint'
		help.textContent = s.help
		group.append(name, choices, help)
		panel.append(group)
	}

	const note = document.createElement('p')
	note.className = 'mt-3.5 mb-0 border-t border-line pt-3 text-[0.72rem]/[1.4] text-faint'
	note.textContent = 'Saved in this browser only. The terminal keeps its own settings.'
	panel.append(note)

	const open = (want: boolean) => {
		panel.hidden = !want
		button.setAttribute('aria-expanded', String(want))
		if (want) panel.querySelector<HTMLButtonElement>('[role=radio]')?.focus()
		else button.focus()
	}
	button.addEventListener('click', (e) => {
		e.stopPropagation()
		open(panel.hidden)
	})
	// Clicking anywhere else closes it. Pointerdown rather than click so a drag
	// that starts outside does not leave the panel open under the cursor.
	document.addEventListener('pointerdown', (e) => {
		if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== button) open(false)
	})
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !panel.hidden) open(false)
	})
}

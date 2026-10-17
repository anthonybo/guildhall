/**
 * Your own messages in the history, as a list to jump between.
 *
 * Asked for directly: in a long log, finding a question you asked meant scrolling up
 * and up for it. The list is every message you typed in the session, from the server
 * (data/mine.ts), not only what the history has loaded: built from loaded pages it said
 * "none of your messages are loaded yet" and needed "Show earlier" tapped again and again.
 *
 * A sheet over the history rather than a sidebar, because a phone has no room beside it.
 */
import { ago, tap } from './dom.ts'

export type Mine = { at: string; text: string; line: number; queued?: true }

/** "3m ago", or "just now". */
function since(at: string) {
	const t = Date.parse(at)
	if (!Number.isFinite(t)) return ''
	const a = ago(Math.max(0, Date.now() - t))
	return a === 'now' ? 'just now' : `${a} ago`
}

/**
 * The bar button and the sheet it opens. `host` is the element the sheet sits over;
 * `list` fetches the messages; `go` brings one into view, loading history back to it,
 * and resolves false when it could not.
 */
export function yourMessages(host: HTMLElement, list: () => Promise<Mine[] | null>, go: (line: number) => Promise<boolean>) {
	const button = document.createElement('button')
	button.type = 'button'
	button.title = 'Your messages: jump to any of them'
	button.className =
		'flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded border border-you/50 bg-transparent px-3 text-[0.72rem] text-you hover:border-you hover:bg-you/10'
	button.textContent = 'You'

	const sheet = document.createElement('div')
	sheet.hidden = true
	sheet.className = 'absolute inset-x-0 top-0 z-10 flex max-h-[75%] flex-col border-b border-you/40 bg-panel shadow-[0_12px_32px_rgb(0_0_0/55%)]'

	const head = document.createElement('div')
	head.className = 'flex shrink-0 items-center gap-2 px-3 pt-2 pb-1'
	const title = document.createElement('span')
	title.className = 'min-w-0 flex-1 text-[0.72rem] font-bold tracking-[0.08em] text-you'
	title.textContent = 'YOUR MESSAGES'
	const shut = document.createElement('button')
	shut.type = 'button'
	shut.title = 'Close the list'
	shut.className = 'flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded text-[0.9rem] text-muted hover:text-label'
	shut.textContent = '✕'
	head.append(title, shut)

	// 16px: anything smaller makes iOS zoom the page when the box is focused.
	const search = document.createElement('input')
	search.type = 'search'
	search.placeholder = 'Find a message…'
	search.autocomplete = 'off'
	search.className = 'mx-3 mb-2 min-h-11 shrink-0 rounded border border-line bg-bg px-2.5 text-[16px] text-label placeholder:text-faint'

	const rows = document.createElement('div')
	rows.className = 'min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-2'
	sheet.append(head, search, rows)
	host.append(sheet)

	let items: Mine[] = []
	const note = (text: string) => {
		const n = document.createElement('div')
		n.className = 'py-4 text-center text-[0.72rem] text-muted'
		n.textContent = text
		return n
	}
	const draw = () => {
		const q = search.value.trim().toLowerCase()
		// Newest first: the one you are looking for is usually recent.
		const shown = [...items].reverse().filter((m) => !q || m.text.toLowerCase().includes(q))
		const out: HTMLElement[] = []
		for (const m of shown.slice(0, 300)) {
			const row = document.createElement('button')
			row.type = 'button'
			row.className = 'mb-1 block w-full cursor-pointer rounded-r border-l-[3px] border-l-you bg-bg/60 px-2.5 py-1.5 text-left hover:bg-you/10 active:bg-you/15'
			const meta = document.createElement('div')
			meta.className = 'text-[0.64rem] text-you/80'
			meta.textContent = m.queued ? `${since(m.at)} · sent while Claude was working` : since(m.at)
			const what = document.createElement('div')
			what.className = 'line-clamp-2 text-[0.76rem] leading-snug break-words text-you-soft'
			what.textContent = m.text
			row.append(meta, what)
			tap(row, async () => {
				meta.textContent = 'finding it…'
				const found = await go(m.line)
				if (found) close()
				else meta.textContent = 'could not find it in the history'
			})
			out.push(row)
		}
		if (!shown.length) out.push(note(items.length ? 'nothing matches' : 'no messages from you yet'))
		else if (shown.length > 300) out.push(note(`${shown.length - 300} older — search to narrow it down`))
		rows.replaceChildren(...out)
	}

	const close = () => {
		sheet.hidden = true
		button.setAttribute('aria-expanded', 'false')
		search.blur()
	}
	const open = async () => {
		sheet.hidden = false
		button.setAttribute('aria-expanded', 'true')
		rows.replaceChildren(note('reading…'))
		const got = await list()
		if (sheet.hidden) return
		if (!got) return void rows.replaceChildren(note('could not read your messages'))
		items = got
		title.textContent = `YOUR MESSAGES · ${items.length}`
		button.textContent = `You · ${items.length}`
		rows.scrollTop = 0
		draw()
	}
	tap(button, () => (sheet.hidden ? void open() : close()))
	tap(shut, close)
	search.addEventListener('input', draw)
	return { button, close }
}

/** Bring a card into view and flash it, so the eye lands on the right one. */
export function flash(card: HTMLElement) {
	card.scrollIntoView({ block: 'start' })
	card.classList.add('ring-2', 'ring-you')
	setTimeout(() => card.classList.remove('ring-2', 'ring-you'), 1800)
}

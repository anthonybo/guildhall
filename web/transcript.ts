/**
 * Reading back through a session's conversation.
 *
 * The terminal view cannot show history and never will. Claude Code draws on the
 * terminal's ALTERNATE screen, where Ghostty — which cmux embeds — hardcodes
 * `scrollback-limit = 0`, so the lines are discarded by the emulator before cmux or
 * guildhall could see them. Every Claude pane on this machine reports
 * `scrollback_rows: 0` against 115 for a plain shell. Rebuilding a scrollback from the
 * screens guildhall already polls was tried, measured and abandoned — see MISTAKES.md.
 *
 * So this is a SECOND view, not a replacement. The terminal view keeps the live screen,
 * the status bar and the keys that answer a prompt, because all three are things only a
 * real screen can do. This one is for reading, and it reads the transcript on disk.
 *
 * It is styled to match the terminal — same mono face, same palette — because it is the
 * same conversation, and a different-looking panel would read as a different program.
 * It WRAPS where the terminal does not: a terminal is a fixed grid that must not
 * reflow, and this is prose with no grid to keep.
 */
import { tap } from './dom.ts'
import { linkParts } from './links.ts'
import { fullScreen, lockPage, unlockPage } from './viewport.ts'

type Entry = {
	at: string
	role: 'user' | 'assistant'
	kind: 'text' | 'thinking' | 'tool' | 'result'
	text: string
	tool?: string
}
type Page = { entries: Entry[]; cursor: number | null; size: number }

let el: HTMLElement | null = null
let body: HTMLElement | null = null
let cursor: number | null = null
let openId: string | null = null
let loading = false
let exhausted = false

/** Terminal output is never innerHTML. Links are built as real nodes. */
function withLinks(text: string): DocumentFragment {
	const frag = document.createDocumentFragment()
	for (const part of linkParts(text)) {
		if (!part.href) {
			frag.append(document.createTextNode(part.text))
			continue
		}
		const a = document.createElement('a')
		a.href = part.href
		a.textContent = part.text
		a.target = '_blank'
		// noopener because the opened page must not get a handle on this one, and
		// noreferrer because a session's output can contain private URLs.
		a.rel = 'noopener noreferrer'
		a.className = 'text-newer underline decoration-dotted underline-offset-2'
		frag.append(a)
	}
	return frag
}

/** One entry, drawn the way the terminal draws that kind of thing. */
function render(e: Entry): HTMLElement {
	const row = document.createElement('div')
	row.className = 'whitespace-pre-wrap break-words'
	const mark = document.createElement('span')
	// The same glyphs the terminal uses, so the two views read as one program: ❯ for
	// what you said, ⏺ for a tool call, ⎿ for what it returned.
	if (e.kind === 'text' && e.role === 'user') {
		row.className += ' mt-3 text-gold'
		mark.textContent = '❯ '
	} else if (e.kind === 'tool') {
		row.className += ' mt-2 text-ok'
		mark.textContent = '⏺ '
	} else if (e.kind === 'result') {
		row.className += ' text-muted'
		mark.textContent = '  ⎿  '
	} else if (e.kind === 'thinking') {
		row.className += ' mt-2 text-faint italic'
		mark.textContent = '✻ '
	} else {
		row.className += ' mt-2 text-label'
		mark.textContent = ''
	}
	if (mark.textContent) row.append(mark)
	const text = e.kind === 'tool' ? `${e.tool}(${e.text})` : e.text
	row.append(withLinks(text))
	return row
}

/**
 * Fetch a page and put it in.
 *
 * Older pages are PREPENDED and the scroll position is restored by height difference,
 * or reading upward would yank the reader back to the top on every load.
 */
async function load(token: string, older: boolean) {
	if (!body || !openId || loading || (older && exhausted)) return
	loading = true
	const note = older ? topNote('reading older…') : null
	try {
		const q = older && cursor !== null ? `&before=${cursor}` : ''
		const res = await fetch(`/api/transcript?id=${encodeURIComponent(openId)}${q}`, {
			signal: AbortSignal.timeout(20_000),
			headers: { 'x-guildhall-control': token },
		})
		const data = (await res.json().catch(() => ({ error: 'unreadable reply' }))) as Page & { error?: string }
		note?.remove()
		if (!res.ok || data.error) {
			body.prepend(topNote(data.error ?? `the server said ${res.status}`))
			return
		}
		const before = body.scrollHeight
		const frag = document.createDocumentFragment()
		for (const e of data.entries) frag.append(render(e))
		if (older) {
			body.prepend(frag)
			// Hold the reader's place: the content above them just got taller.
			body.scrollTop += body.scrollHeight - before
		} else {
			body.append(frag)
			body.scrollTop = body.scrollHeight
		}
		cursor = data.cursor
		if (data.cursor === null) {
			exhausted = true
			body.prepend(topNote('the beginning of this conversation'))
		}
	} catch {
		note?.remove()
		body.prepend(topNote('could not reach guildhall'))
	} finally {
		loading = false
	}
}

function topNote(text: string): HTMLElement {
	const n = document.createElement('div')
	n.className = 'py-2 text-center text-[0.72rem] text-muted'
	n.textContent = text
	return n
}

/** Open the transcript for a session. `token` is the control token the terminal holds. */
export function openTranscript(id: string, name: string, token: string) {
	openId = id
	cursor = null
	exhausted = false
	if (!el) {
		el = document.createElement('div')
		el.id = 'transcript'
		document.body.append(el)
	}
	// Same shell as the terminal panel: full screen on a phone, a centred panel on a
	// desktop, above everything else on the page.
	el.className = `fixed inset-0 z-50 flex flex-col border-line bg-panel text-label ${fullScreen() ? '' : 'sm:inset-8 sm:rounded-lg sm:border'}`
	el.hidden = false
	el.replaceChildren()
	lockPage('transcript')

	const bar = document.createElement('div')
	bar.className = 'flex items-center gap-2 border-b border-line px-3 py-2'
	const title = document.createElement('div')
	title.className = 'truncate text-[0.8rem] font-bold'
	title.textContent = `${name} · transcript`
	const why = document.createElement('div')
	why.className = 'hidden text-[0.68rem] text-muted sm:block'
	// Says why this is a separate view at all, where the question gets asked.
	why.textContent = 'read from the log — the terminal keeps no scrollback'
	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕ Close'
	x.title = 'Back to the terminal (Esc)'
	x.className =
		'ml-auto flex min-h-11 cursor-pointer items-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg'
	tap(x, closeTranscript)
	bar.append(title, why, x)

	body = document.createElement('div')
	body.className = 'min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 font-mono text-[0.78rem] leading-[1.45]'
	body.textContent = 'reading…'
	// Reading upward is the whole point, so older pages load as you approach the top.
	body.addEventListener('scroll', () => {
		if (body && body.scrollTop < 240) void load(token, true)
	})

	el.append(bar, body)
	body.replaceChildren()
	void load(token, false)
	document.addEventListener('keydown', onKey)
}

function onKey(e: KeyboardEvent) {
	if (e.key === 'Escape') closeTranscript()
}

export function closeTranscript() {
	document.removeEventListener('keydown', onKey)
	openId = null
	body = null
	if (el) {
		el.hidden = true
		el.replaceChildren()
	}
	unlockPage('transcript')
}

/** Whether the transcript is on screen, so the page does not reload underneath it. */
export const transcriptOpen = () => openId !== null

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
 * WHAT IT SHOWS BY DEFAULT is the whole design, and the first version got it wrong by
 * showing everything. Measured over three pages of a real session:
 *
 *   tool results     36 entries   46.6% of all text
 *   tool calls       38 entries   19.4%
 *   assistant prose  17 entries   32.1%
 *   your messages     3 entries    1.9%
 *
 * Two thirds of it is machine chatter, and the thing you navigate by — your own
 * messages — is 2% of the page and three entries in ninety-four. Reported as "a bunch
 * of useless info". So the conversation is the default and the tool work folds into one
 * line per run, which is a summary rather than a hiding place: it says how many steps
 * ran and how many failed, and opens on a tap.
 *
 * Styled to match the terminal — same mono face, same palette — because it is the same
 * conversation. It WRAPS where the terminal does not: a terminal is a fixed grid that
 * must not reflow, and this is prose with no grid to keep.
 */
import { ago, rgb, tap } from './dom.ts'
import { renderMarkdown } from './mdview.ts'
import { inserted, typedForm } from './said.ts'
import { cover, lockPage, uncover, unlockPage } from './viewport.ts'
import { TINT } from '../src/screens.ts'
import { forgetImages, historyImage, watchImages } from './historyimage.ts'
import { type Entry, toolName, withLinks } from './transcripttools.ts'
import { run } from './transcriptsteps.ts'
import { type Mine, flash, yourMessages } from './yourmessages.ts'
import { dropEscape, holdEscape, typing } from './escape.ts'

type Page = { entries: Entry[]; cursor: number | null; size: number; end?: number }

const MODE = 'guildhall.transcript.mode'

let el: HTMLElement | null = null
let body: HTMLElement | null = null
let cursor: number | null = null
let openId: string | null = null
/** The control password this history was opened with, for fetching its pictures. */
let openToken = ''
/** Where the newest complete line ended when last read — what to ask for after. */
let end: number | null = null
/** The newest page's container, redrawn in place as the session writes more. */
let newestBox: HTMLElement | null = null
let liveTimer: ReturnType<typeof setInterval> | undefined
/** Each of your message cards, by the byte offset of its line, for the "You" list. */
let cards = new Map<number, HTMLElement>()
let loading = false
let exhausted = false
/** `talk` is the conversation with tool runs folded; `all` opens every run. */
let mode: 'talk' | 'all' = localStorage.getItem(MODE) === 'all' ? 'all' : 'talk'

/** Prose: what you said, and what came back. */
function prose(e: Entry): HTMLElement {
	const row = document.createElement('div')
	const notice = e.kind === 'text' && e.role === 'user' ? inserted(e.text) : null
	if (notice !== null) {
		row.className = 'mt-3 rounded border border-dashed border-line px-2 py-1 text-[0.68rem] text-muted break-words'
		row.textContent = notice
		return row
	}
	if (e.kind === 'text' && e.role === 'user') {
		// Your own messages are the landmarks — three of them in ninety-four entries,
		// and the only way to find your place. A card of their own: a colour nothing
		// else uses (see `--color-you`), a thick bar, a frame and a tint, and space
		// around it. They were gold, which is also every heading, button and highlight
		// here, so in a long log they did not stand out — reported as exactly that.
		row.className =
			'mt-6 mb-2 rounded-md border border-you/35 border-l-4 border-l-you bg-you/10 px-3 py-2 whitespace-pre-wrap break-words text-you-soft shadow-[0_0_0_1px_rgb(255_121_198/8%)]'
	} else if (e.kind === 'thinking') {
		row.className = 'mt-3 whitespace-pre-wrap break-words italic'
		row.style.color = rgb(TINT.think)
	} else {
		row.className = 'mt-3 whitespace-pre-wrap break-words text-label'
	}
	// When, on your own messages only.
	//
	// This is the "context" half of finding a place: the landmarks are yours, and
	// "3h" against one of them is what turns a wall of conversation into somewhere you
	// can navigate. Putting it on every entry would be noise — the assistant's replies
	// are all within a minute or two of the message above them.
	if (e.kind === 'text' && e.role === 'user') {
		// A label line, so the card names itself: "YOU · 3h".
		const head = document.createElement('div')
		head.className = 'mb-1 text-[0.64rem] font-bold tracking-[0.12em] text-you'
		const when = e.at ? Date.parse(e.at) : NaN
		head.textContent = Number.isFinite(when) ? `YOU · ${ago(Math.max(0, Date.now() - when))}` : 'YOU'
		// Typed during a long turn, it reached Claude between tool calls rather than as a
		// turn of its own — worth knowing when reading what came back.
		if (e.queued) head.textContent += ' · sent while Claude was working'
		row.append(head)
		// So the "You" list can jump to it.
		if (e.line !== undefined) cards.set(e.line, row)
	}
	// The assistant's replies carry structure — headings, bullets, code, a closing
	// summary — and drawing them as one flat colour is what made a TL;DR impossible to
	// find without reading the whole message. Your own messages stay plain: they are
	// short, they are already the landmark, and a heading inside one would compete
	// with that.
	if (e.role === 'assistant' && e.kind === 'text') row.append(renderMarkdown(e.text))
	else if (e.role === 'user' && e.kind === 'text') row.append(withLinks(typedForm(e.text)))
	else row.append(withLinks(e.text))
	return row
}

/** Turn a page of entries into rows, folding each stretch of tool work into a run. */
function build(entries: Entry[]): DocumentFragment {
	const frag = document.createDocumentFragment()
	// Results are matched to their call by id, so a result never lands under the wrong
	// one if the file ever interleaves them.
	const results = new Map<string, Entry>()
	for (const e of entries) if (e.kind === 'result' && e.for) results.set(e.for, e)
	const orphans = entries.filter((e) => e.kind === 'result' && !e.for)
	// Which call a picture came back from, for its caption.
	const calls = new Map<string, Entry>()
	for (const e of entries) if (e.kind === 'tool' && e.id) calls.set(e.id, e)

	let steps: { call: Entry; result?: Entry }[] = []
	// Pictures Claude read go under the run of steps that read them, the way the terminal
	// draws them under the Read; they stay visible when the run is folded.
	let read: HTMLElement[] = []
	const flush = () => {
		if (steps.length) frag.append(run(steps, mode === 'all'))
		steps = []
		frag.append(...read)
		read = []
	}
	for (const e of entries) {
		if (e.kind === 'image') {
			if (!openId || !e.image) continue
			const call = e.for ? calls.get(e.for) : undefined
			const caption = call ? `${toolName(call.tool ?? 'tool')}${call.tool === 'Read' && call.text ? ` (${call.text.split('/').pop()})` : ''}` : undefined
			const pic = historyImage(openId, e.image, openToken, !e.for, caption)
			if (e.for) read.push(pic)
			else {
				flush()
				frag.append(pic)
			}
			continue
		}
		if (e.kind === 'tool') {
			steps.push({ call: e, result: e.id ? results.get(e.id) : orphans.shift() })
			continue
		}
		if (e.kind === 'result') continue // shown under its call
		if (e.kind === 'thinking' && mode === 'talk') continue // reasoning, not conversation
		flush()
		frag.append(prose(e))
	}
	flush()
	return frag
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
	let filled = false
	const note = older ? topNote('reading older…') : null
	if (note && older) body.prepend(note)
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
		// Oldest first, so a redraw puts them back in order. Older pages were pushed onto
		// the END, which drew the conversation out of order after switching mode.
		if (older) pages.unshift(data.entries)
		else pages.push(data.entries)
		const before = body.scrollHeight
		const box = pageBox(data.entries)
		if (older) {
			body.prepend(box)
			// Hold the reader's place: the content above them just got taller.
			body.scrollTop += body.scrollHeight - before
		} else {
			body.append(box)
			newestBox = box
			end = data.end ?? null
			body.scrollTop = body.scrollHeight
		}
		cursor = data.cursor
		if (data.cursor === null) {
			exhausted = true
			body.prepend(topNote('the beginning of this conversation'))
		}
		filled = true
	} catch {
		note?.remove()
		body.prepend(topNote('could not reach guildhall'))
	} finally {
		loading = false
	}
	// Older pages load as you scroll near the top, and a page too short to fill the screen
	// has nothing to scroll — so the history just ended there, with no sign there was more.
	// Keep reading back until it overflows. Only after a page that arrived: a failure must
	// not turn into a retry loop.
	if (filled && !exhausted && body && body.scrollHeight - body.clientHeight < 240) void load(token, true)
}

/** Every page fetched, oldest first, so switching mode redraws without refetching. */
let pages: Entry[][] = []

/** One page's rows in a container of their own, so the newest can be redrawn alone. */
function pageBox(entries: Entry[]): HTMLElement {
	const box = document.createElement('div')
	box.append(build(entries))
	return box
}

/**
 * Bring an open history up to date: what the session wrote since it was last read.
 *
 * It used to be read once, on opening, and never again — so a reply that arrived while
 * it was open was not there until it was closed and opened again. Reported as "doesn't
 * seem to have the latest chats". The newest page is redrawn whole rather than appended
 * to, because a tool's result often arrives after its call was drawn, and only a redraw
 * puts it back under the call it answers.
 */
async function catchUp() {
	if (!body || !openId || loading || end === null || document.hidden) return
	const id = openId
	let data: { entries?: Entry[]; end?: number; reset?: true; error?: string }
	try {
		const res = await fetch(`/api/transcript?id=${encodeURIComponent(id)}&after=${end}`, {
			signal: AbortSignal.timeout(15_000),
			headers: { 'x-guildhall-control': openToken },
		})
		data = await res.json()
	} catch {
		return // the next tick tries again
	}
	if (openId !== id || !body) return
	if (data.reset) {
		// Too much since the last look: start over from the newest page.
		pages = []
		end = null
		body.replaceChildren()
		return void load(openToken, false)
	}
	if (!data.entries || data.end === undefined) return
	end = data.end
	if (!data.entries.length || !newestBox) return
	const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 80
	const newest = pages.at(-1)!
	newest.push(...data.entries)
	newestBox.replaceChildren(build(newest))
	// Follow along only if already at the bottom; someone reading further up stays put.
	if (atBottom) body.scrollTop = body.scrollHeight
}

/** Every message you typed in this session, oldest first — see data/mine.ts. */
async function listMine(): Promise<Mine[] | null> {
	if (!openId) return null
	try {
		const res = await fetch(`/api/transcript?id=${encodeURIComponent(openId)}&mine=1`, {
			signal: AbortSignal.timeout(20_000),
			headers: { 'x-guildhall-control': openToken },
		})
		const data = (await res.json()) as { items?: Mine[] }
		return res.ok && data.items ? data.items : null
	} catch {
		return null
	}
}

/**
 * Show one of your messages: read further back until its page is loaded, then jump.
 *
 * Paging back is what scrolling up does anyway, one page at a time; this just does it
 * for you. Bounded by the start of the conversation, and by a page that will not load.
 */
async function goTo(line: number): Promise<boolean> {
	const id = openId
	for (let guard = 0; guard < 2000 && openId === id; guard++) {
		const card = cards.get(line)
		if (card?.isConnected) {
			flash(card)
			return true
		}
		if (exhausted) return false
		if (loading) {
			await new Promise((r) => setTimeout(r, 60))
			continue
		}
		const before = pages.length
		await load(openToken, true)
		if (pages.length === before && !exhausted) return false
	}
	return false
}

function topNote(text: string): HTMLElement {
	const n = document.createElement('div')
	n.className = 'py-2 text-center text-[0.72rem] text-muted'
	n.textContent = text
	return n
}

/** Open the transcript for a session. `token` is the control token the terminal holds. */
export function openTranscript(id: string, name: string, token: string) {
	if (openId === null && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
	openId = id
	cursor = null
	exhausted = false
	pages = []
	end = null
	newestBox = null
	cards = new Map()
	if (!el) {
		el = document.createElement('div')
		el.id = 'transcript'
		document.body.append(el)
	}
	// Same shell as the terminal panel: full screen on a phone, inset over a dimmed page
	// on a desktop — a little further in than the terminal, so a history opened from it
	// reads as on top of it. By the stylesheet's breakpoint rather than decided once on
	// opening, so dragging the window across 880px is followed.
	el.className =
		'fixed inset-0 z-50 flex flex-col border-line bg-panel text-label min-[880px]:inset-8 min-[880px]:rounded-lg min-[880px]:border min-[880px]:shadow-[0_0_0_100vmax_rgb(0_0_0/40%)]'
	el.setAttribute('role', 'dialog')
	el.setAttribute('aria-modal', 'true')
	el.setAttribute('aria-label', `History of ${name}`)
	el.hidden = false
	el.replaceChildren()
	lockPage('transcript')
	cover('transcript')
	// The terminal it was opened from stays open underneath, and was still reachable:
	// measured, Tab from ☰ walked the terminal's keys, box and Send under the history.
	const under = document.getElementById('terminal')
	if (under && !under.hidden) {
		under.inert = true
		madeInert = under
	}

	const bar = document.createElement('div')
	bar.className = 'flex items-center gap-2 border-b border-line px-3 py-2'
	// The same rule the terminal bar had to learn: the title is the only thing that
	// shrinks, and the controls never do.
	const title = document.createElement('span')
	title.className = 'min-w-0 flex-1 truncate text-[0.8rem] font-bold'
	title.textContent = name

	const modeBtn = document.createElement('button')
	modeBtn.type = 'button'
	modeBtn.className = 'flex min-h-11 shrink-0 cursor-pointer items-center rounded border border-line bg-transparent px-3 text-[0.72rem] text-muted hover:border-gold hover:text-gold'
	const labelMode = () => {
		modeBtn.textContent = mode === 'talk' ? 'Conversation' : 'Everything'
		modeBtn.title = mode === 'talk' ? 'Showing the conversation, with tool work folded. Tap for everything.' : 'Showing every step. Tap for the conversation alone.'
	}
	labelMode()
	tap(modeBtn, () => {
		mode = mode === 'talk' ? 'all' : 'talk'
		localStorage.setItem(MODE, mode)
		labelMode()
		// Redraw from what has already been fetched — switching how it is shown must
		// not cost another read of a 119MB file, and must not lose the pages already
		// scrolled up to.
		if (!body) return
		body.replaceChildren()
		for (const p of pages) body.append((newestBox = pageBox(p)))
		if (exhausted) body.prepend(topNote('the beginning of this conversation'))
		body.scrollTop = body.scrollHeight
	})

	const x = document.createElement('button')
	x.type = 'button'
	const xMark = document.createElement('span')
	xMark.textContent = '✕'
	const xWord = document.createElement('span')
	xWord.className = 'hidden min-[400px]:inline'
	xWord.textContent = 'Close'
	x.append(xMark, xWord)
	x.setAttribute('aria-label', 'Close the transcript')
	x.title = 'Back to the terminal (Esc)'
	x.className =
		'flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg'
	tap(x, closeTranscript)
	// Into the history, so a keyboard is where the eye is.
	queueMicrotask(() => x.focus({ preventScroll: true }))

	const tail = document.createElement('div')
	tail.className = 'ml-auto flex shrink-0 items-center gap-2'
	// The history and the "You" sheet that slides over it.
	const stage = document.createElement('div')
	stage.className = 'relative flex min-h-0 flex-1 flex-col'
	const you = yourMessages(stage, listMine, goTo)
	tail.append(you.button, modeBtn, x)
	bar.append(title, tail)

	body = document.createElement('div')
	body.className = 'min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 font-mono text-[0.78rem] leading-[1.5]'
	body.textContent = 'reading…'
	openToken = token
	watchImages(body)
	// Reading upward is the whole point, so older pages load as you approach the top.
	body.addEventListener('scroll', () => {
		if (body && body.scrollTop < 240) void load(token, true)
	})

	stage.append(body)
	el.append(bar, stage)
	body.replaceChildren()
	void load(token, false)
	// Every three seconds while open: a reply shows up about as fast as it is written,
	// and an idle session costs one small read that comes back empty.
	clearInterval(liveTimer)
	liveTimer = setInterval(() => void catchUp(), 3000)
	// Esc closes the history and not the terminal under it — see escape.ts. Not while
	// the search in the "You" sheet has text: that box is `type=search` (yourmessages.ts),
	// whose own Esc clears it — make it a plain text box and that stops being true.
	holdEscape('transcript', () => {
		if (typing()) return false
		closeTranscript()
		return true
	})
}

export function closeTranscript() {
	dropEscape('transcript')
	clearInterval(liveTimer)
	liveTimer = undefined
	openId = null
	body = null
	newestBox = null
	forgetImages()
	pages = []
	if (el) {
		el.hidden = true
		el.replaceChildren()
	}
	unlockPage('transcript')
	uncover('transcript')
	if (madeInert) madeInert.inert = false
	madeInert = null
	// Back to where you were — the ☰ button — rather than to nothing.
	if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true })
	returnFocus = null
}

/** What had focus before the history opened, handed back when it closes. */
let returnFocus: HTMLElement | null = null
/** The terminal under the history, made inert while the history is open. */
let madeInert: HTMLElement | null = null

/** Whether the transcript is on screen, so the page does not reload underneath it. */
export const transcriptOpen = () => openId !== null

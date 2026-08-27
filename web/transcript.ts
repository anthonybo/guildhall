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
import { linkParts } from './links.ts'
import { renderMarkdown } from './mdview.ts'
import { fullScreen, lockPage, unlockPage } from './viewport.ts'
// The room's own tool palette, not a second one invented here. `TINT` is what paints a
// workstation screen by what the session is doing — "so the whole room is readable at a
// glance" — and `KIND` is the map from a tool's name to that class. Reusing both means
// a phone and the office agree about what blue means, and there is one place to change
// it. `screens.ts` is already in this bundle via list.ts, so it costs nothing.
import { TINT } from '../src/screens.ts'
import { KIND } from '../src/data/describe.ts'

type Entry = {
	at: string
	role: 'user' | 'assistant'
	kind: 'text' | 'thinking' | 'tool' | 'result'
	text: string
	tool?: string
	id?: string
	for?: string
	error?: true
	/** The change an edit made: what was removed, and what replaced it. */
	before?: string
	after?: string
}
type Page = { entries: Entry[]; cursor: number | null; size: number }

const MODE = 'guildhall.transcript.mode'

let el: HTMLElement | null = null
let body: HTMLElement | null = null
let cursor: number | null = null
let openId: string | null = null
let loading = false
let exhausted = false
/** `talk` is the conversation with tool runs folded; `all` opens every run. */
let mode: 'talk' | 'all' = localStorage.getItem(MODE) === 'all' ? 'all' : 'talk'

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

/**
 * A tool's name, short enough for a phone.
 *
 * An MCP tool is named `mcp__claude-in-chrome__javascript_tool`, which is 38 characters
 * of mostly plumbing and wraps a 375px screen on its own. The server and the underscores
 * are what get dropped; the verb is what anybody is reading for.
 */
const toolName = (raw: string) => raw.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '').replace(/_/g, ' ')

/**
 * The colour for a tool, by what class of work it is.
 *
 * Blue edits, cyan reads, orange runs, violet searches, green agents — the same five a
 * desk's monitor is tinted with in the room. A tool nobody has classified stays grey
 * rather than being guessed into a colour: a wrong colour is worse than no colour here,
 * because the whole point is that the colour can be trusted at a glance.
 */
function toolTint(raw?: string): string {
	const kind = raw ? KIND[raw.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')] : undefined
	return kind ? rgb(TINT[kind]) : 'var(--color-muted)'
}

/** Prose: what you said, and what came back. */
function prose(e: Entry): HTMLElement {
	const row = document.createElement('div')
	if (e.kind === 'text' && e.role === 'user') {
		// Your own messages are the landmarks — three of them in ninety-four entries,
		// and the only way to find your place. So they get a rule down the side and
		// real space around them rather than one coloured glyph.
		row.className = 'mt-5 border-l-2 border-gold/60 py-1 pl-2 whitespace-pre-wrap break-words text-gold'
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
	if (e.kind === 'text' && e.role === 'user' && e.at) {
		const when = Date.parse(e.at)
		if (Number.isFinite(when)) {
			const stamp = document.createElement('span')
			stamp.className = 'mr-2 text-[0.66rem] text-muted'
			stamp.textContent = ago(Math.max(0, Date.now() - when))
			row.append(stamp)
		}
	}
	// The assistant's replies carry structure — headings, bullets, code, a closing
	// summary — and drawing them as one flat colour is what made a TL;DR impossible to
	// find without reading the whole message. Your own messages stay plain: they are
	// short, they are already the landmark, and a heading inside one would compete
	// with that.
	if (e.role === 'assistant' && e.kind === 'text') row.append(renderMarkdown(e.text))
	else row.append(withLinks(e.text))
	return row
}

/** One tool call, with its result folded underneath until asked for. */
function step(call: Entry, result?: Entry): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'mt-1'
	const line = document.createElement('button')
	line.type = 'button'
	// A whole-width target. These sit in a list of similar lines on a phone, and a
	// small one is the difference between opening what you meant and the one below it.
	// `items-center`, not `items-start`. A 44px target around one line of 12px text
	// leaves ~24px of slack, and top-aligning the label pushed all of it BELOW the
	// text — so an opened result appeared to float, detached from the call it belongs
	// to. Centring splits the slack and the result sits against its line.
	line.className = 'flex w-full min-h-11 cursor-pointer items-center gap-2 rounded px-1 text-left'
	// Tinted by what the tool DOES, so a run can be scanned by colour instead of read.
	// A failure overrides it: something that went wrong is not first a "read" or an
	// "edit", it is a failure, and it should look like one.
	line.style.color = result?.error ? 'var(--color-hot)' : toolTint(call.tool)
	const caret = document.createElement('span')
	caret.className = 'shrink-0 text-muted'
	caret.textContent = result || call.before || call.after ? '▸' : '·'
	const label = document.createElement('span')
	label.className = 'min-w-0 flex-1 break-words'
	label.textContent = `${toolName(call.tool ?? 'tool')}${call.text ? `(${call.text})` : ''}`
	line.append(caret, label)

	const out = document.createElement('div')
	// Given its own ground and a heavier rule, so it reads as belonging to the line
	// above rather than as the next item in the list.
	out.className = 'mt-0.5 hidden rounded-sm border-l-2 bg-bg/60 px-2 py-1.5 text-[0.72rem] text-muted'
	// The rule carries the call's colour, so an opened output is tied to the line it
	// came from even when several are open at once.
	out.style.borderLeftColor = result?.error ? 'var(--color-hot)' : toolTint(call.tool)

	/**
	 * The change, where there was one.
	 *
	 * Opening an edit used to show its RECEIPT — "the file has been updated" — because
	 * that is what the tool returns. The code is in what was sent, not in what came
	 * back. Removed above added, red then green, each scrolling rather than wrapping:
	 * reflowed code is code you cannot trust to read.
	 */
	const chunk = (text: string, mark: string, colour: string) => {
		const box = document.createElement('div')
		// `whitespace-pre` belongs on the TEXT, not on the box. On the container it also
		// preserves the whitespace between child elements, which shows up as blank bands
		// above and below the code the moment anything appends a stray text node.
		box.className = 'mt-1 overflow-x-auto rounded-sm border-l-2 bg-bg/70 px-2 py-1 text-[0.7rem]'
		box.style.borderLeftColor = colour
		box.style.color = colour
		const tag = document.createElement('div')
		tag.className = 'text-[0.62rem] tracking-wide opacity-70'
		tag.textContent = mark
		const body = document.createElement('div')
		body.className = 'whitespace-pre text-label'
		body.textContent = text
		box.append(tag, body)
		return box
	}
	if (call.before) out.append(chunk(call.before, 'removed', 'var(--color-hot)'))
	if (call.after) out.append(chunk(call.after, call.before ? 'added' : 'written', 'var(--color-ok)'))
	if (result) {
		const said = document.createElement('div')
		said.className = 'mt-1 whitespace-pre-wrap break-words'
		said.append(withLinks(result.text || (result.error ? 'failed, with no output' : '')))
		out.append(said)
	}

	// Expandable when there is anything to show — the change counts, not just a result.
	if (result || call.before || call.after) {
		tap(line, () => {
			const open = out.classList.toggle('hidden')
			caret.textContent = open ? '▸' : '▾'
			line.setAttribute('aria-expanded', String(!open))
		})
		line.setAttribute('aria-expanded', 'false')
	} else {
		line.disabled = true
		line.className += ' cursor-default'
	}
	wrap.append(line, out)
	return wrap
}

/**
 * A run of tool work between two pieces of prose, as one line that opens.
 *
 * The summary has to be worth reading on its own, or it is just a door with nothing
 * written on it: it says how many steps ran and how many failed, so a run you do not
 * need can be skipped without opening it, and a run that went wrong announces itself.
 */
function run(steps: { call: Entry; result?: Entry }[]): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'mt-3'
	const failed = steps.filter((s) => s.result?.error).length
	const inner = document.createElement('div')
	inner.className = 'mt-1 border-l border-line pl-2'
	for (const s of steps) inner.append(step(s.call, s.result))

	const toggle = document.createElement('button')
	toggle.type = 'button'
	toggle.className =
		'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded border border-line/70 px-2 text-left text-[0.72rem] text-muted hover:border-gold hover:text-gold'
	const caret = document.createElement('span')
	// One dot per class of work in the run. A folded run is the common case, so it has
	// to say something without being opened: four blue dots is a stretch of editing,
	// orange is commands, and a red one is a failure — legible before the words are.
	const dots = document.createElement('span')
	dots.className = 'flex shrink-0 items-center gap-0.5'
	for (const k of [...new Set(steps.map((s) => (s.result?.error ? 'error' : toolTint(s.call.tool))))]) {
		const d = document.createElement('span')
		d.textContent = '\u25cf'
		d.style.color = k === 'error' ? 'var(--color-hot)' : k
		dots.append(d)
	}
	const words = document.createElement('span')
	words.className = 'min-w-0 flex-1 truncate'
	const names = [...new Set(steps.map((s) => toolName(s.call.tool ?? 'tool')))]
	const summary = `${steps.length} step${steps.length === 1 ? '' : 's'} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
	words.textContent = failed ? `${summary} · ${failed} failed` : summary
	if (failed) words.className = 'text-hot'
	toggle.append(caret, dots, words)

	const set = (open: boolean) => {
		inner.classList.toggle('hidden', !open)
		caret.textContent = open ? '▾' : '▸'
		toggle.setAttribute('aria-expanded', String(open))
	}
	set(mode === 'all')
	tap(toggle, () => set(inner.classList.contains('hidden')))
	wrap.append(toggle, inner)
	return wrap
}

/** Turn a page of entries into rows, folding each stretch of tool work into a run. */
function build(entries: Entry[]): DocumentFragment {
	const frag = document.createDocumentFragment()
	// Results are matched to their call by id, so a result never lands under the wrong
	// one if the file ever interleaves them.
	const results = new Map<string, Entry>()
	for (const e of entries) if (e.kind === 'result' && e.for) results.set(e.for, e)
	const orphans = entries.filter((e) => e.kind === 'result' && !e.for)

	let steps: { call: Entry; result?: Entry }[] = []
	const flush = () => {
		if (steps.length) frag.append(run(steps))
		steps = []
	}
	for (const e of entries) {
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
		pages.push(data.entries)
		const before = body.scrollHeight
		const frag = build(data.entries)
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

/** Every page fetched, oldest first, so switching mode redraws without refetching. */
let pages: Entry[][] = []

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
	pages = []
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
		for (const p of pages) body.append(build(p))
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

	const tail = document.createElement('div')
	tail.className = 'ml-auto flex shrink-0 items-center gap-2'
	tail.append(modeBtn, x)
	bar.append(title, tail)

	body = document.createElement('div')
	body.className = 'min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 font-mono text-[0.78rem] leading-[1.5]'
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
	pages = []
	if (el) {
		el.hidden = true
		el.replaceChildren()
	}
	unlockPage('transcript')
}

/** Whether the transcript is on screen, so the page does not reload underneath it. */
export const transcriptOpen = () => openId !== null

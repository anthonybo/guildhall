/**
 * The session list, in bands.
 *
 * On a phone there is no room, so this is the whole app — and a flat list sorted
 * by urgency still makes you read every row to work out where "live" stops and
 * "finished ages ago" starts. Named bands do that in one glance, and they hold
 * their order even when a session changes state, so nothing jumps under your
 * thumb mid-read.
 */
import { LOOK, projectColours, tierOf, type RGB } from '../src/theme.ts'
import { needsAttention, order } from '../src/data/select.ts'
import { mix, readable } from '../src/contrast.ts'
import type { Session } from '../src/data/types.ts'
import { ago, rgb } from './dom.ts'

/**
 * How loudly a band is painted, as the percentage of its status colour mixed
 * into a card.
 *
 * Not decoration — a ramp. The question a phone gets glanced at to answer is
 * "is anything waiting on me, and is anything still running", so the two states
 * that answer it are painted hardest and everything finished recedes toward the
 * page. Parked is almost bare: nine parked sessions must not out-shout one that
 * needs you, and by count they usually would.
 *
 * Only the card is toned down. Text keeps its own contrast — a wash behind it
 * changes nothing about how readable it is.
 */
const WEIGHT: Record<string, number> = {
	error: 0.26,
	needs: 0.22,
	working: 0.16,
	shell: 0.16,
	review: 0.11,
	done: 0.07,
	parked: 0.03,
}
/** the ramp as CSS wants it — `pct` is taken inside row() by the context figure */
const tintOf = (state: string) => `${(WEIGHT[state] ?? 0.1) * 100}%`

/** The page and card colours the wash is mixed into; they must match src.css. */
const BG: RGB = [25, 23, 34]
const PANEL: RGB = [34, 31, 46]
/** --color-faint and --color-muted, as numbers this can do arithmetic on */
const FAINT: RGB = [129, 136, 146]
const MUTED: RGB = [138, 138, 138]
/** the background a given band's card and heading actually end up with */
const cardOf = (state: string) => mix(LOOK[state].color, WEIGHT[state] ?? 0.1, PANEL)
const bandOf = (state: string) => mix(LOOK[state].color, WEIGHT[state] ?? 0.1, BG)

const BANDS: { key: string; label: string; has: (s: Session) => boolean }[] = [
	{ key: 'error', label: 'failed', has: (s) => s.state === 'error' },
	{ key: 'needs', label: 'needs you', has: (s) => s.state === 'needs' },
	{
		key: 'live',
		label: 'working',
		has: (s) => s.state === 'working' || s.state === 'shell',
	},
	{
		key: 'review',
		label: 'finished, unread',
		has: (s) => s.state === 'review',
	},
	{ key: 'done', label: 'your turn', has: (s) => s.state === 'done' },
	{ key: 'parked', label: 'parked', has: (s) => s.state === 'parked' },
]

/**
 * Which rows are open, held across repaints.
 *
 * The feed replaces the list every two seconds, so without this an expanded row
 * would slam shut mid-read — which is worse than not being able to open one.
 */
const opened = new Set<string>()

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

let listEl: HTMLElement
let emptyEl: HTMLElement
/** opens a session's live terminal; absent until the caller wires one up */
let onTerminal: ((id: string, proj: string) => void) | null = null
/** the last list painted, so a row can repaint itself when it is toggled */
let current: Session[] = []

export function mountList(list: HTMLElement, empty: HTMLElement, terminal?: (id: string, proj: string) => void) {
	listEl = list
	emptyEl = empty
	onTerminal = terminal ?? null
}

/** The rest of what is known about a session, shown when its row is opened. */
function details(s: Session) {
	const dl = document.createElement('dl')
	dl.className = '[grid-area:detail] mt-2.5 grid [grid-template-columns:max-content_1fr] gap-x-3.5 gap-y-1 border-t border-line pt-2.5 text-[0.82rem]'
	const rows: [string, string][] = [
		['title', s.title || '—'],
		['folder', s.cwd],
		['level', `${s.level} ${tierOf(s.level).name} · ${tokens(s.xp)} xp`],
		['turns', String(s.turns)],
		['context', s.ctxUsed ? `${tokens(s.ctxUsed)} of ${tokens(s.ctxLimit)}` : 'nothing yet'],
		['idle', ago(s.stale)],
		...(s.tab ? ([['tab', `⌘${s.tab}`]] as [string, string][]) : []),
		...(s.waitingFor ? ([['waiting on', s.waitingFor]] as [string, string][]) : []),
		...(s.last && s.last !== s.doing ? ([['last said', s.last]] as [string, string][]) : []),
	]
	for (const [k, v] of rows) {
		const dt = document.createElement('dt')
		dt.className = 'text-(--dim)'
		dt.textContent = k
		const dd = document.createElement('dd')
		// anywhere, not normal: a path or a sentence must wrap rather than widen the card
		dd.className = 'm-0 text-(--soft) [overflow-wrap:anywhere]'
		dd.textContent = v // never innerHTML: this is the session's own prose
		dl.append(dt, dd)
	}
	return dl
}

export function paintList(list: Session[]) {
	current = list
	const sorted = order(list)
	// the same assignment the room makes, so a name here and its carpet upstairs
	// are the same colour
	const hues = projectColours(list.map((s) => s.proj))
	emptyEl.hidden = sorted.length > 0

	const nodes: HTMLElement[] = []
	for (const band of BANDS) {
		const members = sorted.filter(band.has)
		if (!members.length) continue
		const head = document.createElement('li')
		// Sticky, so while scrolling a long parked list you never lose track of
		// which band you are in — the answer to "is anything live" must survive
		// being halfway down the page. The solid left bar and the washed background
		// are what make the section boundary legible from across a desk rather than
		// only once you are reading it.
		head.className =
			'band band-rule tint-page sticky top-12 z-[1] mt-3.5 mb-px flex items-center gap-2.5 rounded border-l-5 border-(--state) px-2.5 py-1.5 text-[0.76rem] font-bold tracking-[0.14em] text-(--ink) uppercase first:mt-0'
		// `--state` stays the raw status colour, because it paints the border, the
		// pill and the wash itself — lifting it would move the very background the
		// lift is measured against. `--ink` is the readable version, for text only.
		const key = members[0].state
		head.style.setProperty('--state', rgb(LOOK[key].color))
		head.style.setProperty('--ink', rgb(readable(LOOK[key].color, bandOf(key))))
		head.style.setProperty('--tint', tintOf(band.key))
		head.innerHTML = `<span></span><span class="rounded-full bg-(--state) px-1.5 py-px font-bold text-[#1a1c28]"></span>`
		head.children[0].textContent = band.label
		head.children[1].textContent = String(members.length)
		nodes.push(head)
		nodes.push(...members.map(row))
	}
	listEl.replaceChildren(...nodes)

	function row(s: Session) {
		const look = LOOK[s.state]
		const li = document.createElement('li')
		const busy = s.state === 'working' || s.state === 'shell'
		const attn = needsAttention(s)
		// Tinted by state at the weight its band deserves, not merely spined: a
		// spine identified the state only once you were already reading the row,
		// and the whole card carrying the colour is what makes a section readable
		// from across the room. Anything genuinely waiting on you also takes the
		// full outline rather than the softened one.
		li.className = [
			'row group grid cursor-pointer gap-x-2.5 gap-y-0.5 rounded-md border border-l-5 border-(--state) p-2.5 tint-panel',
			'[grid-template-columns:auto_1fr_auto_auto] [grid-template-areas:"lv_proj_meta_term""lv_doing_doing_term""detail_detail_detail_detail"]',
			'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--state)',
			attn ? 'attn' : 'border-state-soft',
			busy ? 'sweep' : '',
		].join(' ')
		// Anchor the sweep to the wall clock. paintList() replaces every row on each
		// feed message, and a fresh element restarts its animation — so without this
		// the bar visibly jumped back to the start every two seconds, which reads as
		// stuttering rather than as running. A negative delay equal to the current
		// phase makes a brand new element pick the animation up where the old one
		// left off.
		if (busy) li.style.setProperty('--phase', `-${Date.now() % 1600}ms`)
		// Decorative colours raw, text colours lifted against the wash they land on.
		// A fixed pair cannot serve nine differently tinted backgrounds, and the
		// project hues are chosen to be distinguishable from each other rather than
		// to clear a contrast floor on any of them.
		const card = cardOf(s.state)
		li.style.setProperty('--state', rgb(look.color))
		li.style.setProperty('--ink', rgb(readable(look.color, card)))
		li.style.setProperty('--hot', rgb(readable([255, 95, 95], card)))
		// The two greys, lifted the same way. They are the worst offenders by far —
		// the meta row measured 2.15 against a needs-you card, which is where this
		// whole exercise started. The second one aims higher than the floor on
		// purpose: lifting both to exactly 4.5 would land them on the same colour
		// and flatten the hierarchy between what a session is doing and its numbers.
		li.style.setProperty('--dim', rgb(readable(FAINT, card)))
		li.style.setProperty('--soft', rgb(readable(MUTED, card, 5.5)))
		li.style.setProperty('--tint', tintOf(s.state))
		li.style.setProperty('--tier', rgb(tierOf(s.level).color))
		// the project's own colour, the same hue as its carpet in the room
		li.style.setProperty('--proj', rgb(readable(hues.get(s.proj) ?? look.color, card)))
		const pct = s.ctxLimit ? Math.round((s.ctxUsed / s.ctxLimit) * 100) : 0
		// `proj` carries a chevron that rotates when the row opens, so it is obvious
		// there is more behind it. `doing` brightens on an attn row because that is
		// the line you are being asked to read.
		li.innerHTML = `
			<span class="[grid-area:lv] self-center min-w-[2.1rem] rounded px-1.5 py-0.5 text-center text-[0.8rem] font-bold text-[#1a1c28] bg-(--tier)">${s.level}</span>
			<span class="proj [grid-area:proj] truncate font-bold text-(--proj) after:ml-2 after:inline-block after:text-faint after:transition-transform after:duration-150 after:content-['›'] group-[.open]:after:rotate-90"></span>
			<span class="[grid-area:meta] flex items-center gap-2.5 text-[0.78rem] whitespace-nowrap text-(--dim)">
				<span class="text-(--ink)">${look.glyph} ${look.label}</span>
				${s.ctxUsed ? `<span class="tabular-nums${pct > 90 ? ' text-(--hot)' : ''}">${pct}%</span>` : ''}
				<span>${ago(s.stale)}</span>
			</span>
			<span class="doing [grid-area:doing] truncate text-[0.86rem] ${attn ? 'text-label' : 'text-(--soft)'}"></span>`
		// textContent, never innerHTML: this is a session's own prose and file names,
		// and it must never be able to become markup
		li.querySelector('.proj')!.textContent = s.proj
		li.querySelector('.doing')!.textContent = s.doing || s.last || '—'

		// The terminal button, only where there is a terminal to open. A session
		// with no cmux workspace cannot be addressed safely, so offering the button
		// would be offering something that can only fail.
		if (s.workspace) {
			const term = document.createElement('button')
			term.type = 'button'
			term.textContent = '⌨'
			term.title = `Open ${s.proj}'s terminal`
			term.className = '[grid-area:term] cursor-pointer self-center rounded border border-line bg-bg px-1.5 py-0.5 text-(--dim) hover:border-gold hover:text-gold'
			// stopPropagation: this opens a terminal, not the row's own detail
			term.addEventListener('click', (e) => {
				e.stopPropagation()
				onTerminal?.(s.id, s.proj)
			})
			li.append(term)
		}

		// a row is a button: the whole thing is the target, because a small chevron
		// is a poor thing to aim at on a phone
		li.tabIndex = 0
		li.setAttribute('role', 'button')
		const open = opened.has(s.id)
		li.setAttribute('aria-expanded', String(open))
		if (open) {
			// turns the chevron; `open` is only a hook for that one rule
			li.classList.add('open')
			li.append(details(s))
		}
		const toggle = () => {
			if (opened.has(s.id)) opened.delete(s.id)
			else opened.add(s.id)
			paintList(current)
		}
		li.addEventListener('click', toggle)
		li.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				toggle()
			}
		})
		return li
	}
}

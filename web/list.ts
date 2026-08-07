/**
 * The session list, in bands.
 *
 * On a phone there is no room, so this is the whole app — and a flat list sorted
 * by urgency still makes you read every row to work out where "live" stops and
 * "finished ages ago" starts. Named bands do that in one glance, and they hold
 * their order even when a session changes state, so nothing jumps under your
 * thumb mid-read.
 */
import { LOOK, projectColours, tierOf } from '../src/theme.ts'
import { needsAttention, order } from '../src/data/select.ts'
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
const WEIGHT: Record<string, string> = {
	error: '26%',
	needs: '22%',
	working: '16%',
	shell: '16%',
	review: '11%',
	done: '7%',
	parked: '3%',
}

const BANDS: { key: string; label: string; has: (s: Session) => boolean }[] = [
	{ key: 'error', label: 'failed', has: (s) => s.state === 'error' },
	{ key: 'needs', label: 'needs you', has: (s) => s.state === 'needs' },
	{ key: 'live', label: 'working', has: (s) => s.state === 'working' || s.state === 'shell' },
	{ key: 'review', label: 'finished, unread', has: (s) => s.state === 'review' },
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
/** the last list painted, so a row can repaint itself when it is toggled */
let current: Session[] = []

export function mountList(list: HTMLElement, empty: HTMLElement) {
	listEl = list
	emptyEl = empty
}

/** The rest of what is known about a session, shown when its row is opened. */
function details(s: Session) {
	const dl = document.createElement('dl')
	dl.className = 'detail'
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
		dt.textContent = k
		const dd = document.createElement('dd')
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
		head.className = 'band'
		head.style.setProperty('--state', rgb(LOOK[members[0].state].color))
		head.style.setProperty('--tint', WEIGHT[band.key] ?? '10%')
		head.innerHTML = `<span class="band-name"></span><span class="band-n"></span>`
		head.querySelector('.band-name')!.textContent = band.label
		head.querySelector('.band-n')!.textContent = String(members.length)
		nodes.push(head)
		nodes.push(...members.map(row))
	}
	listEl.replaceChildren(...nodes)

	function row(s: Session) {
		const look = LOOK[s.state]
		const li = document.createElement('li')
		const busy = s.state === 'working' || s.state === 'shell'
		li.className = 'row' + (needsAttention(s) ? ' attn' : '') + (busy ? ' live' : '')
		// Anchor the sweep to the wall clock. paintList() replaces every row on each
		// feed message, and a fresh element restarts its animation — so without this
		// the bar visibly jumped back to the start every two seconds, which reads as
		// stuttering rather than as running. A negative delay equal to the current
		// phase makes a brand new element pick the animation up where the old one
		// left off.
		if (busy) li.style.setProperty('--phase', `-${Date.now() % 1600}ms`)
		li.style.setProperty('--state', rgb(look.color))
		li.style.setProperty('--tint', WEIGHT[s.state] ?? '10%')
		li.style.setProperty('--tier', rgb(tierOf(s.level).color))
		// the project's own colour, the same hue as its carpet in the room
		li.style.setProperty('--proj', rgb(hues.get(s.proj) ?? look.color))
		const pct = s.ctxLimit ? Math.round((s.ctxUsed / s.ctxLimit) * 100) : 0
		li.innerHTML = `
			<span class="lv">${s.level}</span>
			<span class="proj"></span>
			<span class="meta">
				<span class="state">${look.glyph} ${look.label}</span>
				${s.ctxUsed ? `<span class="ctx${pct > 90 ? ' hot' : ''}">${pct}%</span>` : ''}
				<span>${ago(s.stale)}</span>
			</span>
			<span class="doing"></span>`
		// textContent, never innerHTML: this is a session's own prose and file names,
		// and it must never be able to become markup
		li.querySelector('.proj')!.textContent = s.proj
		li.querySelector('.doing')!.textContent = s.doing || s.last || '—'

		// a row is a button: the whole thing is the target, because a small chevron
		// is a poor thing to aim at on a phone
		li.tabIndex = 0
		li.setAttribute('role', 'button')
		const open = opened.has(s.id)
		li.setAttribute('aria-expanded', String(open))
		if (open) {
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

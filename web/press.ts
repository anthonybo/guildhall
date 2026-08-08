/**
 * The press view: what has been committed, pushed and deployed.
 *
 * The session list answers "what is being worked on". This answers "what came
 * out of it" — one timeline across every repository, newest first, which is the
 * question you actually have when you are away from the machine.
 *
 * Deploys are opt-in. The local half is git only and answers in about two
 * seconds; workflow runs and Cloudflare deploys take about seventeen, because
 * every Worker repo spawns its own wrangler. So the view opens fast on commits
 * and fetches the rest when asked, rather than making every visit wait.
 */
import { ago } from './dom.ts'

type Item =
	| { kind: 'commit'; repo: string; at: number; short: string; subject: string; author: string; files: number; insertions: number; deletions: number }
	| { kind: 'push'; repo: string; at: number; short: string; remote: string; branch: string; count: number | null; forced: boolean }
	| { kind: 'run'; repo: string; at: number; short: string; workflow: string; branch: string; status: string; conclusion: string | null; url: string; durationMs: number | null }
	| { kind: 'deploy'; repo: string; at: number; worker: string; hostname: string | null; env: string | null; source: string }

type Snapshot = { at: number; items: Item[]; repos: number; local: boolean; githubError?: string; cloudflareError?: string; error?: string }

let el: HTMLElement
let timer = 0
let open = false
let deploys = false
/** Set when the panel has just been opened and the next render should scroll to it. */
let scrollOnRender = false

/** Each kind gets a mark and a colour, so the timeline is scannable without reading. */
const MARK: Record<Item['kind'], { glyph: string; tone: string }> = {
	commit: { glyph: '●', tone: 'text-(--work)' },
	push: { glyph: '↑', tone: 'text-gold' },
	run: { glyph: '⚙', tone: 'text-muted' },
	deploy: { glyph: '▲', tone: 'text-(--work)' },
}

/** The one-line description of a thing that happened. */
function describe(i: Item): string {
	if (i.kind === 'commit') return i.subject
	if (i.kind === 'push') return `pushed ${i.branch} to ${i.remote}${i.forced ? ' — forced' : ''}${i.count ? ` · ${i.count} commit${i.count === 1 ? '' : 's'}` : ''}`
	if (i.kind === 'run') return `${i.workflow} · ${i.conclusion ?? i.status}`
	return `deployed ${i.hostname ?? i.worker}${i.env ? ` (${i.env})` : ''} · via ${i.source}`
}

/** A failed workflow run is the one row here that should draw the eye. */
const failed = (i: Item) => i.kind === 'run' && (i.conclusion === 'failure' || i.conclusion === 'timed_out')

function row(i: Item) {
	const li = document.createElement('li')
	// Four columns on a desktop, one row. On a phone the subject drops to a second
	// row under the repo, and every cell is placed explicitly — an earlier
	// `col-span-full` on the subject swallowed the time column and left the
	// timestamp wrapped onto a third line, hard against the left edge.
	li.className = `grid grid-cols-[1.2rem_minmax(5rem,8rem)_1fr_auto] items-baseline gap-x-2.5 gap-y-0.5 border-b border-line/60 px-3.5 py-2 max-[560px]:grid-cols-[1.2rem_1fr_auto]`
	const mark = MARK[i.kind]
	li.innerHTML = `
		<span class="${mark.tone} text-center text-[0.8rem] max-[560px]:col-start-1 max-[560px]:row-start-1" title="${i.kind}">${mark.glyph}</span>
		<span class="repo truncate font-bold text-[0.82rem] text-label max-[560px]:col-start-2 max-[560px]:row-start-1"></span>
		<span class="what truncate text-[0.84rem] ${failed(i) ? 'text-hot' : 'text-muted'} max-[560px]:col-start-2 max-[560px]:col-end-4 max-[560px]:row-start-2"></span>
		<span class="text-[0.74rem] whitespace-nowrap text-faint tabular-nums max-[560px]:col-start-3 max-[560px]:row-start-1">${ago(Date.now() - i.at)}</span>`
	// textContent, never innerHTML: commit subjects and branch names are somebody's
	// prose and must never become markup
	li.querySelector('.repo')!.textContent = i.repo
	li.querySelector('.what')!.textContent = describe(i)
	return li
}

function render(snap: Snapshot) {
	const wrap = document.createElement('div')

	const bar = document.createElement('div')
	bar.className = 'flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2'
	const title = document.createElement('span')
	title.className = 'font-bold text-label'
	title.textContent = 'Commits & deploys'
	const meta = document.createElement('span')
	meta.className = 'text-[0.74rem] text-faint'
	meta.textContent = snap.error ? '' : `${snap.repos} repositories · read ${ago(Date.now() - snap.at)}`

	// A toggle rather than a default, because the honest cost is ~17s against ~2s.
	const toggle = document.createElement('button')
	toggle.type = 'button'
	toggle.textContent = deploys ? 'Deploys on' : 'Include deploys'
	toggle.title = deploys ? 'Also reading GitHub Actions and Cloudflare — slower' : 'Also read workflow runs and Cloudflare deploys (takes ~17s the first time)'
	toggle.className = `ml-auto flex min-h-9 cursor-pointer items-center rounded border px-3 text-[0.74rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${deploys ? 'border-gold text-gold' : 'border-line text-muted hover:text-label'}`
	toggle.addEventListener('click', () => {
		deploys = !deploys
		refresh()
	})
	bar.append(title, meta, toggle)
	wrap.append(bar)

	if (snap.error) {
		const p = document.createElement('p')
		p.className = 'm-0 px-3.5 py-6 text-center text-[0.84rem] text-muted'
		p.textContent = snap.error
		wrap.append(p)
	} else if (!snap.items.length) {
		const p = document.createElement('p')
		p.className = 'm-0 px-3.5 py-6 text-center text-faint'
		p.textContent = deploys ? 'Reading — deploys take about 17 seconds.' : 'Nothing yet.'
		wrap.append(p)
	} else {
		// Says plainly that the network half was never asked for, so an empty deploy
		// list is not mistaken for "nothing has been deployed".
		if (snap.local) {
			const note = document.createElement('p')
			note.className = 'm-0 border-b border-line/60 px-3.5 py-1.5 text-[0.72rem] text-faint'
			note.textContent = 'Commits and pushes only — deploys were not read.'
			wrap.append(note)
		}
		for (const err of [snap.githubError, snap.cloudflareError]) {
			if (!err) continue
			const p = document.createElement('p')
			p.className = 'm-0 border-b border-line/60 px-3.5 py-1.5 text-[0.72rem] text-hot'
			p.textContent = err
			wrap.append(p)
		}
		const ul = document.createElement('ul')
		ul.className = 'm-0 list-none p-0'
		for (const i of snap.items) ul.append(row(i))
		wrap.append(ul)
	}

	el.replaceChildren(wrap)

	if (scrollOnRender) {
		scrollOnRender = false
		// the margin keeps the panel's own header clear of the page header, which is sticky
		el.style.scrollMarginTop = `${(document.getElementById('bar')?.getBoundingClientRect().height ?? 0) + 8}px`
		// Instant, not smooth. A smooth scroll animates over several hundred
		// milliseconds, and the room re-plans and resizes its canvas on every feed
		// tick — which cancels the animation mid-flight and leaves the page where it
		// started. Measured: the panel stayed at 719px until this became instant.
		requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }))
	}
}

async function refresh() {
	if (!open) return
	try {
		const res = await fetch(`/api/press${deploys ? '?deploys=1' : ''}`)
		if (!res.ok) return render({ at: Date.now(), items: [], repos: 0, local: true, error: `the server said ${res.status}` })
		render(await res.json())
	} catch {
		render({ at: Date.now(), items: [], repos: 0, local: true, error: 'could not reach guildhall' })
	}
}

export function show() {
	open = true
	el.hidden = false
	el.textContent = 'Reading…'
	// This panel sits below the room, which on a desktop fills the window — so
	// opening it without scrolling there reads as a button that does nothing.
	//
	// Deferred to the first render rather than done here: at this moment the panel
	// is one line of "Reading…", so scrolling now aims at a box that is about to
	// grow by a thousand pixels, and the room re-planning its layout underneath
	// moves the target again. Scrolling once there is something to scroll to is
	// the only version that lands.
	scrollOnRender = true
	refresh()
	clearInterval(timer)
	// Slower than the session poll: commits do not land twice a second, and each
	// read spawns a git process per repository.
	timer = setInterval(refresh, 30_000)
}

export function close() {
	open = false
	clearInterval(timer)
	timer = 0
	el.hidden = true
	el.replaceChildren()
}

export const isOpen = () => open

export function mountPress(host: HTMLElement) {
	el = host
}

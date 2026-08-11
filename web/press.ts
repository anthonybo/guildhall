/**
 * The press view: what has been committed, pushed and deployed.
 *
 * A deliberate copy of pressroom's terminal layout rather than a web list, because
 * that layout is the answer to this question and it took a lot of iterating there
 * to arrive at. Two parts, in this order:
 *
 *  - the REPO PANEL, one dense line per repository: branch, how far ahead of the
 *    upstream, how many files are dirty, whether the pipeline passed, whether it
 *    is live. `↑3` is the line that earns its place — every project here deploys
 *    by pushing, so three commits ahead is three commits that exist on this
 *    laptop and nowhere else, which is the single most useful thing a glance can
 *    tell you. The first version of this view omitted it entirely.
 *  - the FEED, one line per event, column-aligned down the screen so you scan a
 *    column rather than read paragraphs.
 *
 * It opens over the page rather than in it: full screen on a phone, a drawer down
 * the right on a desktop. Inline, it was a thing you scrolled past on the way to
 * something else; the question it answers deserves the whole screen while you are
 * asking it.
 *
 * Called "pressroom" on screen, not a new word. It is the same tool already run in
 * a terminal here, and a second name for one thing is only friction.
 */
import { ago } from './dom.ts'

type Item =
	| { kind: 'commit'; repo: string; at: number; short: string; subject: string; author: string; files: number; insertions: number; deletions: number }
	| { kind: 'push'; repo: string; at: number; short: string; remote: string; branch: string; count: number | null; forced: boolean }
	| { kind: 'run'; repo: string; at: number; short: string; workflow: string; branch: string; status: string; conclusion: string | null; url: string; durationMs: number | null }
	| { kind: 'deploy'; repo: string; at: number; worker: string; hostname: string | null; env: string | null; source: string }

type Repo = {
	label: string
	branch?: string
	upstream?: string | null
	ahead: number
	behind: number
	changed: number
	untracked: number
	unborn?: boolean
	ci?: { conclusion: string | null; status: string; workflow: string; url: string }
	live?: { hostname: string | null; worker: string; rollback: boolean; at: number }
	lastCommitAt?: number
	error?: string
}

type Snapshot = { at: number; items: Item[]; repos: Repo[]; local: boolean; githubError?: string; cloudflareError?: string; error?: string; stale?: string }

let el: HTMLElement
let timer = 0
let open = false
let deploys = false
let onClose = () => {}

/**
 * A colour per repository, hashed from the name.
 *
 * Same idea as the room's project colours: the point is that a repo is the same
 * colour every time you look, so you learn to find it by hue before reading it.
 * Hue only — saturation and lightness are fixed where every value stays legible
 * on the panel background.
 */
function hue(name: string) {
	let h = 0
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
	return `oklch(0.82 0.13 ${h})`
}

/**
 * How a workflow run reads at a glance.
 *
 * The glyph carries the state on its own, so the row still says what happened
 * without the colour — which matters here for the same reason it does in the
 * terminal: red is the entire point of a failed deploy, and a colourblind reader
 * or a screenshot in a different theme loses it.
 */
function ciLook(ci: NonNullable<Repo['ci']>) {
	if (ci.status !== 'completed') return { glyph: '◔', tone: 'text-gold', say: `${ci.workflow} ${ci.status}` }
	switch (ci.conclusion) {
		case 'success':
			return { glyph: '✔', tone: 'text-(--work)', say: `${ci.workflow} passed` }
		case 'failure':
		case 'timed_out':
			return { glyph: '✖', tone: 'text-hot', say: `${ci.workflow} ${ci.conclusion === 'failure' ? 'failed' : 'timed out'}` }
		case 'cancelled':
		case 'skipped':
			return { glyph: '⊘', tone: 'text-faint', say: `${ci.workflow} ${ci.conclusion}` }
		default:
			return { glyph: '·', tone: 'text-faint', say: `${ci.workflow} ${ci.conclusion ?? ci.status}` }
	}
}

const MARK: Record<Item['kind'], { glyph: string; tone: string }> = {
	commit: { glyph: '●', tone: 'text-(--work)' },
	push: { glyph: '⇧', tone: 'text-gold' },
	run: { glyph: '⚙', tone: 'text-muted' },
	deploy: { glyph: '☁', tone: 'text-(--work)' },
}

function describe(i: Item): string {
	if (i.kind === 'commit') return i.subject
	if (i.kind === 'push') return `pushed ${i.branch} → ${i.remote}${i.forced ? '  ·  forced' : ''}${i.count ? `  ·  ${i.count} commit${i.count === 1 ? '' : 's'}` : ''}`
	if (i.kind === 'run') return `${i.workflow}  ·  ${i.conclusion ?? i.status}`
	return `deployed ${i.hostname ?? i.worker}${i.env ? `  ·  ${i.env}` : ''}  ·  via ${i.source}`
}

const failed = (i: Item) => i.kind === 'run' && (i.conclusion === 'failure' || i.conclusion === 'timed_out')

/** One repository. Everything is a fixed-width cell so the columns line up. */
function repoRow(r: Repo) {
	const li = document.createElement('li')
	li.className = 'flex items-baseline gap-2 px-2 py-[0.15rem] whitespace-nowrap hover:bg-line/40'
	const tint = hue(r.label)

	const bar = document.createElement('span')
	bar.textContent = '│'
	bar.style.color = tint

	const name = document.createElement('span')
	name.className = 'w-[9rem] shrink-0 truncate font-bold max-[560px]:w-[6.5rem]'
	name.style.color = tint
	name.textContent = r.label

	if (r.error) {
		const err = document.createElement('span')
		err.className = 'truncate text-hot'
		err.textContent = r.error
		li.append(bar, name, err)
		return li
	}

	const branch = document.createElement('span')
	branch.className = 'w-[7rem] shrink-0 truncate text-faint max-[720px]:hidden'
	branch.textContent = r.branch ?? ''

	// `↑3` in gold: three commits of work that exist on this laptop and nowhere
	// else. Space-separated from `↓`, because `↑3↓1` reads as one cryptic token.
	const sync = document.createElement('span')
	sync.className = `w-[4.5rem] shrink-0 tabular-nums ${r.ahead ? 'font-bold text-gold' : 'text-faint'}`
	sync.textContent = [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ')
	if (r.ahead) sync.title = `${r.ahead} commit${r.ahead === 1 ? '' : 's'} not pushed anywhere`

	const work = document.createElement('span')
	work.className = `w-[4.5rem] shrink-0 tabular-nums ${r.changed ? 'text-gold' : 'text-faint'}`
	work.textContent = [r.changed ? `●${r.changed}` : '', r.untracked ? `?${r.untracked}` : ''].filter(Boolean).join(' ')
	if (r.changed || r.untracked) work.title = `${r.changed} changed, ${r.untracked} untracked`

	// Two glyphs, two facts: did the pipeline pass, and is it live. One column
	// cannot carry both — a repo can be green-and-live, red-and-live because the
	// failure came after, or live with no pipeline at all.
	const ci = document.createElement('span')
	ci.className = 'w-4 shrink-0 text-center'
	if (r.ci) {
		const look = ciLook(r.ci)
		ci.textContent = look.glyph
		ci.className += ` ${look.tone}`
		ci.title = look.say
	}

	const live = document.createElement('span')
	live.className = 'w-4 shrink-0 text-center'
	if (r.live) {
		live.textContent = r.live.rollback ? '↺' : '☁'
		live.className += r.live.rollback ? ' text-gold' : ' text-(--work)'
		live.title = `${r.live.rollback ? 'rolled back' : 'live'}: ${r.live.hostname ?? r.live.worker}`
	}

	const when = document.createElement('span')
	when.className = 'ml-auto shrink-0 tabular-nums text-faint'
	when.textContent = r.lastCommitAt ? ago(Date.now() - r.lastCommitAt) : ''

	li.append(bar, name, branch, sync, work, ci, live, when)
	// Said out loud rather than left as an empty sync column, because "nothing to
	// push" and "nowhere to push to" look identical otherwise.
	if (!r.upstream && !r.unborn) {
		const note = document.createElement('span')
		note.className = 'shrink-0 pl-2 text-faint max-[560px]:hidden'
		note.textContent = 'no upstream'
		li.append(note)
	}
	return li
}

/** One event. Same column order as the terminal: mark, age, repo, sha, subject. */
function feedRow(i: Item) {
	const li = document.createElement('li')
	li.className = 'flex items-baseline gap-2 px-2 py-[0.15rem] whitespace-nowrap hover:bg-line/40'
	const mark = MARK[i.kind]
	const tint = hue(i.repo)

	const glyph = document.createElement('span')
	glyph.className = `w-3 shrink-0 text-center ${mark.tone}`
	glyph.textContent = mark.glyph
	glyph.title = i.kind

	const when = document.createElement('span')
	when.className = 'w-[2.6rem] shrink-0 text-right tabular-nums text-faint'
	when.textContent = ago(Date.now() - i.at)

	const bar = document.createElement('span')
	bar.textContent = '│'
	bar.style.color = tint

	const repo = document.createElement('span')
	repo.className = 'w-[9rem] shrink-0 truncate max-[560px]:w-[6.5rem]'
	repo.style.color = tint
	repo.textContent = i.repo

	const sha = document.createElement('span')
	sha.className = 'w-[4.5rem] shrink-0 tabular-nums text-faint max-[720px]:hidden'
	sha.textContent = i.kind === 'deploy' ? '' : i.short

	const what = document.createElement('span')
	what.className = `truncate ${failed(i) ? 'text-hot' : i.kind === 'commit' ? 'text-label' : 'text-muted'}`
	what.textContent = describe(i)

	li.append(glyph, when, bar, repo, sha, what)
	return li
}

/** A section heading, in the terminal's own style: a word and a rule to the edge. */
function heading(text: string, count?: number) {
	const h = document.createElement('div')
	h.className = 'sticky top-0 z-[1] flex items-center gap-2 bg-panel px-2 py-1 text-[0.72rem] tracking-[0.14em] text-gold uppercase'
	const label = document.createElement('span')
	label.textContent = count === undefined ? text : `${text} ${count}`
	const rule = document.createElement('span')
	rule.className = 'h-px flex-1 bg-line'
	h.append(label, rule)
	return h
}

function render(snap: Snapshot) {
	const wrap = document.createElement('div')
	wrap.className = 'flex h-full min-h-0 flex-col'

	/* ── title bar ── */
	const bar = document.createElement('div')
	bar.className = 'flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2'
	const title = document.createElement('span')
	title.className = 'font-bold tracking-[0.06em] text-gold'
	title.textContent = 'PRESSROOM'
	const meta = document.createElement('span')
	meta.className = 'truncate text-[0.72rem] text-faint'
	meta.textContent = snap.error ? '' : `${snap.repos.length} repos · ${ago(Date.now() - snap.at)}`

	const toggle = document.createElement('button')
	toggle.type = 'button'
	toggle.textContent = deploys ? 'deploys on' : '+ deploys'
	toggle.title = deploys ? 'Reading GitHub Actions and Cloudflare too' : 'Also read workflow runs and Cloudflare deploys (~17s the first time)'
	toggle.className = `ml-auto flex min-h-9 shrink-0 cursor-pointer items-center rounded border px-2.5 text-[0.72rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${deploys ? 'border-gold text-gold' : 'border-line text-muted hover:text-label'}`
	toggle.addEventListener('click', () => {
		deploys = !deploys
		refresh()
	})

	const x = document.createElement('button')
	x.type = 'button'
	x.textContent = '✕ Close'
	x.title = 'Close (Esc)'
	x.className =
		'flex min-h-9 shrink-0 cursor-pointer items-center rounded border border-hot bg-transparent px-2.5 text-[0.72rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot'
	x.addEventListener('click', close)
	bar.append(title, meta, toggle, x)
	wrap.append(bar)

	/* ── body ── */
	const body = document.createElement('div')
	body.className = 'min-h-0 flex-1 overflow-auto overscroll-contain text-[0.78rem]/[1.5]'

	if (snap.error) {
		const p = document.createElement('p')
		p.className = 'm-0 px-2.5 py-8 text-center text-muted'
		p.textContent = snap.error
		body.append(p)
	} else if (!snap.repos.length && !snap.items.length) {
		const p = document.createElement('p')
		p.className = 'm-0 px-2.5 py-8 text-center text-faint'
		p.textContent = deploys ? 'Reading — deploys take about 17 seconds.' : 'Reading…'
		body.append(p)
	} else {
		if (snap.stale) {
			const note = document.createElement('p')
			note.className = 'm-0 border-b border-gold/40 bg-gold/10 px-2.5 py-1.5 text-[0.72rem] text-gold'
			note.textContent = snap.stale
			body.append(note)
		}
		// Repos with something to report first. A panel of thirty rows saying nothing
		// buries the two that matter, so the quiet ones collapse behind a count.
		const busy = snap.repos.filter((r) => r.ahead || r.changed || r.untracked || r.error)
		const quiet = snap.repos.filter((r) => !(r.ahead || r.changed || r.untracked || r.error))

		body.append(heading('unpushed & dirty', busy.length))
		if (busy.length) {
			const ul = document.createElement('ul')
			ul.className = 'm-0 list-none p-0'
			for (const r of busy) ul.append(repoRow(r))
			body.append(ul)
		} else {
			const p = document.createElement('p')
			p.className = 'm-0 px-2.5 py-2 text-faint'
			p.textContent = 'Everything is pushed and clean.'
			body.append(p)
		}

		if (quiet.length) {
			const details = document.createElement('details')
			const sum = document.createElement('summary')
			sum.className = 'cursor-pointer px-2 py-1 text-[0.72rem] text-faint hover:text-label'
			sum.textContent = `${quiet.length} clean ${quiet.length === 1 ? 'repo' : 'repos'}`
			const ul = document.createElement('ul')
			ul.className = 'm-0 list-none p-0'
			for (const r of quiet) ul.append(repoRow(r))
			details.append(sum, ul)
			body.append(details)
		}

		body.append(heading('feed', snap.items.length))
		if (snap.local) {
			const note = document.createElement('p')
			note.className = 'm-0 px-2.5 py-1 text-[0.72rem] text-faint'
			note.textContent = 'Commits and pushes only — deploys were not read.'
			body.append(note)
		}
		for (const err of [snap.githubError, snap.cloudflareError]) {
			if (!err) continue
			const p = document.createElement('p')
			p.className = 'm-0 px-2.5 py-1 text-[0.72rem] text-hot'
			p.textContent = err
			body.append(p)
		}
		const feed = document.createElement('ul')
		feed.className = 'm-0 list-none p-0'
		for (const i of snap.items) feed.append(feedRow(i))
		body.append(feed)
	}

	wrap.append(body)
	el.replaceChildren(wrap)
}

/**
 * Make whatever the server sent safe to draw.
 *
 * The browser client and the server update on different clocks: `web/` is read
 * from disk, so a rebuild reaches a page on its next reload, while the routes are
 * compiled into a process that only changes when it restarts. A newer page talking
 * to an older server is therefore the NORMAL state for a while, not an edge case,
 * and it must degrade rather than break.
 *
 * It broke: an older server returns `repos` as a count instead of a list, the view
 * called `.filter` on the number 32, and the resulting TypeError surfaced as
 * "could not reach guildhall". The panel simply stays empty until the server
 * catches up, and the feed — which both versions agree about — still draws.
 */
function normalise(snap: any): Snapshot {
	return {
		at: typeof snap?.at === 'number' ? snap.at : Date.now(),
		items: Array.isArray(snap?.items) ? snap.items : [],
		repos: Array.isArray(snap?.repos) ? snap.repos : [],
		local: !!snap?.local,
		githubError: snap?.githubError ?? undefined,
		cloudflareError: snap?.cloudflareError ?? undefined,
		error: snap?.error ?? undefined,
		// A note, deliberately not an error: the feed is the same in both versions and
		// is worth drawing. Saying "the server is older" and then showing nothing
		// would throw away the half that works.
		stale: Array.isArray(snap?.repos) ? undefined : 'The machine is running an older guildhall — restart it for the repo panel. The feed below is current.',
	}
}

async function refresh() {
	if (!open) return
	// Fetch and draw are separate, and the catch covers ONLY the fetch.
	//
	// They used to share one try, so a bug inside render() was reported as "could
	// not reach guildhall" — which is what happened: the server was returning an
	// older shape, render() threw on it, and the page blamed the network. A wrong
	// error is worse than no error, because it sends you looking at the wrong thing.
	let snap: Snapshot
	try {
		const res = await fetch(`/api/press${deploys ? '?deploys=1' : ''}`)
		if (!res.ok) return render({ at: Date.now(), items: [], repos: [], local: true, error: `the server said ${res.status}` })
		snap = await res.json()
	} catch {
		return render({ at: Date.now(), items: [], repos: [], local: true, error: 'could not reach guildhall' })
	}
	render(normalise(snap))
}

export function show() {
	open = true
	el.hidden = false
	// The page must not scroll behind a full-screen overlay: on a phone, dragging
	// the feed would otherwise pull the list underneath it around as well.
	document.body.classList.add('overflow-hidden')
	el.textContent = ''
	refresh()
	clearInterval(timer)
	// Slower than the session poll: commits do not land twice a second, and every
	// read spawns a git process per repository.
	timer = setInterval(refresh, 30_000)
}

export function close() {
	open = false
	clearInterval(timer)
	timer = 0
	el.hidden = true
	el.replaceChildren()
	document.body.classList.remove('overflow-hidden')
	onClose()
}

export const isOpen = () => open

export function mountPress(host: HTMLElement, closed: () => void) {
	el = host
	onClose = closed
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && open) close()
	})
}

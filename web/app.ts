/**
 * The browser client: the shell around the room and the list.
 *
 * This file owns the header, the feed, and how honest the page is about the age
 * of what it shows. The office lives in room.ts and the session list in list.ts,
 * both of which run the same code the terminal does — the simulation has no node
 * dependencies, so neither is a reimplementation that can drift.
 *
 * It is read-only. Nothing here can start, stop or change a session.
 */
import { LOOK } from '../src/theme.ts'
import type { Session } from '../src/data/types.ts'
import { $, ago, rgb } from './dom.ts'
import { mountList, paintList } from './list.ts'
import { mountRoom, relayout, setRoomSessions } from './room.ts'
import { busy as terminalBusy, mountTerminal, show as showTerminal } from './terminal.ts'
import { transcriptOpen } from './transcript.ts'
import { mountSettings, settings } from './settings.ts'
import { close as closePress, isOpen as pressOpen, mountPress, show as showPress } from './press.ts'
import { isOpen as newOpen, mountNewSession, show as showNewSession } from './newsession.ts'

const bar = { counts: $<HTMLElement>('#counts'), link: $<HTMLElement>('#link'), ver: $<HTMLElement>('#ver') }
const roomEl = $<HTMLElement>('#room')
const stampEl = $<HTMLElement>('#stamp')
const offlineEl = $<HTMLElement>('#offline')

let sessions: Session[] = []
/** local clock when the newest feed arrived, so its age can be shown honestly */
let seenAt = 0
/** whether the stream is currently delivering */
let live = false

/* ── the header ── */

/**
 * The connection state: a coloured dot and a word.
 *
 * A real element rather than a `::before` on a class. The dot needs its own
 * colour and its own size at the width where the word is dropped, and two
 * utilities on a span say that more plainly than a pseudo-element driven by a
 * class the JS has to remember to set.
 */
function setLink(state: 'live' | 'offline') {
	const dot = document.createElement('span')
	dot.className = `text-[0.9rem]/none ${state === 'live' ? 'text-ok' : 'text-hot'}`
	dot.textContent = state === 'live' ? '●' : '○'
	const word = document.createElement('span')
	// the word goes on a phone; the dot is the reading and it stays
	word.className = 'max-[560px]:hidden'
	word.textContent = state
	bar.link.replaceChildren(dot, word)
}

function paintCounts(list: Session[]) {
	const counts: Record<string, number> = {}
	for (const s of list) counts[s.state] = (counts[s.state] ?? 0) + 1
	bar.counts.replaceChildren(
		...(['error', 'needs', 'working', 'shell', 'review', 'done', 'parked'] as const)
			.filter((k) => counts[k])
			.map((k) => {
				const el = document.createElement('span')
				el.style.color = rgb(LOOK[k].color)
				// a count is one unbreakable phrase: "1 working" splitting across lines
				// turned the header into three rows of half-sentences on a phone
				el.className = 'whitespace-nowrap'
				el.textContent = `${LOOK[k].glyph} `
				const n = document.createElement('span')
				n.className = 'text-label'
				n.textContent = String(counts[k])
				/**
				 * The word drops below 560px, and the earlier note here argued it should
				 * never do that: "a bare ▲ or ◆ is unreadable to anyone who has not
				 * memorised a legend". The objection is right about a bare glyph and
				 * wrong about this one, on three counts.
				 *
				 * It is never bare — it always carries its number, which is what makes
				 * it read as a quantity of something rather than as an ornament. It is
				 * the same glyph and the same colour the terminal uses for that state,
				 * so it is the product's own vocabulary rather than an invented legend.
				 * And the words are one thumb-length below: the list bands spell out
				 * "needs you", "working", "your turn" in full, against the same colours.
				 *
				 * What the words cost was the whole header. Spelled out they measured
				 * 338px against 338px of usable width on a 366px phone, which is what
				 * pushed the bar to three rows and 102px — a third of the list, spent on
				 * a summary of the list.
				 *
				 * `aria-label` on the row keeps the full phrase for a screen reader at
				 * every width, so nothing is hidden from anyone who cannot see colour.
				 */
				const word = document.createElement('span')
				word.className = 'text-label hidden min-[560px]:inline'
				word.textContent = ` ${LOOK[k].label}`
				// the same phrase, for a pointer that hovers the glyph
				el.title = `${counts[k]} ${LOOK[k].label}`
				el.setAttribute('aria-label', `${counts[k]} ${LOOK[k].label}`)
				el.append(n, word)
				return el
			}),
	)
}

/**
 * The client fingerprint this page was loaded with, if the server has told us.
 *
 * Held rather than compared to a constant, because the page cannot know its own
 * build — it learns it from the first message and then watches for it to change.
 */
let clientStamp: string | null = null

function apply(data: { sessions: Session[]; at: number; version?: string; update?: string | null; client?: string }) {
	// Reload when the browser client on disk has been rebuilt.
	//
	// `web/` is served from disk with no-store, so a rebuild is live immediately —
	// but only for a browser that asks again, and a tab left open on a phone never
	// does. Without this, seeing a change meant walking to the machine, or at least
	// remembering to pull-to-refresh. Held back only while there is something a
	// reload would destroy: a message part-way through being typed, a send still in
	// the air, or the press panel's scroll position. The control token is NOT one of
	// those — it lives in sessionStorage and survives a reload, which is what the
	// old guard got wrong when it held every update back for the whole time the
	// terminal was open. That turned a terminal you could not close into one that
	// also blocked the build which fixed closing it.
	if (data.client) {
		if (clientStamp === null) clientStamp = data.client
		// The transcript is on this list for the same reason as the others: reloading
		// while somebody is reading back through a conversation throws away every page
		// they scrolled up to fetch, and drops them at the newest end again.
		else if (data.client !== clientStamp && !terminalBusy() && !pressOpen() && !newOpen() && !transcriptOpen()) return void location.reload()
	}
	sessions = data.sessions
	setRoomSessions(sessions)
	// same treatment as the terminal: grey when current, and an arrow in the
	// working colour when something newer exists
	if (data.version) {
		// "0.2.24 · 97a7f58" — the commit is its own element so a phone can drop it.
		// Nobody identifies a build by its hash from a phone, and on that width it
		// was the difference between a header that fits and one that does not.
		const [num, commit] = data.version.split(' · ')
		const build = document.createElement('span')
		build.className = 'build'
		build.textContent = commit ? ` · ${commit}` : ''
		bar.ver.replaceChildren((data.update ? '⇡ v' : 'v') + num, build)
		bar.ver.classList.toggle('newer', !!data.update)
		bar.ver.title = data.update ? `v${data.update} is available` : ''
	}
	// A session started from the phone: open it as soon as it exists, so the idea
	// can go straight in. Newest row in that directory, since a project may already
	// have had one.
	if (awaitingDir) {
		// A row with no workspace has no terminal to show: `/api/screen` answers "no
		// such session, or it is not in a cmux tab" and the panel opens blank on an
		// error. Wait for one that can actually be opened — that is what the timeout
		// below is for.
		const fresh = sessions.filter((s) => s.cwd === awaitingDir && s.workspace).sort((a, b) => a.stale - b.stale)[0]
		if (fresh) {
			awaitingDir = null
			showTerminal(fresh.id, fresh.name)
		} else if (Date.now() - awaitingSince > SPAWN_WAIT) {
			const where = awaitingDir
			awaitingDir = null
			offlineEl.hidden = false
			offlineEl.textContent = `The session in ${where} has not come up. Some projects open a trust prompt on first run, and that has to be answered at the machine.`
		}
	}
	showRoom()
	paintCounts(sessions)
	paintList(sessions)
	seenAt = Date.now()
	freshness()
}

/**
 * How old what you are looking at is.
 *
 * The page used to stamp a clock time and leave it, so a laptop that slept when
 * its work finished left a phone showing a full set of numbers with no hint they
 * were hours stale — which is the one thing a status dashboard must never do.
 * This runs on its own timer, not on the feed, precisely because the case that
 * matters is the feed having stopped.
 */
function freshness() {
	if (!seenAt) return
	const age = Date.now() - seenAt
	const n = sessions.length
	// One phrase for both places. They had separate thresholds and disagreed with
	// each other at 40 seconds — the footer said "just now" while the banner above
	// it said "1m ago", which undermines the one thing this is for.
	const when = age < 60_000 ? 'moments ago' : `${ago(age)} ago`
	stampEl.textContent = `${n} session${n === 1 ? '' : 's'} · updated ${when}`
	// A few seconds of gap is a reconnect, not an outage, and saying so would cry
	// wolf every time a phone wakes up. Past that it is worth naming.
	const stale = !live && age > 20_000
	document.body.classList.toggle('stale', stale)
	offlineEl.hidden = !stale
	if (stale) offlineEl.textContent = `Not receiving updates — the machine is asleep or unreachable. This is how it looked ${when}.`
}

/* ── the feed ── */

/**
 * The feed, and getting it back by itself.
 *
 * EventSource reconnects on its own, but only against the same dead socket and
 * with no way to tell an expired session from an unreachable machine. So the
 * retry is driven from here instead.
 */
function connect() {
	let es: EventSource | null = null
	let delay = 1000
	// see the note on `timer` in press.ts: a handle, not an integer
	let timer: ReturnType<typeof setTimeout> | undefined

	const retry = () => {
		clearTimeout(timer)
		timer = setTimeout(probe, delay)
		delay = Math.min(delay * 2, 30_000)
	}

	/**
	 * Why the feed stopped, before deciding what to do about it.
	 *
	 * Reloading after a few failures used to be the whole strategy, and it is
	 * right for exactly one cause — an expired session, where the server is up and
	 * the reload lets it serve the passcode screen. For the common cause, a laptop
	 * that went to sleep when its work finished, it was actively harmful: it threw
	 * away a page showing real if elderly numbers and replaced it with the
	 * browser's cannot-connect error. So ask first, and only reload when something
	 * answered.
	 */
	const probe = async () => {
		try {
			const r = await fetch('/api/sessions', { cache: 'no-store' })
			if (r.status === 401) return location.reload() // up, but we are logged out
			// ANY other reply means something answered, so the machine is awake — which
			// is the only thing this needs to establish. Requiring r.ok meant a 404
			// from a renamed endpoint or a 502 from a proxy read as "still asleep" and
			// the page never recovered, however healthy the server was. If the stream
			// is genuinely broken, open() fails and we are back here with the backoff.
			return open()
		} catch {
			// unreachable: asleep, off the network, or moved. Keep what we have.
		}
		retry()
	}

	function open() {
		es?.close()
		delay = 1000
		es = new EventSource('/api/stream')
		es.onopen = () => {
			live = true
			setLink('live')
			freshness()
		}
		es.onmessage = (e) => {
			live = true
			apply(JSON.parse(e.data))
		}
		es.onerror = () => {
			live = false
			setLink('offline')
			es?.close()
			es = null
			freshness()
			retry()
		}
	}
	open()
	return { probe: () => ((delay = 1000), probe()) }
}

/**
 * Whether the office is on screen — and with it the animation, since the frame
 * loop returns early while it is hidden. The width rule is not a preference and
 * still wins: at 100 columns on a phone the room is illegible whatever the
 * setting says.
 */
function showRoom() {
	roomEl.hidden = window.innerWidth <= 720 || !settings.room || sessions.length === 0
}

/* ── wiring ── */

mountTerminal($<HTMLElement>('#terminal'), () => {})
// One button in the header opens it, and the panel itself owns closing — it is a
// full screen on a phone and a drawer on a desktop, so the way out has to be
// inside it rather than back up in a header you may have scrolled past.
/**
 * A session started from the phone, waiting for its row to appear.
 *
 * The spawn returns as soon as cmux has made the tab, but guildhall only learns
 * about the session on the next feed tick — so the terminal cannot be opened
 * immediately. This remembers which directory was asked for and opens the
 * terminal the moment a row shows up in it, which is what makes the flow "tap a
 * project, type the idea" rather than "tap, wait, hunt for the new row".
 */
let awaitingDir: string | null = null
let awaitingSince = 0

/**
 * How long to wait for a started session to appear before saying something.
 *
 * `claude` takes 25-30 seconds to draw its first screen, and the row only exists
 * once it has registered — so anything shorter reports a failure that has not
 * happened yet. 75 seconds is comfortably past that on a slow start, and a
 * session that has not appeared by then is not coming: the usual reason is a
 * trust prompt, which has to be answered at the machine and which guildhall
 * refuses to answer remotely by design.
 */
const SPAWN_WAIT = 75_000

const newBtn = $<HTMLButtonElement>('#newbtn')
mountNewSession($<HTMLElement>('#newsession'), (dir) => {
	awaitingDir = dir
	awaitingSince = Date.now()
})
newBtn.addEventListener('click', () => showNewSession())

const pressBtn = $<HTMLButtonElement>('#pressbtn')
mountPress($<HTMLElement>('#press'), () => pressBtn.setAttribute('aria-expanded', 'false'))
pressBtn.addEventListener('click', () => {
	const opening = !pressOpen()
	opening ? showPress() : closePress()
	pressBtn.setAttribute('aria-expanded', String(opening))
})
mountList($<HTMLElement>('#list'), $<HTMLElement>('#empty'), showTerminal)
mountRoom(roomEl, $<HTMLCanvasElement>('#canvas'))
mountSettings($<HTMLButtonElement>('#gear'), $<HTMLElement>('#settings'), () => {
	showRoom()
	relayout() // labels change the room's geometry, so it has to be re-planned
})

// A phone suspends the tab; coming back to a dead connection with stale numbers
// looks like a working page telling you something untrue. Probe rather than
// reload — if the machine is still asleep, a reload loses the page for nothing.
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState !== 'visible') return
	freshness()
	if (!live) feed.probe()
})

addEventListener('resize', () => {
	showRoom()
	relayout()
})

const feed = connect()
// its own clock, not the feed's: the case this exists for is the feed stopping
setInterval(freshness, 1000)

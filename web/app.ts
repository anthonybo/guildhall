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
import { mountSettings, settings } from './settings.ts'

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

function paintCounts(list: Session[]) {
	const counts: Record<string, number> = {}
	for (const s of list) counts[s.state] = (counts[s.state] ?? 0) + 1
	bar.counts.replaceChildren(
		...(['error', 'needs', 'working', 'shell', 'review', 'done', 'parked'] as const)
			.filter((k) => counts[k])
			.map((k) => {
				const el = document.createElement('span')
				el.style.color = rgb(LOOK[k].color)
				el.textContent = `${LOOK[k].glyph} `
				const n = document.createElement('b')
				n.textContent = String(counts[k])
				// The word is its own element so a narrow screen can style it apart. As
				// one string, "1 working" wrapped between the number and the word and
				// the header grew to three lines of half-phrases.
				const word = document.createElement('i')
				word.textContent = ` ${LOOK[k].label}`
				// the same phrase, for a pointer that hovers the glyph
				el.title = `${counts[k]} ${LOOK[k].label}`
				el.append(n, word)
				return el
			}),
	)
}

function apply(data: { sessions: Session[]; at: number; version?: string; update?: string | null }) {
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
	let timer = 0

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
			bar.link.className = 'link live'
			bar.link.textContent = 'live'
			freshness()
		}
		es.onmessage = (e) => {
			live = true
			apply(JSON.parse(e.data))
		}
		es.onerror = () => {
			live = false
			bar.link.className = 'link down'
			bar.link.textContent = 'offline'
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

mountList($<HTMLElement>('#list'), $<HTMLElement>('#empty'))
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

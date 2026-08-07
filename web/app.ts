/**
 * The browser client.
 *
 * It runs the same office the terminal does — same planner, same seating rules,
 * same behaviour — against a JSON feed of sessions. Only the drawing differs: a
 * canvas instead of half blocks and kitty images. That is possible because the
 * simulation has no node dependencies, so nothing here is a reimplementation
 * that can drift from the original.
 *
 * The room needs width to be legible, so below 720px it is hidden and the list
 * carries everything. A phone is asking "what is the status", not "show me the
 * furniture".
 */
import { Canvas } from '../src/canvas.ts'
import { Office } from '../src/office.ts'
import { setSheets } from '../src/characters.ts'
import { renderRoom } from '../src/render.ts'
import { LOOK, projectColours, tierOf } from '../src/theme.ts'
import { needsAttention, order } from '../src/data/select.ts'
import { PLATE_COLS, PLATE_ROWS } from '../src/office/model.ts'
import type { Session } from '../src/data/types.ts'
import type { Image } from '../src/png.ts'
import { MIN_CHARS } from '../src/nameplate.ts'
import { mountSettings, settings } from './settings.ts'

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T
const rgb = (c: readonly number[]) => `rgb(${c[0]} ${c[1]} ${c[2]})`

const bar = { counts: $<HTMLElement>('#counts'), link: $<HTMLElement>('#link'), ver: $<HTMLElement>('#ver') }
const listEl = $<HTMLUListElement>('#list')
const emptyEl = $<HTMLElement>('#empty')
const roomEl = $<HTMLElement>('#room')
const canvas = $<HTMLCanvasElement>('#canvas')
const stampEl = $<HTMLElement>('#stamp')
const offlineEl = $<HTMLElement>('#offline')
const ctx2d = canvas.getContext('2d')!
/** The room at its native pixel size, before being blown up onto the display. */
const buffer = document.createElement('canvas')
const bufferCtx = buffer.getContext('2d')!

let sessions: Session[] = []
let office: Office | null = null
let cv: Canvas | null = null
let sheetsReady = false
/** local clock when the newest feed arrived, so its age can be shown honestly */
let seenAt = 0
/** whether the stream is currently delivering */
let live = false

/* ── sprites: the same PNGs, decoded by the browser ── */

async function loadSheets() {
	const imgs: Image[] = []
	for (let i = 0; i < 6; i++) {
		const bitmap = await createImageBitmap(await (await fetch(`/characters/char_${i}.png`)).blob())
		const off = new OffscreenCanvas(bitmap.width, bitmap.height)
		const c = off.getContext('2d')!
		c.drawImage(bitmap, 0, 0)
		const d = c.getImageData(0, 0, bitmap.width, bitmap.height)
		imgs.push({ w: bitmap.width, h: bitmap.height, rgba: new Uint8ClampedArray(d.data) })
	}
	setSheets(imgs)
	sheetsReady = true
}

/* ── the room ── */

/**
 * How big the office should be.
 *
 * Height comes from the population, not from the width. A fixed aspect gave a
 * room mostly made of empty floor and pushed the table off the bottom of the
 * screen — the room is the picture, but the list is the answer, and burying the
 * answer under three screens of carpet is the wrong trade.
 *
 * Bands are four rows: desks take one per few projects, and two more carry the
 * kitchen, couches and ping-pong that the idle characters walk to.
 */
function roomSize(n: number) {
	const cssW = roomEl.clientWidth || 900
	const cols = Math.max(48, Math.min(104, Math.floor(cssW / 10)))
	// Count in TILE rows, then double. `fit` takes canvas pixels and divides by
	// TILE, and a canvas is two pixels per terminal row — so asking for 26 rows
	// quietly bought 13 bands' worth of floor and left none for the facilities.
	const perBand = Math.max(1, Math.floor((cols - 6) / 8))
	const bands = Math.ceil(n / perBand) + 2 // +2 for kitchen, couches, ping-pong
	// 24 is the floor: below it the social bands land inside the work zone and get
	// filtered out, leaving a room with desks and nothing else in it
	const tileRows = Math.max(24, Math.min(34, bands * 4 + 12))
	return { cols, rows: tileRows * 2 }
}

function ensureOffice(list: Session[]) {
	const { cols, rows } = roomSize(list.length)
	if (!cv || cv.w !== cols || cv.rows !== rows) {
		cv = new Canvas(cols, rows * 2)
		office ??= new Office()
		office.fit(cv.w, cv.h, list)
	}
	office!.assign(list)
	return office!
}

let last = performance.now()
let screenClock = 0
let screenFrame = 0

function frame(now: number) {
	requestAnimationFrame(frame)
	const dt = Math.min((now - last) / 1000, 0.25)
	last = now
	if (!sheetsReady || roomEl.hidden || !sessions.length) return

	const off = ensureOffice(sessions)
	off.update(dt, sessions)
	screenClock += dt
	if (screenClock > 0.45) {
		screenClock = 0
		screenFrame++
	}

	off.vertical = settings.labels === 'vertical'
	const placed = off.draw(cv!, sessions)
	off.overlay(cv!, placed, undefined, true)

	// The room is pixel art and must be scaled by whole pixels with no smoothing.
	// The nameplates are TEXT, and drawing them into that small buffer meant they
	// were stretched along with it — which is why they were unreadable. So the
	// pixels go through an offscreen buffer blown up with smoothing off, and the
	// text is drawn afterwards at the display's own resolution.
	//
	// `plates: []` for the same reason. The terminal has to draw a vertical plate
	// as a rotated bitmap because a terminal cannot rotate text, and at 4px per
	// column that bitmap would hold six characters. A canvas has real fonts and
	// rotate(), so the plates are drawn below at display resolution instead.
	const scene = { props: off.props, monitors: off.monitors, badges: off.badges, plates: [] }
	const { rgba, w, h } = renderRoom(cv!, scene, placed, 4, 8, screenFrame)
	if (buffer.width !== w || buffer.height !== h) {
		buffer.width = w
		buffer.height = h
	}
	bufferCtx.putImageData(new ImageData(rgba, w, h), 0, 0)

	const dpr = Math.min(3, window.devicePixelRatio || 1)
	const cssW = roomEl.clientWidth
	const cssH = Math.round((cssW * h) / w)
	const pxW = Math.round(cssW * dpr)
	const pxH = Math.round(cssH * dpr)
	if (canvas.width !== pxW || canvas.height !== pxH) {
		canvas.width = pxW
		canvas.height = pxH
		canvas.style.height = `${cssH}px`
	}
	ctx2d.imageSmoothingEnabled = false
	ctx2d.drawImage(buffer, 0, 0, pxW, pxH)
	drawLabels(pxW, pxH)
}

/**
 * Vertical nameplates: a coloured bar with the project turned on its side.
 *
 * Bottom-to-top, following Imhof's rule for labelling vertical features on maps,
 * and the same direction the terminal uses — the two views have to agree about
 * which way a name reads even though they draw it by completely different means.
 *
 * The size is shared, not solved per name. Letting each plate take the largest
 * size its own name allowed put a huge `marina` beside a tiny
 * `iptv-epg-matcher`, which reads as emphasis the room does not mean. So one
 * floor is set from MIN_CHARS — the same length the terminal guarantees — and a
 * short name may grow a third above it, which is the browser's equivalent of the
 * terminal's one-scale-step. Anything longer is truncated with a real ellipsis;
 * the terminal makes do with '.' only because its pixel font has no such glyph.
 */
function drawPlates(pxW: number, pxH: number) {
	const cw = pxW / cv!.w
	const ch = pxH / cv!.rows
	// set here rather than inherited from drawLabels, which sets them after this
	// runs — on the first frame of all they would still be the context defaults
	ctx2d.textBaseline = 'middle'
	ctx2d.textAlign = 'center'
	const w = PLATE_COLS * cw
	const h = PLATE_ROWS * ch
	const font = (px: number) => `${px}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
	// 0.62 is the advance-to-size ratio of that stack; 0.66 of the bar's width
	// leaves the keyline of colour that makes it read as a plate, not as a stripe.
	const fits = (chars: number) => Math.min(w * 0.66, (h * 0.94) / (chars * 0.62))
	const floor = fits(MIN_CHARS)

	for (const p of office!.plates) {
		// plate y is in canvas pixels, and a canvas pixel is half a row tall
		const x0 = p.x * cw
		const y0 = (p.y / 2) * ch
		ctx2d.fillStyle = rgb(p.colour)
		ctx2d.fillRect(Math.floor(x0), Math.floor(y0), Math.ceil(w), Math.ceil(h))

		const size = Math.max(9, Math.floor(Math.min(fits(p.proj.length), floor * (4 / 3))))
		ctx2d.font = font(Math.max(size, Math.floor(floor)))
		let text = p.proj
		while (text.length > 1 && ctx2d.measureText(text).width > h * 0.94) text = text.slice(0, -2) + '…'
		ctx2d.save()
		ctx2d.translate(x0 + w / 2, y0 + h / 2)
		ctx2d.rotate(-Math.PI / 2)
		ctx2d.fillStyle = '#20222e'
		ctx2d.fillText(text, 0, 0)
		ctx2d.restore()
	}
}

/**
 * Nameplates and status labels, drawn as real glyphs at full resolution.
 *
 * They live in the canvas text layer rather than in the pixel buffer, which is
 * what makes this possible — flattened into 4-pixel-wide cells and then stretched
 * they were a smear, and the room's one job is telling you which desk is whose.
 */
function drawLabels(pxW: number, pxH: number) {
	if (office!.vertical) drawPlates(pxW, pxH)
	const cw = pxW / cv!.w
	const ch = pxH / cv!.rows
	// a hair under the cell so descenders do not clip, and never below legibility
	ctx2d.font = `${Math.max(9, Math.round(ch * 0.82))}px ui-monospace, SFMono-Regular, Menlo, monospace`
	ctx2d.textBaseline = 'middle'
	ctx2d.textAlign = 'center'
	for (let r = 0; r < cv!.rows; r++) {
		for (let c = 0; c < cv!.w; c++) {
			const cell = cv!.cellAt(c, r)
			if (!cell) continue
			if (cell.bg) {
				ctx2d.fillStyle = rgb(cell.bg)
				ctx2d.fillRect(Math.floor(c * cw), Math.floor(r * ch), Math.ceil(cw), Math.ceil(ch))
			}
			if (cell.ch.trim()) {
				ctx2d.fillStyle = rgb(cell.fg ?? [220, 220, 220])
				ctx2d.fillText(cell.ch, c * cw + cw / 2, r * ch + ch / 2)
			}
		}
	}
}

/* ── the list ── */

const ago = (ms: number) => {
	const m = Math.round(ms / 60000)
	if (m < 1) return 'now'
	if (m < 60) return `${m}m`
	const h = Math.round(m / 60)
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/**
 * Which rows are open, held across repaints.
 *
 * The feed replaces the list every two seconds, so without this an expanded row
 * would slam shut mid-read — which is worse than not being able to open one.
 */
const opened = new Set<string>()

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

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

/**
 * The list, in bands.
 *
 * On a phone there is no room, so this is the whole app — and a flat list sorted
 * by urgency still makes you read every row to work out where "live" stops and
 * "finished ages ago" starts. Named bands do that in one glance, and they hold
 * their order even when a session changes state, so nothing jumps under your
 * thumb mid-read.
 */
const BANDS: { key: string; label: string; has: (s: Session) => boolean }[] = [
	{ key: 'error', label: 'failed', has: (s) => s.state === 'error' },
	{ key: 'needs', label: 'needs you', has: (s) => s.state === 'needs' },
	{ key: 'live', label: 'working', has: (s) => s.state === 'working' || s.state === 'shell' },
	{ key: 'review', label: 'finished, unread', has: (s) => s.state === 'review' },
	{ key: 'done', label: 'your turn', has: (s) => s.state === 'done' },
	{ key: 'parked', label: 'parked', has: (s) => s.state === 'parked' },
]

function paintList(list: Session[]) {
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
		head.innerHTML = `<span class="band-name"></span><span class="band-n"></span>`
		head.querySelector('.band-name')!.textContent = band.label
		head.querySelector('.band-n')!.textContent = String(members.length)
		nodes.push(head)
		nodes.push(...members.map(row))
	}
	listEl.replaceChildren(...nodes)

	function row(s: Session) {
		{
			const look = LOOK[s.state]
			const li = document.createElement('li')
			li.className = 'row' + (needsAttention(s) ? ' attn' : '')
			li.style.setProperty('--state', rgb(look.color))
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
			// textContent, never innerHTML: this is a session's own prose and file
			// names, and it must never be able to become markup
			li.querySelector('.proj')!.textContent = s.proj
			li.querySelector('.doing')!.textContent = s.doing || s.last || '—'

			// a row is a button: the whole thing is the target, because a small
			// chevron is a poor thing to aim at on a phone
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
				paintList(sessions)
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
				el.textContent = `${LOOK[k].glyph} `
				const n = document.createElement('b')
				n.textContent = String(counts[k])
				// The word is its own element so a narrow screen can drop it. As one
				// string, "1 working" wrapped between the number and the word and the
				// header grew to three lines of half-phrases.
				const word = document.createElement('i')
				word.textContent = ` ${LOOK[k].label}`
				el.append(n, word)
				return el
			}),
	)
}

function apply(data: { sessions: Session[]; at: number; version?: string; update?: string | null }) {
	sessions = data.sessions
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
 * EventSource reconnects on its own, so a server restart heals without a refresh
 * — but only if the session is still good, and it will otherwise retry against a
 * 401 forever while the page sits there saying "reconnecting". After a few
 * failures we reload, which lets the server decide: the room if the cookie is
 * still valid, the passcode screen if it is not.
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
	 * the reload lets it serve the passcode screen. For the common cause, a
	 * laptop that went to sleep when its work finished, it was actively harmful:
	 * it threw away a page showing real if elderly numbers and replaced it with
	 * the browser's cannot-connect error. So ask first, and only reload when
	 * something answered.
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
			// EventSource retries on its own, but only against the same dead socket
			// and with no way to tell 401 from unreachable. Drive it from probe().
			es?.close()
			es = null
			freshness()
			retry()
		}
	}
	open()
	return { probe: () => ((delay = 1000), probe()) }
}

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
	cv = null // force a re-fit at the new width
})

/**
 * Whether the office is on screen — and with it the animation, since `frame`
 * returns early while it is hidden. The width rule is not a preference and still
 * wins: at 100 columns on a phone the room is illegible whatever the setting says.
 */
function showRoom() {
	roomEl.hidden = window.innerWidth <= 720 || !settings.room || sessions.length === 0
}

mountSettings($<HTMLButtonElement>('#gear'), $<HTMLElement>('#settings'), () => {
	showRoom()
	cv = null // labels change the room's geometry, so it has to be re-planned
})

loadSheets().catch(() => {
	// no sprites: the list still works, which is the part that matters
	sheetsReady = false
})
const feed = connect()
// its own clock, not the feed's: the case this exists for is the feed stopping
setInterval(freshness, 1000)
requestAnimationFrame(frame)

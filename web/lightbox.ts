/**
 * A picture full screen, over whatever is open, with pinch-zoom and an easy way out.
 *
 * Tapping a picture used to open it in a new tab, which on a phone means leaving the
 * app to look at a screenshot and finding the way back. Asked for instead: enlarge it in
 * place, zoom, close — and a button for a new tab when that is really wanted.
 *
 * Zoom is done here rather than left to the browser. Pinching a page on iOS zooms the
 * whole app, panel and all, and leaves it zoomed after the picture closes.
 */

const MAX = 6
const DOUBLE_TAP_MS = 300

let current: { close: () => void } | null = null

export function lightbox(url: string, caption: string) {
	current?.close()
	const box = document.createElement('div')
	box.className = 'fixed inset-0 z-[70] flex flex-col bg-black/92'
	box.setAttribute('role', 'dialog')
	box.setAttribute('aria-label', caption)

	const bar = document.createElement('div')
	bar.className = 'flex shrink-0 items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2'
	const label = document.createElement('span')
	label.className = 'min-w-0 flex-1 truncate font-mono text-[0.72rem] text-muted'
	label.textContent = caption
	const tab = document.createElement('a')
	tab.href = url
	tab.target = '_blank'
	tab.rel = 'noopener'
	tab.textContent = 'Open in new tab'
	tab.className = 'flex min-h-11 shrink-0 items-center rounded border border-line px-3 font-mono text-[0.72rem] text-label'
	const shut = document.createElement('button')
	shut.type = 'button'
	shut.title = 'Close (Esc)'
	shut.textContent = '✕'
	shut.className = 'flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded border border-hot bg-transparent text-[1rem] text-hot'
	bar.append(label, tab, shut)

	// `touch-action: none` hands every gesture over this area to the code below, so a
	// pinch zooms the picture rather than the page.
	const stage = document.createElement('div')
	stage.className = 'relative min-h-0 flex-1 touch-none overflow-hidden'
	const img = document.createElement('img')
	img.src = url
	img.alt = caption
	img.draggable = false
	img.className = 'absolute inset-0 m-auto max-h-full max-w-full select-none object-contain'
	img.style.transformOrigin = '0 0'
	stage.append(img)

	const hint = document.createElement('div')
	hint.className = 'shrink-0 px-3 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center font-mono text-[0.66rem] text-faint'
	hint.textContent = 'pinch or double-tap to zoom · tap outside to close'
	box.append(bar, stage, hint)

	let scale = 1
	let x = 0
	let y = 0
	const apply = () => {
		img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
	}
	/** Zoom to `next`, keeping the point under (cx, cy) — relative to the stage — still. */
	const zoomAt = (next: number, cx: number, cy: number) => {
		next = Math.min(MAX, Math.max(1, next))
		const r = img.getBoundingClientRect()
		const s = stage.getBoundingClientRect()
		// The point under the finger, in the picture's own unscaled coordinates.
		const px = (cx + s.left - r.left) / scale
		const py = (cy + s.top - r.top) / scale
		x += (px * scale - px * next)
		y += (py * scale - py * next)
		scale = next
		if (scale === 1) x = y = 0
		apply()
	}

	const points = new Map<number, { x: number; y: number }>()
	let pinch: { dist: number; scale: number } | null = null
	let lastTap = 0
	let moved = false
	const at = (e: PointerEvent) => {
		const s = stage.getBoundingClientRect()
		return { x: e.clientX - s.left, y: e.clientY - s.top }
	}
	const spread = () => {
		const [a, b] = [...points.values()]
		return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
	}
	stage.addEventListener('pointerdown', (e) => {
		// Capture keeps a drag that leaves the picture still a drag. It can throw for a
		// pointer the browser has already let go of, and nothing below may depend on it.
		try {
			stage.setPointerCapture(e.pointerId)
		} catch {
			// carry on uncaptured
		}
		points.set(e.pointerId, at(e))
		moved = false
		if (points.size === 2) pinch = { dist: spread(), scale }
	})
	stage.addEventListener('pointermove', (e) => {
		const prev = points.get(e.pointerId)
		if (!prev) return
		const now = at(e)
		points.set(e.pointerId, now)
		if (Math.hypot(now.x - prev.x, now.y - prev.y) > 2) moved = true
		if (pinch && points.size === 2) {
			const [a, b] = [...points.values()]
			zoomAt((pinch.scale * spread()) / Math.max(1, pinch.dist), (a!.x + b!.x) / 2, (a!.y + b!.y) / 2)
		} else if (points.size === 1 && scale > 1) {
			x += now.x - prev.x
			y += now.y - prev.y
			apply()
		}
	})
	const lift = (e: PointerEvent) => {
		const was = points.size
		points.delete(e.pointerId)
		if (points.size < 2) pinch = null
		if (was !== 1 || moved) return
		const t = performance.now()
		if (t - lastTap < DOUBLE_TAP_MS) {
			lastTap = 0
			const p = at(e)
			zoomAt(scale > 1 ? 1 : 2.5, p.x, p.y)
			return
		}
		lastTap = t
		// A single tap outside the picture, unzoomed, closes — after the double-tap window,
		// so the first tap of a double-tap does not.
		// By position, not target: pointer capture makes the stage the target of everything.
		const r = img.getBoundingClientRect()
		const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
		if (outside && scale === 1) setTimeout(() => lastTap === t && close(), DOUBLE_TAP_MS)
	}
	stage.addEventListener('pointerup', lift)
	stage.addEventListener('pointercancel', (e) => {
		points.delete(e.pointerId)
		pinch = null
	})
	stage.addEventListener(
		'wheel',
		(e) => {
			e.preventDefault()
			const p = { x: e.clientX - stage.getBoundingClientRect().left, y: e.clientY - stage.getBoundingClientRect().top }
			zoomAt(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y)
		},
		{ passive: false },
	)

	const onKey = (e: KeyboardEvent) => {
		if (e.key !== 'Escape') return
		// Only this closes; the panel underneath must not take the same Escape.
		e.stopImmediatePropagation()
		close()
	}
	const close = () => {
		document.removeEventListener('keydown', onKey, true)
		box.remove()
		if (current === handle) current = null
	}
	const handle = { close }
	current = handle
	shut.addEventListener('click', close)
	document.addEventListener('keydown', onKey, true)
	document.body.append(box)
}

/**
 * Make a picture's link open the lightbox on a tap, and stay a real link for everything
 * else — a long-press menu, or a modified click on a desktop.
 */
export function enlargeOnTap(link: HTMLAnchorElement, caption: string) {
	link.addEventListener('click', (e) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
		e.preventDefault()
		lightbox(link.href, caption)
	})
}

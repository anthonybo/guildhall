/**
 * A picture in the conversation history: one Claude read, or one you pasted.
 *
 * Loaded only when it scrolls near the screen. A long history holds a lot of them —
 * measured on one real session: 72 images, 24MB — and fetching them all on opening
 * would be that download on a phone, for pictures most readers never scroll to.
 *
 * Fetched with the control password rather than set as `src`, because an image tag
 * cannot send the header it travels in (see termimages.ts for the same reason).
 */

/** Room above and below the screen to start loading in, so a picture is there by the
 *  time it scrolls in rather than popping in under the reader. */
const AHEAD = '600px 0px'

let watcher: IntersectionObserver | null = null
let watching: Element | null = null
const urls: string[] = []

/** Called with the scrolling element when the history opens. */
export function watchImages(scroller: HTMLElement) {
	forgetImages()
	watching = scroller
	watcher = new IntersectionObserver(
		(seen) => {
			for (const s of seen) {
				if (!s.isIntersecting) continue
				watcher?.unobserve(s.target)
				void (s.target as HTMLElement & { load?: () => Promise<void> }).load?.()
			}
		},
		{ root: scroller, rootMargin: AHEAD },
	)
}

/** On closing: stop watching and let the pictures' memory go. */
export function forgetImages() {
	watcher?.disconnect()
	watcher = null
	watching = null
	for (const u of urls.splice(0)) URL.revokeObjectURL(u)
}

/**
 * The element for one picture. `mine` draws it as yours — a pasted image — with the
 * left bar your messages have; a picture Claude read sits under its steps, indented.
 */
export function historyImage(session: string, ref: string, token: string, mine: boolean): HTMLElement {
	const box = document.createElement('div')
	box.className = mine ? 'mt-2 mb-2 border-l-4 border-l-you pl-2' : 'mt-1 mb-2 ml-4'
	const label = document.createElement('div')
	label.className = 'text-[0.7rem] text-faint'
	label.textContent = mine ? 'you pasted a picture' : 'picture'
	box.append(label)
	const host = box as HTMLElement & { load?: () => Promise<void> }
	host.load = async () => {
		try {
			const res = await fetch(`/api/history-image?id=${encodeURIComponent(session)}&ref=${encodeURIComponent(ref)}`, {
				headers: { 'x-guildhall-control': token },
				signal: AbortSignal.timeout(30_000),
			})
			if (!res.ok) {
				label.textContent = mine ? 'you pasted a picture (it could not be read)' : 'picture (it could not be read)'
				return
			}
			const url = URL.createObjectURL(await res.blob())
			// Closed while it was loading: nothing to put it in.
			if (!watching) return URL.revokeObjectURL(url)
			urls.push(url)
			const img = document.createElement('img')
			img.src = url
			img.alt = label.textContent ?? 'picture'
			img.className = 'block h-auto max-h-[70vh] max-w-full rounded border border-line'
			// Tap for the whole picture, at full size, in its own tab.
			const open = document.createElement('a')
			open.href = url
			open.target = '_blank'
			open.rel = 'noopener'
			open.append(img)
			label.replaceWith(open)
		} catch {
			// Unreachable for now: watched again after a pause, so it tries again while in
			// view without retrying in a tight loop.
			label.textContent = mine ? 'you pasted a picture' : 'picture'
			setTimeout(() => watcher?.observe(box), 5000)
		}
	}
	watcher?.observe(box)
	return box
}

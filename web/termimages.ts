/**
 * The pictures a terminal is drawing, fetched once each and kept as object URLs.
 *
 * Fetched rather than put in an `<img src>`, because the route is behind the control
 * password and that travels in a header an image tag cannot send. Kept, because the
 * screen is repainted from scratch whenever it changes and a picture refetched on every
 * repaint would be a download every two seconds.
 */
import { repaintSoon, term, token } from './termstate.ts'

/** An object URL, or null for a picture the server could not find. */
const got = new Map<string, string | null>()
const asking = new Set<string>()
/** Plenty for the pictures one screen shows; past it the oldest are let go. */
const KEEP = 24

/** The picture's URL if it has arrived, or null for now — it is asked for once and the
 *  screen repaints when it lands. */
export function picture(name: string): string | null {
	const id = term.openId
	if (!id) return null
	const key = `${id}\0${name}`
	if (got.has(key)) return got.get(key) ?? null
	if (!asking.has(key)) {
		asking.add(key)
		void load(id, name, key)
	}
	return null
}

async function load(id: string, name: string, key: string) {
	try {
		const res = await fetch(`/api/image?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`, {
			headers: { 'x-guildhall-control': token() },
			signal: AbortSignal.timeout(20_000),
		})
		const url = res.ok ? URL.createObjectURL(await res.blob()) : null
		if (got.size >= KEEP) {
			const [oldest, url0] = got.entries().next().value!
			if (url0) URL.revokeObjectURL(url0)
			got.delete(oldest)
		}
		got.set(key, url)
		if (url) repaintSoon()
	} catch {
		// Unreachable for now: forgotten, so the next paint asks again.
	} finally {
		asking.delete(key)
	}
}

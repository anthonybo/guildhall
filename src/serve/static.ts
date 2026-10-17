/**
 * The browser client's files, and the fingerprint that tells an open tab it is stale.
 *
 * Both take the repo root from the caller instead of working it out here. serve.ts finds
 * it from its own `import.meta.url`, which is `src/` when run from source and `dist/`
 * when bundled, so `..` from there is the root either way. From this file it would be
 * `src/serve/` from source and still `dist/` bundled, and no single relative path is
 * right for both.
 */
import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { MIME, send } from './http.ts'

/**
 * A fingerprint of the browser client, so a tab can tell it has gone stale.
 *
 * `web/` is read from disk on every request, which means a rebuild is live the
 * moment it lands — but only to a browser that asks again, and a phone left open
 * on the sofa never does. So the fingerprint rides the feed the page is already
 * listening to, and the page reloads itself when it changes.
 *
 * Size and mtime rather than a hash of the contents: this is called on every
 * stream tick, hashing a 100KB bundle twice a second to detect a change that
 * happens twice a day is a poor trade, and stat is enough to notice a rebuild.
 */
export function clientStamp(root: string) {
	let stamp = ''
	for (const name of ['app.js', 'app.css', 'index.html']) {
		try {
			const s = fs.statSync(path.join(root, 'web', name))
			stamp += `${s.size}:${Math.round(s.mtimeMs)};`
		} catch {
			stamp += 'missing;'
		}
	}
	return stamp
}

/**
 * Text served compressed, keyed by the file and its mtime.
 *
 * The client asks for `no-store`, so without this the same 172KB would be gzipped on
 * every page load. Small and bounded: there are a handful of files under web/.
 */
const squeezed = new Map<string, { at: number; body: Buffer }>()

/** Worth compressing. A PNG is already compressed and gzip makes it very slightly bigger. */
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json'])

/** Static files, confined to web/ and assets/ — never an arbitrary path. */
export function serveStatic(ROOT: string, res: http.ServerResponse, pathname: string, accepts = '') {
	const rel = pathname === '/' ? '/index.html' : pathname
	const roots = [path.join(ROOT, 'web'), path.join(ROOT, 'assets')]
	for (const root of roots) {
		const file = path.resolve(root, '.' + rel)
		// resolve first, then check containment: `..` in the URL must not escape
		if (!file.startsWith(root + path.sep)) continue
		try {
			const body = fs.readFileSync(file)
			const type = MIME[path.extname(file)] ?? 'application/octet-stream'
			/**
			 * Compressed when the client says it can take it.
			 *
			 * The browser bundle is 172KB and gzips to 49KB — measured — and this is a
			 * phone pulling it over a tailnet, which is the whole reason there is a size
			 * budget on it at all. Serving it raw meant the budget was guarding a number
			 * three and a half times the cost anybody actually pays.
			 *
			 * Only here, in the static path. The event stream must never be compressed:
			 * buffering a live feed turns it into a slideshow, which is the same reason
			 * `x-accel-buffering: no` is set on it.
			 */
			if (COMPRESSIBLE.has(path.extname(file)) && /\bgzip\b/.test(accepts)) {
				const stat = fs.statSync(file)
				const had = squeezed.get(file)
				const gz = had && had.at === stat.mtimeMs ? had.body : zlib.gzipSync(body, { level: 6 })
				if (!had || had.at !== stat.mtimeMs) squeezed.set(file, { at: stat.mtimeMs, body: gz })
				res
					.writeHead(200, {
						'content-type': type,
						'content-encoding': 'gzip',
						'cache-control': 'no-store',
						// Caches and proxies must not hand a gzipped body to a client that
						// did not ask for one.
						vary: 'accept-encoding',
					})
					.end(gz)
				return
			}
			send(res, 200, type, body)
			return
		} catch {}
	}
	send(res, 404, 'text/plain; charset=utf-8', 'not found')
}

#!/usr/bin/env node
/**
 * The README exactly as GitHub will draw it, without pushing anything.
 *
 * Not a local markdown renderer. Those all differ from GitHub somewhere that
 * matters — anchor slugs, table borders, how an <img> inside a link is sized, what
 * happens to raw HTML — and the point of a preview is to catch the difference
 * between what you wrote and what the page will show. So this asks GitHub itself,
 * through `gh api /markdown`, and renders the HTML it sends back.
 *
 * It is served rather than opened as a file:// because the images are relative
 * paths (`docs/web-room.jpg`). A file:// page resolves those against the temp
 * directory and shows broken icons, which is exactly the thing a screenshot
 * preview needs to be right about.
 *
 *   npm run readme            # serves on 4402 and opens a browser
 *   npm run readme -- --port 5000 --no-open
 *
 * Requires `gh`, authenticated. Nothing else, and nothing is installed.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = portArg > -1 ? Number(args[portArg + 1]) : 4402
const OPEN = !args.includes('--no-open')
const FILE = args.find((a) => a.endsWith('.md')) ?? 'README.md'

/** Ask GitHub to render it, in the repo's own context so #issue links resolve. */
function render() {
	const text = fs.readFileSync(path.join(ROOT, FILE), 'utf8')
	try {
		return execFileSync('gh', ['api', '-X', 'POST', '/markdown', '-f', 'mode=gfm', '-f', 'context=anthonybo/guildhall', '-f', `text=${text}`], { encoding: 'utf8', maxBuffer: 8 << 20 }) // allow-personal: this repository's own path, which the gh api call needs
	} catch (e) {
		const why = /not logged|authentication/i.test(String(e.stderr)) ? 'gh is not authenticated — run `gh auth login`' : String(e.stderr || e.message).trim().split('\n')[0]
		console.error(`could not render: ${why}`)
		process.exit(1)
	}
}

/**
 * GitHub's own stylesheet, from the CDN.
 *
 * Deliberately not vendored: a copy pinned in this repo would drift from what
 * github.com actually serves, and a preview that is confidently wrong is worse
 * than no preview. This is the one thing here that needs the network, and it is
 * already needed for the API call above.
 */
const page = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${FILE} — preview</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css">
<style>
  body { margin:0; background:#0d1117; }
  .markdown-body { box-sizing:border-box; max-width:1012px; margin:0 auto; padding:2rem 1.5rem 6rem; }
  @media (max-width:767px){ .markdown-body{ padding:1rem } }
  .bar { position:sticky; top:0; z-index:9; background:#161b22; border-bottom:1px solid #30363d;
         color:#8b949e; font:12px ui-monospace,monospace; padding:.55rem 1rem; display:flex; gap:1rem }
  .bar b { color:#d29922; font-weight:700 }
</style></head><body>
<div class="bar"><b>preview</b><span>${FILE}</span><span>rendered by GitHub · not pushed</span><span>reload to re-render</span></div>
<article class="markdown-body">${body}</article>
</body></html>`

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`)
	// Re-render on every load, so editing the file and hitting reload is the loop.
	if (url.pathname === '/') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(render()))
		return
	}
	// Everything else is a real file from the repo — the images the README points at.
	const file = path.resolve(ROOT, '.' + url.pathname)
	if (!file.startsWith(ROOT + path.sep)) return void res.writeHead(403).end('outside the repo')
	const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif' }[path.extname(file)] ?? 'application/octet-stream'
	// READ FIRST, then answer. `writeHead(200).end(readFileSync(...))` sends the
	// headers before the read runs, so a missing file throws with a 200 already on
	// the wire, the catch tries to send a 404 on top of it, and the process dies of
	// ERR_HTTP_HEADERS_SENT. One request for a filename you got slightly wrong took
	// the whole preview down.
	let body
	try {
		body = fs.readFileSync(file)
	} catch {
		return void res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${url.pathname}`)
	}
	// `no-store` on the IMAGES too, not just the page.
	//
	// Without it the browser caches them heuristically — no header means it may
	// decide for itself — and since the filenames never change, regenerating an
	// image and reloading shows the OLD one. That is not a small annoyance in a tool
	// whose entire job is "look at the picture you just changed": it cost a round of
	// re-rendering a GIF that had already been fixed, because the page kept serving
	// the previous copy and the fix looked like it had done nothing.
	res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
})

server.listen(PORT, '127.0.0.1', () => {
	const at = `http://127.0.0.1:${PORT}/`
	console.log(`${FILE} preview on ${at} — ctrl-c to stop`)
	if (OPEN) spawn('open', [at], { stdio: 'ignore' }).unref()
})

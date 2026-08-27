/**
 * Refuse browser APIs that only exist over https.
 *
 * This app is served over PLAIN HTTP on a tailnet address, always. There is no
 * certificate and there is not going to be one, so anything gated on a "secure context"
 * is not merely unavailable — it is `undefined`, and calling it throws.
 *
 * That shipped once. `crypto.randomUUID()` was used to key a message so it could not be
 * delivered twice, and it works on localhost, which is treated as secure — so every test
 * passed and the phone got `TypeError: crypto.randomUUID is not a function` thrown before
 * the send was attempted. Sending stopped working entirely, and the report was "I had to
 * come back to my laptop to respond to you".
 *
 * Measured rather than remembered: served from 192.168.4.57 over http,
 * `window.isSecureContext` is `false` and `typeof crypto.randomUUID` is `"undefined"`.
 *
 * This reads the BUILT bundle, not the sources, because the bundle is what a phone runs
 * and is the last step of the chain. A dependency introducing one of these would be
 * missed by a source scan and caught here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(ROOT, 'web', 'app.js')

/**
 * Each of these is `undefined` outside a secure context.
 *
 * Kept to APIs that are actually reachable by mistake in a project like this. A list
 * that flags things nobody would write gets ignored, which is the note in
 * check-spelling.mjs about a check that cries wolf.
 */
const GATED = [
	['crypto.randomUUID', 'use crypto.getRandomValues, which is not gated'],
	['crypto.subtle', 'no WebCrypto over http — hash on the server instead'],
	['navigator.clipboard', 'use a hidden textarea and document.execCommand("copy")'],
	['navigator.geolocation', 'not available over http'],
	['navigator.credentials', 'not available over http'],
	['navigator.mediaDevices', 'not available over http'],
	['showSaveFilePicker', 'not available over http'],
	['showOpenFilePicker', 'not available over http'],
	['navigator.serviceWorker', 'service workers need https'],
	['navigator.bluetooth', 'not available over http'],
	['navigator.usb', 'not available over http'],
]

let src
try {
	src = fs.readFileSync(BUNDLE, 'utf8')
} catch {
	console.error('insecure: web/app.js is missing — run `npm run build` first')
	process.exit(1)
}

const found = []
for (const [api, fix] of GATED) {
	// Escaped, and matched as a property access so a string mentioning the name in a
	// comment or an error message does not trip it.
	const re = new RegExp(`\\b${api.replace('.', '\\s*\\.\\s*')}\\b`, 'g')
	const hits = src.match(re)
	if (hits) found.push({ api, fix, count: hits.length })
}

if (!found.length) {
	console.log(`insecure: none of the ${GATED.length} secure-context APIs are in the bundle`)
	process.exit(0)
}

console.error('insecure: the browser bundle uses APIs that do not exist over plain http.\n')
console.error('This app is served over http on a tailnet, where these are `undefined` and')
console.error('calling one throws. localhost is treated as secure, so this passes locally')
console.error('and fails on the phone — which is exactly how it shipped once before.\n')
for (const f of found) console.error(`  ${f.api}  (${f.count}x) — ${f.fix}`)
process.exit(1)

/**
 * The credential for driving a session, which is not the one for watching it.
 *
 * Viewing and controlling are different privileges and must not share a secret.
 * The view passcode is four digits, which is right for "show me what is running"
 * — ten thousand combinations behind an exponential throttle is more than enough
 * to protect a status page. It is nowhere near enough for a credential that types
 * into Claude Code sessions across every repository on the machine, because that
 * is a path to editing files and running commands. So this is 32 hex characters
 * from the system CSPRNG: 128 bits, which no throttle has to compensate for.
 *
 * Generated on first use and never shown over the network — you read it off the
 * machine that holds it, which is the same trust boundary as sitting at it.
 *
 * Comparison is constant-time. A four-digit code with a hard throttle can afford
 * a sloppy compare; a long token where an attacker can measure a byte at a time
 * cannot.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Resolved per call so tests can redirect it; see the note in auth.ts. */
const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const file = () => path.join(dir(), 'control-token')

export const controlTokenPath = () => file()

let cached = ''

/** The token, creating one the first time it is asked for. */
export function controlToken(): string {
	if (cached) return cached
	try {
		const raw = fs.readFileSync(file(), 'utf8').trim()
		if (/^[0-9a-f]{32}$/.test(raw)) return (cached = raw)
	} catch {}
	const made = crypto.randomBytes(16).toString('hex')
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), made + '\n', { mode: 0o600 })
	} catch {
		// unwritable config dir: still return a token so this run works, but it
		// will differ next launch rather than silently becoming a fixed value
	}
	return (cached = made)
}

/** Forget the in-process copy, so a rotated file is picked up. */
export const forgetControlToken = () => (cached = '')

/** Replace the token with a fresh one and return it. */
export function rotateControlToken(): string {
	cached = ''
	try {
		fs.rmSync(file(), { force: true })
	} catch {}
	return controlToken()
}

/** Constant-time equality, false for anything the wrong shape. */
export function controlAllowed(offered: string | undefined): boolean {
	if (!offered || !/^[0-9a-f]{32}$/.test(offered)) return false
	const a = Buffer.from(offered, 'utf8')
	const b = Buffer.from(controlToken(), 'utf8')
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Whether an address may control at all, regardless of the token.
 *
 * Loopback and Tailscale's CGNAT range only. A shared secret on a plain LAN is
 * one careless guest network away from arbitrary code execution on this machine,
 * and no amount of token length fixes being reachable by everything on the
 * subnet. Watching is fine on a LAN; typing is not.
 */
export function controlReachable(addr: string | undefined): boolean {
	if (!addr) return false
	const ip = addr.replace(/^::ffff:/, '')
	if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true
	// Tailscale hands out 100.64.0.0/10, which is authenticated at the tailnet
	const m = /^100\.(\d+)\./.exec(ip)
	return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

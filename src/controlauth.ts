/**
 * The credential for driving a session, which is not the one for watching it.
 *
 * Viewing and controlling are different privileges and must not share a secret.
 * The view passcode is four digits, which is right for "show me what is running"
 * — ten thousand combinations behind an exponential throttle is more than enough
 * to protect a status page. It is nowhere near enough for a credential that types
 * into Claude Code sessions across every repository on the machine, because that
 * is a path to editing files and running commands.
 *
 * It is a passphrase you choose rather than a random token, because the thing
 * has to be typed on a phone and a 32-character hex string is not. That trade is
 * only safe with two things attached, and both are here:
 *
 *  - a LENGTH FLOOR. A chosen phrase has far less entropy per character than
 *    random hex, so it has to make up for it in length. Twelve is the minimum
 *    and the panel says so.
 *  - a THROTTLE. Random 128-bit tokens do not need one; guessable phrases do.
 *    Five wrong answers from an address and it waits, doubling each time, which
 *    turns an online dictionary attack into something that takes years.
 *
 * Stored SCRYPTED, never in plain text. The file holds a random salt and a
 * derived key, so reading it tells an attacker nothing they can type, and a
 * backup or a synced config directory does not leak the phrase itself.
 * Comparison is constant-time.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Resolved per call so tests can redirect it; see the note in auth.ts. */
const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const file = () => path.join(dir(), 'control-pass')

export const controlPassPath = () => file()

/**
 * Twelve characters.
 *
 * Short enough to type on a phone once per device, long enough that a chosen
 * phrase is not trivially guessable even before the throttle is counted. The
 * old machine-generated token was 128 random bits and needed no floor; a phrase
 * you can remember is worth perhaps two bits a character, so the length is what
 * has to carry it.
 */
export const MIN_LENGTH = 12

/** scrypt cost. N=16384 keeps a single check near 50ms here, which is nothing
 *  for one login and a great deal for anyone trying millions. */
const N = 16384
const KEYLEN = 32

const derive = (pass: string, salt: Buffer) => crypto.scryptSync(pass, salt, KEYLEN, { N, r: 8, p: 1, maxmem: 64 << 20 })

export type SetResult = { ok: true } | { ok: false; why: string }

/** Store a new control passphrase. Rejects anything too short to be one. */
export function setControlPass(pass: string): SetResult {
	const p = pass.trim()
	if (p.length < MIN_LENGTH) return { ok: false, why: `too short — ${MIN_LENGTH} characters or more` }
	// A phrase made of one repeated character is long without being hard, and
	// somebody WILL try it. Cheap to refuse, and the message says why.
	if (new Set(p).size < 5) return { ok: false, why: 'too few different characters' }
	const salt = crypto.randomBytes(16)
	const key = derive(p, salt)
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), `scrypt$${N}$${salt.toString('hex')}$${key.toString('hex')}\n`, { mode: 0o600 })
	} catch {
		return { ok: false, why: 'could not write the config file' }
	}
	return { ok: true }
}

/** Whether a passphrase has been set at all. */
export function hasControlPass(): boolean {
	try {
		return /^scrypt\$/.test(fs.readFileSync(file(), 'utf8'))
	} catch {
		return false
	}
}

/** Forget nothing cached — the file is read per check, so a change takes at once. */
export function controlAllowed(offered: string | undefined): boolean {
	if (!offered) return false
	let stored: string
	try {
		stored = fs.readFileSync(file(), 'utf8').trim()
	} catch {
		return false // no passphrase set: control is unusable rather than open
	}
	const [tag, , saltHex, keyHex] = stored.split('$')
	if (tag !== 'scrypt' || !saltHex || !keyHex) return false
	let want: Buffer
	let got: Buffer
	try {
		want = Buffer.from(keyHex, 'hex')
		got = derive(offered, Buffer.from(saltHex, 'hex'))
	} catch {
		return false
	}
	return want.length === got.length && crypto.timingSafeEqual(want, got)
}

/* ── throttle ──
 * A chosen phrase is guessable in a way a random token is not, so this is what
 * actually stops an online attack. Mirrors the passcode's: five tries, then a
 * wait that doubles, capped at half an hour. */

type Attempts = { fails: number; until: number }
const byAddress = new Map<string, Attempts>()
const FREE_TRIES = 5
const BASE_LOCK = 15_000
const MAX_LOCK = 30 * 60_000

/** Milliseconds this address must wait, or 0. */
export function controlLockedFor(addr: string, now = Date.now()) {
	return Math.max(0, (byAddress.get(addr)?.until ?? 0) - now)
}

/** Record an attempt and say whether it was right. */
export function controlAttempt(addr: string, offered: string | undefined, now = Date.now()): boolean {
	if (controlLockedFor(addr, now) > 0) return false
	if (controlAllowed(offered)) {
		byAddress.delete(addr)
		return true
	}
	const a = byAddress.get(addr) ?? { fails: 0, until: 0 }
	a.fails++
	if (a.fails >= FREE_TRIES) {
		const over = a.fails - FREE_TRIES
		a.until = now + Math.min(BASE_LOCK * 2 ** over, MAX_LOCK)
	}
	byAddress.set(addr, a)
	return false
}

/** Visible for testing. */
export const resetControlThrottle = () => byAddress.clear()

/**
 * Whether an address may control at all, regardless of the passphrase.
 *
 * Loopback and Tailscale's CGNAT range only. A shared secret on a plain LAN is
 * one careless guest network away from arbitrary code execution on this machine,
 * and no amount of passphrase strength fixes being reachable by everything on
 * the subnet. Watching is fine on a LAN; typing is not.
 */
export function controlReachable(addr: string | undefined): boolean {
	if (!addr) return false
	const ip = addr.replace(/^::ffff:/, '')
	if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true
	// 100.64.0.0/10 — CGNAT, which in practice on a laptop means Tailscale
	const m = /^100\.(\d+)\./.exec(ip)
	return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

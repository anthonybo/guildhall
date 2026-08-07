/**
 * A four-digit passcode, and the rate limiting that makes one safe.
 *
 * Four digits is ten thousand combinations, which a script tries in under a
 * second — so the code alone is not the security, the throttle is. Five wrong
 * answers from one address and it stops answering for a while, doubling each
 * time. That turns an exhaustive search from seconds into months, which is what
 * makes a code short enough to type on a phone acceptable on a home network.
 *
 * The page never contains the code. It posts what was typed and the server
 * decides, so reading the source tells an attacker nothing they did not have.
 * What comes back is a session cookie — a long random value, not the code — so
 * the code is never stored in the browser either.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = path.join(os.homedir(), '.config', 'guildhall')
const FILE = path.join(DIR, 'passcode')

/** Read the passcode, creating one the first time. Four digits, evenly drawn. */
export function passcode(): string {
	try {
		const existing = fs.readFileSync(FILE, 'utf8').trim()
		if (/^\d{4}$/.test(existing)) return existing
	} catch {}
	// rejection sampling: `% 10000` over a 16-bit draw would make low codes commoner
	let n = 0
	do {
		n = crypto.randomBytes(2).readUInt16BE(0)
	} while (n >= 60000)
	const code = String(n % 10000).padStart(4, '0')
	try {
		fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
		fs.writeFileSync(FILE, code + '\n', { mode: 0o600 })
	} catch {}
	return code
}

export const passcodePath = () => FILE

const equal = (a: string, b: string) => {
	const x = Buffer.from(a)
	const y = Buffer.from(b)
	return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/* ── sessions ── */

/** Issued on a correct code. A long random value, so the code itself is never
 *  stored in a browser and a stolen cookie can be revoked by restarting. */
const sessions = new Set<string>()

export function issue() {
	const id = crypto.randomBytes(24).toString('base64url')
	sessions.add(id)
	return id
}

export const valid = (id: string | undefined) => !!id && sessions.has(id)

/* ── throttle ── */

type Attempts = { fails: number; until: number }
const byAddress = new Map<string, Attempts>()

const FREE_TRIES = 5
const BASE_LOCK = 15_000

/** How long this address must wait, in ms. Zero means go ahead. */
export function lockedFor(addr: string, now = Date.now()) {
	const a = byAddress.get(addr)
	if (!a) return 0
	return Math.max(0, a.until - now)
}

/**
 * Record an attempt. Doubling from 15s means a patient attacker gets roughly
 * twenty guesses an hour, so ten thousand codes take years rather than seconds.
 */
export function attempt(addr: string, code: string, now = Date.now()) {
	if (lockedFor(addr, now) > 0) return { ok: false, locked: true }
	const good = /^\d{4}$/.test(code) && equal(code, passcode())
	if (good) {
		byAddress.delete(addr)
		return { ok: true, locked: false }
	}
	const a = byAddress.get(addr) ?? { fails: 0, until: 0 }
	a.fails++
	if (a.fails >= FREE_TRIES) {
		const over = a.fails - FREE_TRIES
		a.until = now + Math.min(BASE_LOCK * 2 ** over, 30 * 60_000)
	}
	byAddress.set(addr, a)
	return { ok: false, locked: lockedFor(addr, now) > 0 }
}

/** Tries left before this address is made to wait. */
export function triesLeft(addr: string) {
	const a = byAddress.get(addr)
	return Math.max(0, FREE_TRIES - (a?.fails ?? 0))
}

/** Testing only: forget every recorded attempt. */
export const resetThrottle = () => byAddress.clear()

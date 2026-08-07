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

/**
 * Where settings live — resolved on every call, never captured at import.
 *
 * GUILDHALL_CONFIG_DIR exists so the tests can point somewhere disposable. They
 * could not before, and the suite wrote a passcode into the real config: running
 * `npm test` silently reset whatever code had been chosen, which looked from the
 * outside like the setting refusing to stick. Reading it lazily is the point —
 * an ESM import is hoisted, so a constant computed at module load is fixed before
 * a test file gets the chance to set anything.
 */
const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const file = () => path.join(dir(), 'passcode')

/** Read the passcode, creating one the first time. Four digits, evenly drawn. */
export function passcode(): string {
	try {
		const existing = fs.readFileSync(file(), 'utf8').trim()
		if (/^\d{4}$/.test(existing)) return existing
	} catch {}
	// rejection sampling: `% 10000` over a 16-bit draw would make low codes commoner
	let n = 0
	do {
		n = crypto.randomBytes(2).readUInt16BE(0)
	} while (n >= 60000)
	const code = String(n % 10000).padStart(4, '0')
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), code + '\n', { mode: 0o600 })
	} catch {}
	return code
}

export const passcodePath = () => file()

/**
 * Codes common enough that trying them first beats searching.
 *
 * A random four-digit code is one in ten thousand. A chosen one is not: a small
 * set of codes — runs, repeats, years, keypad shapes — covers a large share of
 * what people actually pick, so an attacker starts there and the throttle buys
 * far less time than it appears to. These are refused rather than warned about,
 * because a warning at the moment of choosing is a warning that gets clicked past.
 */
const WEAK = new Set([
	'0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
	'1234', '2345', '3456', '4567', '5678', '6789', '0123', '9876', '4321', '1230',
	'1212', '1122', '1313', '2020', '2021', '2022', '2023', '2024', '2025', '2026',
	'6969', '1004', '2580', '1379', '0852', '1010', '0007', '1990', '1991', '1992',
	'1993', '1994', '1995', '1996', '1997', '1998', '1999', '2000', '2001', '2002',
])

export type SetResult = { ok: true } | { ok: false; why: string }

/**
 * Choose a new passcode. Every paired device is signed out, because a code you
 * changed that leaves the old phones logged in has not really been changed.
 */
export function setPasscode(code: string): SetResult {
	if (!/^\d{4}$/.test(code)) return { ok: false, why: 'four digits, nothing else' }
	if (WEAK.has(code)) return { ok: false, why: 'too common — a guesser tries that one first' }
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), code + '\n', { mode: 0o600 })
	} catch {
		return { ok: false, why: 'could not write the file' }
	}
	sessions.clear()
	byAddress.clear()
	return { ok: true }
}

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

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
 *  - a THROTTLE, which does nearly all of the work. Five wrong answers from an
 *    address and it waits, doubling each time — about 405 guesses a year. A
 *    random 128-bit token needs no throttle; a chosen phrase is safe only
 *    because of one.
 *  - a LENGTH FLOOR, which does the rest. Eight, chosen by arithmetic against
 *    the throttle rather than by instinct — see MIN_LENGTH.
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
 * Eight characters.
 *
 * Set by arithmetic rather than by reflex. The throttle below allows five free
 * tries and then a doubling wait capped at half an hour, which works out at
 * about 405 guesses a YEAR. Against eight lowercase letters — 2.1e11
 * combinations — that is 260 million years to get halfway. Online guessing is
 * not the threat here, and a longer floor buys nothing against it.
 *
 * It was twelve first, which was over-specified: long enough to be annoying to
 * type on a phone, which is the one place this credential exists to be used.
 *
 * Length still matters for one case: somebody who steals the file and cracks it
 * offline, where the throttle does not apply and only scrypt's cost stands in
 * the way. But reading that file needs read access to the home directory, and
 * anybody who has that already has the SSH keys and the source. The password is
 * not the weak link in that scenario, so it should not be priced as if it were.
 */
export const MIN_LENGTH = 8

/** scrypt cost. N=16384 keeps a single check near 50ms here, which is nothing
 *  for one login and a great deal for anyone trying millions. */
const N = 16384
const KEYLEN = 32

const derive = (pass: string, salt: Buffer) => crypto.scryptSync(pass, salt, KEYLEN, { N, r: 8, p: 1, maxmem: 64 << 20 })

export type SetResult = { ok: true } | { ok: false; why: string }

/**
 * Store a new control passphrase.
 *
 * `live` is required to write the real config, and only the key handler that a
 * person typed into passes it. Any other caller — a benchmark, a throwaway `tsx -e`,
 * anything that merely imports this module — is refused.
 *
 * That guard is here because its absence cost an alarming hour. A one-off script
 * called this to set up a throttle experiment, and because nothing stopped it, it
 * silently replaced the real password with a test string. The only protection at
 * the time was convention: the test files set `GUILDHALL_CONFIG_DIR` to a temp
 * directory before importing. Convention is not a safety mechanism — it protects
 * whoever remembered it and nobody else.
 */
export function setControlPass(pass: string, opts: { live?: boolean } = {}): SetResult {
	// A test or a script pointed at its own directory can write freely; there is no
	// live credential there to lose.
	const sandboxed = !!process.env.GUILDHALL_CONFIG_DIR
	if (!sandboxed && !opts.live) {
		return { ok: false, why: 'refusing to overwrite the real password from a script — pass { live: true } from the key handler, or set GUILDHALL_CONFIG_DIR' }
	}
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

type Attempts = { fails: number; until: number; last: number }

/**
 * On disk, for the same reason the passcode's is: a restart must not forgive an
 * attacker.
 *
 * This one matters more, not less. The passcode guards reading session summaries;
 * this guards typing into every session on the machine. And the process it lives
 * in exits deliberately when it cannot bind — 1,366 restarts in four hours on this
 * machine — so an in-memory count was cleared roughly every ten seconds.
 */
const throttleFile = () => path.join(dir(), 'control-throttle.json')

function loadThrottle(): Map<string, Attempts> {
	try {
		const raw = JSON.parse(fs.readFileSync(throttleFile(), 'utf8')) as Record<string, Attempts>
		const now = Date.now()
		// Forgiveness is applied on read too, so the file does not accumulate every
		// address that ever mistyped.
		return new Map(Object.entries(raw).filter(([, a]) => a.until > now || now - a.last < FORGIVE_MS))
	} catch {
		return new Map()
	}
}

let loaded: Map<string, Attempts> | null = null
/** Lazily loaded, because FORGIVE_MS below is not initialised yet at module top. */
function attempts(): Map<string, Attempts> {
	if (!loaded) loaded = loadThrottle()
	return loaded
}

function saveThrottle() {
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(throttleFile(), JSON.stringify(Object.fromEntries(attempts())), { mode: 0o600 })
	} catch {}
}
const FREE_TRIES = 5
const BASE_LOCK = 15_000
const MAX_LOCK = 30 * 60_000

/**
 * Quiet time after which an address is forgiven and starts over.
 *
 * Without this the count only ever went up: it reset on a correct password and
 * on nothing else, so five fat-fingered attempts spread across a week left the
 * next mistake locked out for the full half hour. An attacker cannot use this —
 * waiting fifteen minutes between guesses is not an online attack, it is four
 * guesses an hour against a phrase with a lot more than four possibilities.
 */
const FORGIVE_MS = 15 * 60_000

/** Milliseconds this address must wait, or 0. */
export function controlLockedFor(addr: string, now = Date.now()) {
	return Math.max(0, (attempts().get(addr)?.until ?? 0) - now)
}

/** Record an attempt and say whether it was right. */
export function controlAttempt(addr: string, offered: string | undefined, now = Date.now()): boolean {
	if (controlLockedFor(addr, now) > 0) return false
	if (controlAllowed(offered)) {
		attempts().delete(addr)
		saveThrottle()
		return true
	}
	const prior = attempts().get(addr)
	// a long quiet spell means the last burst is over; do not hold it against them
	const a = prior && now - prior.last < FORGIVE_MS ? prior : { fails: 0, until: 0, last: now }
	a.fails++
	a.last = now
	if (a.fails >= FREE_TRIES) {
		const over = a.fails - FREE_TRIES
		a.until = now + Math.min(BASE_LOCK * 2 ** over, MAX_LOCK)
	}
	attempts().set(addr, a)
	saveThrottle()
	return false
}

/** Visible for testing. */
export const resetControlThrottle = () => {
	attempts().clear()
	saveThrottle()
}

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

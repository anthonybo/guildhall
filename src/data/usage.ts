/**
 * How much of the plan is left, and what today cost.
 *
 * Both numbers come from outside guildhall — the quota from Anthropic's OAuth
 * usage endpoint, the spend from `ccusage` — so this module is mostly about not
 * asking too often. The approach is lifted from another tool, which learned the
 * expensive parts already:
 *
 * **Every failure path must back off.** Its note is blunt about why:
 * without it the cache is never written, so age stays at maximum, so every render
 * re-spawns the fetch — and that is what got its usage API calls rate-limited.
 * A failure here therefore writes the cache too, with an error and a longer
 * retry.
 *
 * **An error payload is not "no data".** A rate_limit_error must not blank the
 * quota, or a transient blip looks like a plan with nothing left. The last good
 * value is kept and served stale.
 *
 * Cached to disk rather than memory because the terminal, the browser and the
 * menu bar are three processes that each want this, and the whole point is one
 * fetch between them.
 */
import { execFileSync, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** One of the plan's limits: a five-hour window, a weekly one, and so on. */
export type Limit = {
	kind: string
	/** the model this limit is scoped to, when it is scoped to one */
	model?: string
	/** 0 to 100 */
	percent?: number
	/** ISO timestamp when this window rolls over */
	resetsAt?: string
}

export type Usage = {
	limits: Limit[]
	/** when the cost was last fetched; its window is far longer than the quota's */
	costAt?: number
	/** today's spend in dollars, when ccusage could be run */
	cost?: number
	/** when this was fetched */
	at: number
	/** why the last attempt failed, if it did; the numbers above are then stale */
	error?: string
}

/**
 * How long a fetched quota is good for.
 *
 * Five minutes. The windows it describes are five HOURS and a week, so a number
 * five minutes old is not meaningfully wrong, and this is a network call on a
 * machine somebody is trying to work on.
 */
const QUOTA_TTL = 5 * 60_000
/**
 * And after a failure.
 *
 * Deliberately much longer. The failure mode that matters is being rate-limited,
 * and retrying hard is how that happens; there is nothing a person can do with a
 * quota that is thirty seconds fresher.
 */
const QUOTA_BACKOFF = 15 * 60_000
/**
 * Today's spend.
 *
 * Half an hour, because `ccusage` is a Node process that takes about seven
 * seconds — measured — and the number is a running total for a day.
 * Nothing about it needs to be fresher than the time it takes to earn it.
 */
const COST_TTL = 30 * 60_000
const COST_BACKOFF = 60 * 60_000

const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const file = () => path.join(dir(), 'usage.json')

function read(): Usage | null {
	try {
		return JSON.parse(fs.readFileSync(file(), 'utf8')) as Usage
	} catch {
		return null
	}
}

function write(u: Usage) {
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), JSON.stringify(u), { mode: 0o600 })
	} catch {}
}

/**
 * The OAuth token Claude Code already holds.
 *
 * Keychain first, since that is where Claude Code puts it on macOS, falling back
 * to the credentials file for machines without one. Read at the moment it is
 * needed and never stored anywhere by guildhall — it is somebody else's
 * credential and this only borrows it to ask about its own account.
 */
function token(): string | null {
	try {
		const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 4000,
		})
		const t = JSON.parse(out)?.claudeAiOauth?.accessToken
		if (typeof t === 'string' && t) return t
	} catch {}
	try {
		const body = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')
		const t = JSON.parse(body)?.claudeAiOauth?.accessToken
		if (typeof t === 'string' && t) return t
	} catch {}
	return null
}

/** Flatten the API's `limits[]` into the few fields worth showing. */
function limitsOf(payload: unknown): Limit[] {
	const list = (payload as { limits?: unknown[] })?.limits
	if (!Array.isArray(list)) return []
	return list.map((raw) => {
		const e = raw as Record<string, unknown>
		const scope = e.scope as { model?: { display_name?: string } } | undefined
		return {
			kind: typeof e.kind === 'string' ? e.kind : 'unknown',
			model: scope?.model?.display_name,
			percent: typeof e.percent === 'number' ? e.percent : undefined,
			resetsAt: typeof e.resets_at === 'string' ? e.resets_at : undefined,
		}
	})
}

let inFlight: Promise<unknown> | null = null

/**
 * The two halves, each behind its own window.
 *
 * They were one function, and that coupled them: a rate-limited quota returned
 * early and the daily cost — which ccusage reads out of local files and could not
 * care less about Anthropic's rate limiter — went unfetched for the whole fifteen
 * minute backoff. Separate sources, separate windows, and one failing must not
 * silence the other.
 */
function both(): Promise<unknown> {
	return Promise.allSettled([maybeQuota(), maybeCost()])
}

/** Fresh enough to leave alone? Backoff applies when the last try failed. */
function fresh(u: Usage | null, ttl: number, backoff: number): boolean {
	if (!u) return false
	return Date.now() - u.at <= (u.error ? backoff : ttl)
}

/**
 * Fetch now and wait for it, for callers that have nothing to render.
 *
 * `usage()` deliberately never blocks, which is right for a server answering a
 * request and useless for a one-shot command whose job is to refresh the file.
 *
 * It respects the same windows. It did not, and that is how repeated manual runs
 * walked into a rate limit that then persisted: a command which refetches on every
 * invocation has no backoff at all, whatever the cache says.
 */
export async function fetchNow(): Promise<Usage | null> {
	await (inFlight ?? (inFlight = both().finally(() => (inFlight = null))))
	return read()
}

/**
 * The cached usage, refreshing in the background when it is old.
 *
 * Never awaits the network: a caller asking for this is rendering something, and
 * a status panel that blocks on a third-party API is a status panel that hangs
 * when the API does. The first call after a cold start therefore returns nothing
 * and the second returns numbers, which is the right trade for a value that
 * describes a five-hour window.
 */
export function usage(): Usage | null {
	if (!inFlight) inFlight = both().finally(() => (inFlight = null))
	return read()
}

/** The plan quota, from Anthropic. */
async function maybeQuota() {
	const previous = read()
	if (fresh(previous, QUOTA_TTL, QUOTA_BACKOFF)) return
	const t = token()
	if (!t) {
		// No token is a settled fact, not a transient failure: nothing will change
		// until Claude Code is signed in, so record it and stop asking.
		write({ ...(previous ?? { limits: [] }), limits: previous?.limits ?? [], at: Date.now(), error: 'not signed in to Claude' })
		return
	}
	try {
		const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
			headers: { authorization: `Bearer ${t}`, 'anthropic-beta': 'oauth-2025-04-20' },
			signal: AbortSignal.timeout(8000),
		})
		const body = (await res.json()) as Record<string, unknown>
		const current = read()
		if (body.error || !res.ok) {
			// Keep the numbers, note the failure. A rate_limit_error is the one thing
			// this must not turn into "your plan has nothing left".
			write({ limits: current?.limits ?? [], cost: current?.cost, at: Date.now(), error: String((body.error as { message?: string })?.message ?? res.status) })
			return
		}
		write({ limits: limitsOf(body), cost: current?.cost, at: Date.now() })
	} catch (e) {
		const current = read()
		write({ limits: current?.limits ?? [], cost: current?.cost, at: Date.now(), error: e instanceof Error ? e.message : 'failed' })
	}
}

/** Today's spend, from ccusage, on its own much longer window. */
async function maybeCost() {
	const previous = read()
	// Its own clock: `costAt`, not the quota's `at`, or a quota refresh every five
	// minutes would keep declaring the cost fresh and it would never be fetched.
	const age = previous?.costAt ? Date.now() - previous.costAt : Infinity
	if (age <= (previous?.cost === undefined ? COST_BACKOFF : COST_TTL)) return
	await spend()
}

/**
 * Today's spend, via ccusage.
 *
 * Not bundled and not a dependency: it is run through `bunx`/`npx` the way
 * that tool does it, bun first because it starts in a few hundred milliseconds
 * where npx takes seconds. If neither exists the cost is simply absent, which is
 * better than a wrong number and better than a dependency this project would
 * then have to carry.
 */
function spend(): Promise<void> {
	const runners = ['bunx', 'npx']
	let settle: () => void = () => {}
	const done = new Promise<void>((r) => (settle = r))
	// The LOCAL date, assembled by hand.
	//
	// `toISOString()` is UTC, and this was written with it: after 5pm in a US timezone
	// that asks ccusage for tomorrow, which has no usage in it yet, so the day's
	// spend came back as exactly zero while the real figure was not. A wrong
	// number that looks like a plausible number, for seven hours out of every
	// twenty-four.
	const d = new Date()
	const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
	const tryNext = (i: number) => {
		if (i >= runners.length) return settle()
		execFile(runners[i]!, ['-y', 'ccusage', 'daily', '--json', '--since', today], { timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout) => {
			if (err || !stdout) return tryNext(i + 1)
			try {
				const total = JSON.parse(stdout)?.totals?.totalCost
				const current = read()
				// Stamped even when ccusage gave nothing usable, so a machine without a
				// runner does not retry a slow spawn every five minutes forever.
				write({
					limits: current?.limits ?? [],
					cost: typeof total === 'number' ? total : current?.cost,
					costAt: Date.now(),
					at: current?.at ?? Date.now(),
					error: current?.error,
				})
			} catch {}
			settle()
		})
	}
	tryNext(0)
	return done
}

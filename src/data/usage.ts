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

let inFlight: Promise<void> | null = null

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
	const cached = read()
	const age = cached ? Date.now() - cached.at : Infinity
	const stale = age > (cached?.error ? QUOTA_BACKOFF : QUOTA_TTL)
	if (stale && !inFlight) inFlight = refresh().finally(() => (inFlight = null))
	return cached
}

async function refresh() {
	const previous = read()
	const t = token()
	if (!t) {
		// No token is a settled fact, not a transient failure: nothing will change
		// until Claude Code is signed in, so record it and stop asking.
		write({ limits: previous?.limits ?? [], cost: previous?.cost, at: Date.now(), error: 'not signed in to Claude' })
		return
	}
	try {
		const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
			headers: { authorization: `Bearer ${t}`, 'anthropic-beta': 'oauth-2025-04-20' },
			signal: AbortSignal.timeout(8000),
		})
		const body = (await res.json()) as Record<string, unknown>
		if (body.error || !res.ok) {
			// Keep the numbers, note the failure. A rate_limit_error is the one thing
			// this must not turn into "your plan has nothing left".
			write({ limits: previous?.limits ?? [], cost: previous?.cost, at: Date.now(), error: String((body.error as { message?: string })?.message ?? res.status) })
			return
		}
		write({ limits: limitsOf(body), cost: previous?.cost, at: Date.now() })
	} catch (e) {
		write({ limits: previous?.limits ?? [], cost: previous?.cost, at: Date.now(), error: e instanceof Error ? e.message : 'failed' })
		return
	}
	// Spend is fetched only after the quota succeeded, and only when its own, much
	// longer window has passed. It is the expensive half — about seven seconds of
	// Node — and it is a running daily total, so it is never the urgent number.
	const now = read()
	const costAge = now?.cost === undefined ? Infinity : Date.now() - (now.at ?? 0)
	if (costAge > (now?.error ? COST_BACKOFF : COST_TTL)) void spend()
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
function spend() {
	const runners = ['bunx', 'npx']
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
		if (i >= runners.length) return
		execFile(runners[i]!, ['-y', 'ccusage', 'daily', '--json', '--since', today], { timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout) => {
			if (err || !stdout) return tryNext(i + 1)
			try {
				const total = JSON.parse(stdout)?.totals?.totalCost
				if (typeof total === 'number') {
					const current = read()
					write({ limits: current?.limits ?? [], cost: total, at: current?.at ?? Date.now(), error: current?.error })
				}
			} catch {}
		})
	}
	tryNext(0)
}

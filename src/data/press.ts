/**
 * What has been committed and deployed, from pressroom.
 *
 * guildhall watches sessions; pressroom watches repositories. They answer
 * different halves of the same question — what is being worked on, and what came
 * out of it — so this brings the second half into the browser view rather than
 * making you keep two terminals.
 *
 * It shells out to `pressroom --json` instead of importing pressroom's engine.
 * That engine is nine files of git plumbing, `gh` handling and wrangler
 * invocation, and a copy of it here would be a second copy to keep correct. The
 * seam is a JSON contract instead, which is the same arrangement guildhall
 * already has with `cmux` and `claude`.
 *
 * Two speeds, because the cost is wildly lopsided. The local read — commits and
 * pushes, git only — takes about 2 seconds for 32 repositories. Adding workflow
 * runs and Cloudflare deploys takes about 17, because every Worker repo spawns
 * its own wrangler at roughly 1.7s a time, two at once. So local is the default
 * and refreshes freely; deploys are fetched only when something asks for them.
 */
import { execFile } from 'node:child_process'
import type { PressItem, PressSnapshot } from './types.ts'

/** Generous: the local read measures ~2s, but a cold page cache is much slower. */
const LOCAL_TIMEOUT = 45_000

/** The full read measures ~17s here and is dominated by wrangler process starts. */
const FULL_TIMEOUT = 90_000

/** How long a local answer stays good. Commits do not land faster than this. */
const LOCAL_TTL = 30_000

/** Deploys are expensive and rare; asking every half minute would be absurd. */
const FULL_TTL = 5 * 60_000

/** Newest items served. The raw snapshot runs to ~950KB, which is not a payload. */
const KEEP = 150

type Cached = { at: number; snap: PressSnapshot }

const cache = new Map<'local' | 'full', Cached>()
const inFlight = new Set<'local' | 'full'>()

function run(full: boolean): Promise<PressSnapshot> {
	const args = ['--json']
	if (!full) args.push('--local')
	return new Promise((resolve) => {
		execFile('pressroom', args, { timeout: full ? FULL_TIMEOUT : LOCAL_TIMEOUT, maxBuffer: 64 << 20, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				const detail = (stderr || err.message || 'pressroom failed').trim().split('\n')[0] ?? 'pressroom failed'
				// ENOENT is the interesting one and deserves an answer rather than a
				// stack trace: pressroom is a separate tool and may simply not be here.
				const missing = /ENOENT|not found/i.test(detail)
				return resolve({ at: Date.now(), items: [], repos: 0, local: !full, error: missing ? 'pressroom is not installed — `npm link` it from ~/projects/pressroom' : detail.slice(0, 200) })
			}
			try {
				resolve(shape(JSON.parse(stdout), full))
			} catch {
				resolve({ at: Date.now(), items: [], repos: 0, local: !full, error: 'pressroom returned something unreadable' })
			}
		})
	})
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0)

/**
 * pressroom's snapshot, trimmed to what a browser can use.
 *
 * Commit bodies and file lists are dropped: they are most of the 950KB and none
 * of the timeline. The four kinds stay separate rather than being flattened into
 * one wide row, because almost nothing is shared — a push has no author or diff,
 * a deploy has no commit at all.
 */
function shape(raw: any, full: boolean): PressSnapshot {
	if (raw?.version !== 1) return { at: Date.now(), items: [], repos: 0, local: !full, error: `unknown pressroom schema (version ${raw?.version})` }
	const items: PressItem[] = []
	for (const c of raw.commits ?? []) items.push({ kind: 'commit', repo: c.repo, at: ms(c.committed), short: c.short, subject: c.subject, author: c.author, files: c.files, insertions: c.insertions, deletions: c.deletions })
	for (const p of raw.pushes ?? []) items.push({ kind: 'push', repo: p.repo, at: ms(p.at), short: p.short, remote: p.remote, branch: p.branch, count: p.count, forced: p.forced })
	for (const r of raw.runs ?? []) items.push({ kind: 'run', repo: r.repo, at: ms(r.updatedAt) || ms(r.startedAt), short: r.short, workflow: r.workflow, branch: r.branch, status: r.status, conclusion: r.conclusion, url: r.url, durationMs: r.durationMs })
	for (const d of raw.deploys ?? []) items.push({ kind: 'deploy', repo: d.repo, at: ms(d.at), worker: d.worker, hostname: d.hostname, env: d.env, source: d.source })
	items.sort((a, b) => b.at - a.at)
	return {
		at: Date.now(),
		items: items.slice(0, KEEP),
		repos: (raw.repos ?? []).length,
		local: !!raw.local,
		githubError: raw.githubError ?? undefined,
		cloudflareError: raw.cloudflareError ?? undefined,
	}
}

/**
 * The current answer, refreshing behind your back when it has gone stale.
 *
 * Never waits for a refresh it did not have to start. A 17-second full read must
 * not become 17 seconds of a spinning browser, so a stale-but-real answer is
 * served immediately and the fresh one arrives on the next poll. Only the very
 * first call has nothing to hand back and has to wait.
 */
export async function press(full = false): Promise<PressSnapshot> {
	const key = full ? 'full' : 'local'
	const held = cache.get(key)
	const stale = !held || Date.now() - held.at > (full ? FULL_TTL : LOCAL_TTL)
	if (stale && !inFlight.has(key)) {
		inFlight.add(key)
		const job = run(full).then((snap) => {
			cache.set(key, { at: Date.now(), snap })
			inFlight.delete(key)
			return snap
		})
		// nothing cached yet, so there is no stale answer to prefer over waiting
		if (!held) return job
	}
	return held ? held.snap : { at: Date.now(), items: [], repos: 0, local: !full, error: 'still reading' }
}

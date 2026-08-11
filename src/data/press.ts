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
import type { PressItem, PressRepo, PressSnapshot } from './types.ts'

/** Generous: the local read measures ~2s, but a cold page cache is much slower. */
const LOCAL_TIMEOUT = 45_000

/** The full read measures ~17s here and is dominated by wrangler process starts. */
const FULL_TIMEOUT = 90_000

/** How long a local answer stays good. Commits do not land faster than this. */
const LOCAL_TTL = 30_000

/** Deploys are expensive and rare; asking every half minute would be absurd. */
const FULL_TTL = 5 * 60_000

/**
 * Newest items served. The raw snapshot runs to ~950KB, which is not a payload.
 *
 * 600 to match pressroom's own `DEFAULT_CAP`, because "the same as the terminal"
 * is the whole point of this view. At 150 the cap was silently a different
 * product: a global newest-first slice, so two busy repositories — guildhall with
 * 50 events and tidepool with 44 — crowded the feed down to 8 of 32 repos, and
 * everything else looked like it had never been committed to. The terminal reads
 * 40 commits per repo and keeps 600, which is why it showed work this did not.
 */
const KEEP = 600

/** A failure is remembered only briefly: a `gh` blip must not outlive its cause. */
const ERROR_TTL = 15_000

/** `until`, not `at`: an error and a success do not deserve the same shelf life. */
type Cached = { until: number; snap: PressSnapshot }

const cache = new Map<'local' | 'full', Cached>()
const inFlight = new Set<'local' | 'full'>()

/**
 * Why a read failed, in words, from the error object rather than from stderr.
 *
 * This used to regex the first line of stderr for /ENOENT|not found/, which got
 * the common case right and two others wrong: a missing `gh` or `wrangler` says
 * "command not found" and was reported as "pressroom is not installed", and a
 * killed process reported only "Command failed". `err.code` and `err.killed` say
 * what actually happened, so they are consulted first.
 */
function why(err: { code?: string | number; killed?: boolean; message?: string }, stderr: string, full: boolean) {
	if (err.code === 'ENOENT') return 'pressroom is not installed — `npm link` it from ~/projects/pressroom'
	if (err.killed) return `pressroom took longer than ${Math.round((full ? FULL_TIMEOUT : LOCAL_TIMEOUT) / 1000)}s and was stopped`
	const lines = stderr
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
	// The LAST line, not the first: pressroom writes progress to stderr, and the
	// first line was masking the actual failure underneath it.
	const detail = lines[lines.length - 1] || err.message || 'pressroom failed'
	return detail.slice(0, 200)
}

function run(full: boolean): Promise<PressSnapshot> {
	const args = ['--json']
	if (!full) args.push('--local')
	return new Promise((resolve) => {
		execFile('pressroom', args, { timeout: full ? FULL_TIMEOUT : LOCAL_TIMEOUT, maxBuffer: 64 << 20, windowsHide: true }, (err, stdout, stderr) => {
			if (err) return resolve({ at: Date.now(), items: [], repos: [], local: !full, error: why(err, stderr, full) })
			try {
				resolve(shape(JSON.parse(stdout), full))
			} catch {
				// A timeout can also land here: node destroys the pipes, so the callback
				// arrives with err null and stdout truncated. Say so rather than blaming
				// pressroom's output format.
				resolve({ at: Date.now(), items: [], repos: [], local: !full, error: stdout.length ? 'pressroom returned something unreadable' : 'pressroom returned nothing' })
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
	if (raw?.version !== 1) return { at: Date.now(), items: [], repos: [], local: !full, error: `unknown pressroom schema (version ${raw?.version})` }
	const items: PressItem[] = []
	for (const c of raw.commits ?? []) items.push({ kind: 'commit', repo: c.repo, at: ms(c.committed), short: c.short, subject: c.subject, author: c.author, files: c.files, insertions: c.insertions, deletions: c.deletions })
	for (const p of raw.pushes ?? []) items.push({ kind: 'push', repo: p.repo, at: ms(p.at), short: p.short, remote: p.remote, branch: p.branch, count: p.count, forced: p.forced })
	for (const r of raw.runs ?? []) items.push({ kind: 'run', repo: r.repo, at: ms(r.updatedAt) || ms(r.startedAt), short: r.short, workflow: r.workflow, branch: r.branch, status: r.status, conclusion: r.conclusion, url: r.url, durationMs: r.durationMs })
	for (const d of raw.deploys ?? []) items.push({ kind: 'deploy', repo: d.repo, at: ms(d.at), worker: d.worker, hostname: d.hostname, env: d.env, source: d.source })
	items.sort((a, b) => b.at - a.at)

	// The newest run and the newest deploy per repo. Both, side by side: a run has
	// an outcome and a Cloudflare deploy does not, and a repo can be green-and-live,
	// red-and-live (the failure came after), or live with no pipeline at all —
	// several here deploy straight from the laptop with wrangler.
	const newestRun = new Map<string, any>()
	const newestDeploy = new Map<string, any>()
	for (const r of raw.runs ?? []) {
		const at = ms(r.updatedAt) || ms(r.startedAt)
		const held = newestRun.get(r.repo)
		if (!held || at > held.at) newestRun.set(r.repo, { at, run: r })
	}
	for (const d of raw.deploys ?? []) {
		const at = ms(d.at)
		const held = newestDeploy.get(d.repo)
		if (!held || at > held.at) newestDeploy.set(d.repo, { at, deploy: d })
	}

	const statuses = raw.statuses ?? {}
	const errors = raw.errors ?? {}
	const lastCommit = new Map<string, number>()
	for (const c of raw.commits ?? []) {
		const at = ms(c.committed)
		if (at > (lastCommit.get(c.repo) ?? 0)) lastCommit.set(c.repo, at)
	}

	const repos: PressRepo[] = (raw.repos ?? []).map((r: any) => {
		const st = statuses[r.label] ?? {}
		const run = newestRun.get(r.label)?.run
		const dep = newestDeploy.get(r.label)?.deploy
		return {
			label: r.label,
			branch: st.branch ?? undefined,
			upstream: st.upstream ?? null,
			ahead: st.ahead ?? 0,
			behind: st.behind ?? 0,
			changed: st.changed ?? 0,
			untracked: st.untracked ?? 0,
			unborn: !!st.unborn,
			ci: run ? { conclusion: run.conclusion ?? null, status: run.status, workflow: run.workflow, url: run.url } : undefined,
			live: dep ? { hostname: dep.hostname ?? null, worker: dep.worker, rollback: /rollback/i.test(String(dep.triggeredBy ?? '')), at: ms(dep.at) } : undefined,
			lastCommitAt: lastCommit.get(r.label),
			error: st.error ?? errors[r.label] ?? undefined,
		}
	})
	// Anything with work that exists nowhere else first, then by recency. The panel
	// is read top-down and the interesting rows must not be buried in alphabetical
	// order among thirty repositories that have nothing to report.
	repos.sort((a, b) => Number(!!b.ahead) - Number(!!a.ahead) || b.changed - a.changed || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0) || a.label.localeCompare(b.label))

	return {
		at: Date.now(),
		items: items.slice(0, KEEP),
		repos,
		local: !!raw.local,
		githubError: raw.githubError ?? undefined,
		cloudflareError: raw.cloudflareError ?? undefined,
	}
}

/**
 * The current answer. Always immediate — it never waits for a read.
 *
 * The old version claimed as much and only delivered it per cache key. `local` and
 * `full` are separate entries, and a request for `full` consulted only `full`: so
 * the FIRST `?deploys=1` after every process start returned the unresolved 17-90s
 * promise while a complete `local` snapshot sat in the other slot, unused. And the
 * browser remembers the deploys choice per device, so one person's panel took two
 * seconds and another's took ninety — the classic "works on my machine", with the
 * difference stored in someone else's localStorage.
 *
 * Now nothing blocks. A read is kicked off when the answer is stale, and the
 * caller gets, in order of preference: this key's answer, the other key's answer,
 * or an empty one flagged `loading` so the client can say "reading" and poll
 * faster until it lands. A full read also warms `local`, since it computed every
 * local fact on the way.
 */
export async function press(full = false): Promise<PressSnapshot> {
	const key = full ? 'full' : 'local'
	const held = cache.get(key)
	if ((!held || Date.now() > held.until) && !inFlight.has(key)) {
		inFlight.add(key)
		// `finally` rather than deleting in `then`: if the body ever threw, the key
		// stayed in flight forever and this function could never refresh it again —
		// the whole feature dead for the life of the process. The `catch` is there for
		// the same reason, since an unhandled rejection takes the terminal app down
		// with it under node's defaults.
		void run(full)
			.then((snap) => {
				const ttl = snap.error ? ERROR_TTL : full ? FULL_TTL : LOCAL_TTL
				cache.set(key, { until: Date.now() + ttl, snap })
				// A full read already did the local work; warming both means toggling
				// deploys back off does not pay a second cold start.
				if (full && !snap.error) cache.set('local', { until: Date.now() + LOCAL_TTL, snap })
			})
			.catch(() => {})
			.finally(() => inFlight.delete(key))
	}
	// A cold full read leaves nothing to show for ~26 seconds, so start the cheap one
	// alongside it. The local half is 2 seconds of git and answers the same feed; the
	// deploys arrive later and fill in. Without this, asking for more information got
	// you less of it for half a minute.
	if (full && !cache.has('local') && !inFlight.has('local')) void press(false)

	if (held) return held.snap
	// Whatever the other read knows is a great deal better than nothing: the feed is
	// identical either way, and only the runs and deploys are missing.
	const other = cache.get(full ? 'local' : 'full')
	if (other) return { ...other.snap, loading: true }
	// Deliberately NOT an `error`. "still reading" went out in the error field, and
	// the client treats any error as terminal — so a poll that landed during a read
	// wiped the panel to two muted words instead of saying it was still working.
	return { at: Date.now(), items: [], repos: [], local: !full, loading: true }
}

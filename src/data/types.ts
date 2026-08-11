/** The shape the rest of the app consumes. Everything here is derived, never raw. */

/**
 * Whose turn it is, not what Claude Code's instantaneous flag says.
 *
 * `needs` and `review` both mean the next move is yours; `working` and `shell`
 * mean it is not. That distinction is the whole point of the app, so it is a
 * derived state rather than a passthrough of the registry's `status`.
 */
export type State = 'error' | 'needs' | 'working' | 'shell' | 'review' | 'done' | 'parked'

/** Sort weight for state. Lower is more urgent; used for stable ordering. */
export const RANK: Record<State, number> = { error: 0, needs: 1, working: 2, shell: 3, review: 4, done: 5, parked: 6 }

export type Session = {
	id: string
	pid: number
	name: string
	proj: string
	/**
	 * Where the work currently is, when that is not `proj`.
	 *
	 * Set while a session is working in another project but has not been there
	 * long enough to be renamed, so a row can say `guildhall → pressroom` instead
	 * of silently becoming a different-looking session. See settle.ts.
	 */
	away?: string
	/**
	 * A short discriminator, set only when another live session shares this name.
	 *
	 * Three sessions can legitimately resolve to `tidepool` — one living in the
	 * directory and two rooted at the container whose tool calls keep touching it —
	 * and three identical rows with no way to tell them apart is a list you cannot
	 * act on. Absent for the overwhelmingly common case of one session per project,
	 * so nothing is decorated that does not need to be.
	 */
	distinct?: string
	cwd: string
	state: State
	/** why it is blocked, when it is: "permission prompt", "input needed", … */
	waitingFor?: string
	stale: number
	title: string
	doing: string
	/** a few words for the in-world label; the table shows the full detail */
	short: string
	last: string
	ctxUsed: number
	ctxLimit: number
	tab?: number
	/** cmux workspace UUID, the only safe way to address this session's terminal.
	 *  Absent unless cmux is running and the session is in one of its tabs. */
	workspace?: string
	unread: boolean
	/** which character sheet, and how far its hue is rotated, for identity */
	palette: number
	hueShift: number
	/** broad class of the current tool, for tinting the screen */
	toolKind: 'edit' | 'read' | 'run' | 'search' | 'agent' | 'think'
	/** turns this session has completed — the work it has actually done */
	turns: number
	/** derived rank, from work done — see xpOf */
	level: number
	/** raw score behind `level`, kept so progress within a rank is visible */
	xp: number
	/** subagents out and dispatched, in words, when there are any */
	agents?: string
}

/** What one poll of a transcript yields, before it becomes a `Session`. */
export type Digest = {
	commits?: number
	edits?: number
	activeMin?: number
	subs?: number
	title?: string
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
	tool?: string
	toolInput?: unknown
	text?: string
	lastTs?: number
	subProj?: string
	turns?: number
	/** subagents still running, from turn_duration's own count */
	pending?: number
	failed?: boolean
	asked?: boolean
}

/**
 * One thing that happened to a repository, from pressroom.
 *
 * Four kinds on one timeline, kept separate rather than widened into a single
 * row: a push has no author and no diff, a deploy has no commit at all, and a
 * run is the only one that changes after it appears.
 */
export type PressItem =
	| { kind: 'commit'; repo: string; at: number; short: string; subject: string; author: string; files: number; insertions: number; deletions: number }
	| { kind: 'push'; repo: string; at: number; short: string; remote: string; branch: string; count: number | null; forced: boolean }
	| { kind: 'run'; repo: string; at: number; short: string; workflow: string; branch: string; status: string; conclusion: string | null; url: string; durationMs: number | null }
	| { kind: 'deploy'; repo: string; at: number; worker: string; hostname: string | null; env: string | null; source: string }

/**
 * A repository as the panel above the feed shows it.
 *
 * `ahead` is the number that earns its place: every project here deploys by
 * pushing, so three commits ahead of the upstream is three commits of work that
 * exist on this laptop and nowhere else. That is the single most useful thing a
 * glance at this can tell you, and it is what the web view was missing entirely.
 */
export type PressRepo = {
	label: string
	branch?: string
	/** Null upstream means nothing to be ahead OF, which is worth saying out loud. */
	upstream?: string | null
	ahead: number
	behind: number
	/** Tracked files with any change at all, counted once each. */
	changed: number
	untracked: number
	/** Before the first commit, when there is no HEAD to compare against. */
	unborn?: boolean
	/** Newest workflow run for this repo: did the pipeline pass. */
	ci?: { conclusion: string | null; status: string; workflow: string; url: string }
	/** Newest Cloudflare deploy: is it live, and was it a rollback. */
	live?: { hostname: string | null; worker: string; rollback: boolean; at: number }
	/** Commit date of the newest commit, for ordering and for the age column. */
	lastCommitAt?: number
	/** git failed for this repo — shown in place of the numbers rather than thrown. */
	error?: string
}

export type PressSnapshot = {
	at: number
	items: PressItem[]
	/** The panel above the feed. Was a bare count, which said nothing. */
	repos: PressRepo[]
	/** True when runs and deploys were never asked for, rather than absent. */
	local: boolean
	githubError?: string
	cloudflareError?: string
	error?: string
	/**
	 * A read is in flight and this is the best answer so far.
	 *
	 * Distinct from `error`, which is terminal and empties the view. Before this
	 * existed, "still reading" was sent as an error and a poll arriving mid-read
	 * wiped the panel — a working request presented as a failure.
	 */
	loading?: boolean
}

/** A registry entry exactly as Claude Code writes it. */
export type Registry = {
	pid: number
	sessionId: string
	cwd: string
	name?: string
	nameSource?: string
	status?: string
	waitingFor?: string
	startedAt?: number
	procStart?: string
	updatedAt?: number
	statusUpdatedAt?: number
	kind?: string
}

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

/**
 * Everything guildhall knows, read straight off disk. Nothing is installed and
 * no session is instrumented — Claude Code already writes a registry entry per
 * running process, and cmux already writes its window layout.
 */
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assignLooks } from './characters.ts'

const HOME = os.homedir()
const SESS_DIR = path.join(HOME, '.claude', 'sessions')
const PROJ_DIR = path.join(HOME, '.claude', 'projects')
const CMUX_STATE = path.join(HOME, 'Library/Application Support/cmux/session-com.cmuxterm.app.json')

/**
 * A session in a long turn — subagents, a slow build — legitimately shows a
 * `busy` stamp that is many minutes old, because the registry only writes on a
 * state CHANGE, never as a heartbeat. So `busy` is trusted unless the status
 * stamp AND the transcript have both gone quiet, which is what a session killed
 * mid-turn looks like.
 */
const ZOMBIE_WINDOW = 45 * 60_000
/** Finished inside this window means the next move is still yours. */
const DONE_WINDOW = 30 * 60_000

export type State = 'error' | 'needs' | 'working' | 'shell' | 'review' | 'done' | 'parked'
/**
 * Four signals, weighted by how much each one proves.
 *
 *   commits  25  a delivered milestone — the strongest evidence of finished work
 *   edits     3  a file actually changed
 *   subagents 15 work dispatched and supervised
 *   minutes    1 time genuinely spent working, summed from turn durations
 *
 * Commits are weighted highest but cannot be the base: three of the busiest
 * sessions here have zero, because commits happen only when you ask for one, so
 * they measure your instructions rather than the session's work.
 *
 * Active minutes come from per-turn durations, never from wall-clock age — a
 * session left open overnight has done nothing and must score nothing.
 *
 * Token counts are deliberately excluded: most tokens in agentic work go to
 * reading and review rather than production, so counting them repeats the
 * lines-of-code mistake.
 */
export function xpOf(d: { commits?: number; edits?: number; subs?: number; activeMin?: number }) {
	return 25 * (d.commits ?? 0) + 3 * (d.edits ?? 0) + 15 * (d.subs ?? 0) + (d.activeMin ?? 0)
}

/**
 * Level n costs n^3 / 3 XP.
 *
 * Both earlier attempts fitted the curve to a snapshot of the current sessions,
 * which is the wrong anchor: what decides whether a ceiling is reachable is how
 * fast a session accumulates. Measured over real transcript lifetimes, the
 * heaviest session here sustains ~572 XP/day. Anchoring to that rate:
 *
 *     1 day -> 11    1 month -> 37    6 months -> 67    ~1.5 years -> 99
 *     1 week -> 22   3 months -> 53   1 year -> 85
 *
 * A cube root is what satisfies both ends — plain n^3 had the right shape and the
 * wrong scale, reading 19 where it should read 27. Dividing by 3 fixes the scale
 * without flattening the curve into the no-headroom quadratic that replaced it.
 */
export const xpForLevel = (n: number) => n ** 3 / 3
export const levelFor = (xp: number) => Math.max(1, Math.min(99, Math.floor(Math.cbrt(xp * 3))))

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
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/**
 * Process start times, so a recycled PID can't masquerade as a live session.
 *
 * Cached per PID for the life of the run: a process's start time is fixed, and
 * `ps -o lstart` costs 161ms for ten PIDs — by far the most expensive thing in a
 * poll that runs every two seconds. Only genuinely new PIDs are ever looked up,
 * so a steady set of sessions costs nothing. Liveness is separate and free
 * (`kill(pid, 0)`), so a process that exits is still noticed immediately.
 */
const startCache = new Map<number, string>()

function procStarts(pids: number[]) {
	const m = new Map<number, string>()
	if (!pids.length) return m
	for (const p of pids) {
		const hit = startCache.get(p)
		if (hit !== undefined) m.set(p, hit)
	}
	const missing = pids.filter((p) => !startCache.has(p))
	if (!missing.length) return m
	pids = missing
	try {
		const out = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		for (const line of out.split('\n')) {
			const t = line.trim()
			if (!t) continue
			const sp = t.indexOf(' ')
			const pid = Number(t.slice(0, sp))
			const started = t.slice(sp + 1).trim()
			m.set(pid, started)
			startCache.set(pid, started)
		}
	} catch {}
	// a PID `ps` did not report is gone; remember that too, or every poll re-asks
	for (const p of pids) if (!m.has(p)) startCache.set(p, '')
	return m
}

type Registry = {
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

export function liveSessions(): Registry[] {
	let files: string[] = []
	try {
		files = fs.readdirSync(SESS_DIR)
	} catch {
		return []
	}
	const found: Registry[] = []
	for (const f of files) {
		if (!/^\d+\.json$/.test(f)) continue
		try {
			const d = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8')) as Registry
			if (d.pid && isAlive(d.pid)) found.push(d)
		} catch {}
	}
	const starts = procStarts(found.map((d) => d.pid))
	return found.filter((d) => {
		const lstart = starts.get(d.pid)
		if (!lstart) return true // ps said nothing; do not drop a session over it
		const psEpoch = Date.parse(lstart) // ps prints local time
		// procStart is stamped in UTC, so never string-compare the two. startedAt
		// is a plain epoch and needs no timezone reasoning at all.
		const fileEpoch = d.startedAt || Date.parse(`${d.procStart} UTC`)
		if (!psEpoch || !fileEpoch || Number.isNaN(psEpoch) || Number.isNaN(fileEpoch)) return true
		return Math.abs(psEpoch - fileEpoch) < 5 * 60_000
	})
}

export function transcriptIndex() {
	const idx = new Map<string, string>()
	let dirs: string[] = []
	try {
		dirs = fs.readdirSync(PROJ_DIR)
	} catch {
		return idx
	}
	for (const d of dirs) {
		const p = path.join(PROJ_DIR, d)
		let files: string[] = []
		try {
			files = fs.readdirSync(p)
		} catch {
			continue
		}
		for (const f of files) {
			if (!f.endsWith('.jsonl')) continue
			const id = f.slice(0, -6)
			const full = path.join(p, f)
			// A session that moves directory keeps its id and gets a second transcript
			// under the new project slug, so the same id can appear in several dirs.
			// Blindly overwriting picked whichever came last in readdir order, which
			// pointed the busiest session here at a transcript abandoned nine days
			// earlier — wrong activity text, wrong lifetime totals. Newest wins.
			const prev = idx.get(id)
			if (prev && mtime(prev) >= mtime(full)) continue
			idx.set(id, full)
		}
	}
	return idx
}

/** Uncached on purpose: this is reached only when two directories hold the same
 *  session id, and a cached mtime would freeze that choice as the files grow. */
function mtime(f: string) {
	try {
		return fs.statSync(f).mtimeMs
	} catch {
		return 0
	}
}

/**
 * Lifetime work counters, advanced incrementally.
 *
 * These have to be exact totals rather than a sample of the tail, and the largest
 * transcript here is 171MB — 1.2s to parse in full, which cannot happen on a two
 * second poll. Transcripts are append-only, so keep the byte offset reached last
 * time and parse only what has been added since. The full pass happens once.
 */
type Ledger = { off: number; tail: string; commits: number; edits: number; activeMs: number }
const ledgers = new Map<string, Ledger>()
const blank = (): Ledger => ({ off: 0, tail: '', commits: 0, edits: 0, activeMs: 0 })

function tally(L: Ledger, line: string) {
	// Substring prefilter first: JSON.parse on every record of a 171MB transcript
	// is essentially the entire cost of this function.
	if (line.length < 40) return
	if (!line.includes('durationMs') && !line.includes('tool_use')) return
	let e: any
	try {
		e = JSON.parse(line)
	} catch {
		return
	}
	if (typeof e.durationMs === 'number') L.activeMs += e.durationMs
	const c = e.message?.content
	if (!Array.isArray(c)) return
	for (const b of c) {
		if (b?.type !== 'tool_use') continue
		if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') L.edits++
		else if (b.name === 'Bash' && /\bgit\s+commit\b/.test(b.input?.command ?? '')) L.commits++
	}
}

/** Read whatever has been appended since last time and fold it into the totals. */
function advance(file: string): Ledger {
	let L = ledgers.get(file)
	if (!L) {
		L = blank()
		ledgers.set(file, L)
	}
	let size = 0
	try {
		size = fs.statSync(file).size
	} catch {
		return L
	}
	// shorter than where we stopped: the file was replaced, so the totals are stale
	if (size < L.off) {
		L = blank()
		ledgers.set(file, L)
	}
	if (size === L.off) return L
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		return L
	}
	const dec = new StringDecoder('utf8') // a chunk boundary can split a character
	try {
		const CHUNK = 4_000_000
		const buf = Buffer.alloc(CHUNK)
		while (L.off < size) {
			const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - L.off), L.off)
			if (n <= 0) break
			L.off += n
			const lines = (L.tail + dec.write(buf.subarray(0, n))).split('\n')
			L.tail = lines.pop() ?? '' // the last line may still be being written
			for (const line of lines) tally(L, line)
		}
	} catch {
	} finally {
		fs.closeSync(fd)
	}
	return L
}
/** A transcript that has not grown cannot have changed, and a poll every two
 *  seconds must not re-read half a megabyte per session to find that out. */
const digestCache = new Map<string, { size: number; d: Digest }>()

/** Sub-agents this session dispatched, counted from their own transcripts. */
function subagentCount(file: string) {
	const dir = file.replace(/\.jsonl$/, '')
	let n = 0
	const walk = (d: string) => {
		let entries: fs.Dirent[] = []
		try {
			entries = fs.readdirSync(d, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			const full = path.join(d, e.name)
			if (e.isDirectory()) walk(full)
			else if (e.name.endsWith('.jsonl')) {
				try {
					if (fs.statSync(full).size > 20_000) n++
				} catch {}
			}
		}
	}
	walk(path.join(dir, 'subagents'))
	return n
}

/** Read only the tail — one of these transcripts is 164MB. */
function digest(file: string) {
	let statSize = 0
	try {
		statSize = fs.statSync(file).size
	} catch {}
	const cached = digestCache.get(file)
	if (cached && cached.size === statSize) return cached.d
	const d = digestInner(file, statSize)
	digestCache.set(file, { size: statSize, d })
	return d
}

function digestInner(file: string, statSize: number) {
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		return {} as Digest
	}
	let lines: string[] = []
	try {
		const size = fs.fstatSync(fd).size
		// 512KB, not 140: records average 7.4KB, so the old window held ~19 of them
		// and the newest title/status/question records were routinely outside it
		const start = Math.max(0, size - 512_000)
		const len = Math.min(512_000, size)
		const buf = Buffer.alloc(len)
		fs.readSync(fd, buf, 0, len, start)
		let s = buf.toString('utf8')
		if (start > 0) s = s.slice(s.indexOf('\n') + 1)
		lines = s.split('\n')
	} finally {
		fs.closeSync(fd)
	}
	const d: Digest = {}
	const seen = new Map<string, number>()
	// only real container directories, and only a directory name — 'src' matches
	// inside every repository, which is how "data.ts" and "null" became projects
	const CONTAINERS = /(?:^|\/)(projects|repos|workspace)\/([^/\s"'`;:.]+)(?=\/|$)/g
	const note = (v: unknown) => {
		if (typeof v !== 'string') return
		for (const m of v.matchAll(CONTAINERS)) {
			const name = m[2]
			if (!name || name.startsWith('.') || name.includes('*') || name === 'null' || name === 'undefined') continue
			seen.set(name, (seen.get(name) ?? 0) + 1)
		}
	}
	for (const l of lines) {
		if (!l) continue
		let e: any
		try {
			e = JSON.parse(l)
		} catch {
			continue
		}
		// records carry real timestamps; file mtime does not (sidecar records bump it
		// without any conversation activity, and subagent writes never touch it)
		if (typeof e.timestamp === 'string') {
			const t = Date.parse(e.timestamp)
			if (!Number.isNaN(t) && (!d.lastTs || t > d.lastTs)) d.lastTs = t
		}
		note(e.cwd)
		if (e.type === 'user' && !e.toolUseResult) d.asked = false
		// turn_duration carries the running message count; an API error or a failed
		// stop is the only failure signal the transcript exposes
		if (e.type === 'system' && e.subtype === 'turn_duration' && typeof e.messageCount === 'number') d.turns = e.messageCount
		if (e.isApiErrorMessage === true || (e.type === 'system' && /fail|error/i.test(String(e.subtype ?? '')))) d.failed = true
		else if (e.type === 'assistant' || e.type === 'user') d.failed = false
		if (e.type === 'ai-title' && e.aiTitle) d.title = e.aiTitle
		else if (e.type === 'assistant') {
			const m = e.message ?? {}
			if (m.usage) d.usage = m.usage
			if (Array.isArray(m.content))
				for (const b of m.content) {
					if (b.type === 'tool_use') {
						d.tool = b.name
						d.toolInput = b.input
						// a session that opened a question dialog is waiting on you even
						// though the registry still calls it idle
						d.asked = b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode'
						for (const v of Object.values(b.input ?? {})) note(v)
					} else if (b.type === 'text' && b.text.trim()) {
						d.text = b.text.trim()
						// or ended its turn on a question, which the registry never reports
						d.asked = /\?\s*$/.test((d.text ?? '').replace(/[)*_`'"\]]+$/, '').trim())
					}
				}
		}
	}
	// the directory this session actually works in, by weight of evidence
	if (seen.size) d.subProj = [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0]
	const L = advance(file)
	d.commits = L.commits
	d.edits = L.edits
	d.activeMin = L.activeMs / 60_000
	d.subs = subagentCount(file)
	return d
}

type Digest = { commits?: number; edits?: number; activeMin?: number; subs?: number; title?: string; usage?: any; tool?: string; toolInput?: any; text?: string; lastTs?: number; subProj?: string; turns?: number; failed?: boolean; asked?: boolean }

/** Which cmux tab a session is sitting in, so we can offer to jump there. */
function cmuxMap() {
	const m = new Map<string, { tab: number; unread: boolean }>()
	let st: any
	try {
		st = JSON.parse(fs.readFileSync(CMUX_STATE, 'utf8'))
	} catch {
		return m
	}
	for (const win of st.windows ?? []) {
		;(win.tabManager?.workspaces ?? []).forEach((ws: any, i: number) => {
			for (const pn of ws.panels ?? []) {
				const ag = pn.terminal?.agent
				if (ag?.sessionId) m.set(ag.sessionId, { tab: i + 1, unread: !!ws.hasUnreadIndicator })
			}
		})
	}
	return m
}

const bn = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '?')
export const cut = (s: string, n: number) => {
	const t = (s ?? '').replace(/\s+/g, ' ').trim()
	return [...t].length > n ? [...t].slice(0, Math.max(0, n - 1)).join('') + '…' : t
}

/** Strip markdown and take the opening sentence — where a session left off. */
export function firstSentence(t?: string) {
	if (!t) return ''
	const s = t
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`#>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	const m = s.match(/^(.{8,140}?[.!?])(\s|$)/)
	return m ? m[1] : s
}

/** Directory hops and env setup are never what a session is "doing". */
function cleanCmd(c: unknown) {
	if (typeof c !== 'string') return null
	const s = c.replace(/\s+/g, ' ').trim().replace(/^cd\s+[^&;]+(&&|;)\s*/, '')
	if (/^(cd|export|source|\.)\s/.test(s) || s === 'cd') return null
	return s
}

/**
 * Short phrases for the label over a character's head, matching the vocabulary
 * pixel-agents uses in its overlay: Reading / Editing / Writing / Running /
 * Searching. A truncated shell command floating over someone's head tells you
 * nothing; the table below has room for the real thing.
 */
const KIND: Record<string, Session['toolKind']> = {
	Edit: 'edit',
	Write: 'edit',
	NotebookEdit: 'edit',
	Read: 'read',
	Bash: 'run',
	Grep: 'search',
	Glob: 'search',
	WebSearch: 'search',
	WebFetch: 'read',
	Task: 'agent',
	Agent: 'agent',
	Workflow: 'agent',
}

const SHORT: Record<string, (i: any) => string> = {
	Edit: (i) => `Editing ${bn(i.file_path)}`,
	Write: (i) => `Writing ${bn(i.file_path)}`,
	Read: (i) => `Reading ${bn(i.file_path)}`,
	NotebookEdit: (i) => `Editing ${bn(i.notebook_path)}`,
	Bash: (i) => {
		const c = cleanCmd(i.command) ?? ''
		// just the program and its first argument — "Running npm test"
		const words = c.split(' ').filter(Boolean).slice(0, 2).join(' ')
		return words ? `Running ${cut(words, 18)}` : 'Running a command'
	},
	Grep: () => 'Searching',
	Glob: () => 'Looking for files',
	Task: () => 'Running an agent',
	Agent: () => 'Running an agent',
	Workflow: () => 'Running a workflow',
	WebSearch: () => 'Searching the web',
	WebFetch: () => 'Fetching a page',
	TodoWrite: () => 'Planning',
	TaskCreate: () => 'Planning',
	ExitPlanMode: () => 'Presenting a plan',
	AskUserQuestion: () => 'Asking you something',
}

function shortText(d: Digest, state: State, waitingFor?: string) {
	if (state === 'needs') return waitingFor === 'permission prompt' ? 'Needs approval' : 'Answer needed'
	if (state !== 'working' && state !== 'shell') return ''
	if (!d.tool) return 'Thinking'
	if (d.tool.startsWith('mcp__')) return cut(d.tool.split('__').slice(-1)[0], 20)
	return SHORT[d.tool]?.(d.toolInput ?? {}) ?? cut(d.tool, 20)
}

const SAY: Record<string, (i: any) => string | null> = {
	Edit: (i) => `editing ${bn(i.file_path)}`,
	Write: (i) => `writing ${bn(i.file_path)}`,
	Read: (i) => `reading ${bn(i.file_path)}`,
	NotebookEdit: (i) => `editing ${bn(i.notebook_path)}`,
	Bash: (i) => {
		const c = cleanCmd(i.command)
		return c ? `$ ${cut(c, 40)}` : null
	},
	Grep: (i) => `grep "${cut(String(i.pattern ?? ''), 22)}"`,
	Glob: (i) => `finding ${cut(String(i.pattern ?? ''), 22)}`,
	Task: () => 'sent out an agent',
	Agent: () => 'sent out an agent',
	Workflow: () => 'running a workflow',
	WebSearch: (i) => `searching "${cut(String(i.query ?? ''), 22)}"`,
	WebFetch: () => 'reading the web',
	TodoWrite: () => 'updating the plan',
	TaskCreate: () => 'updating the plan',
	ExitPlanMode: () => 'showing you a plan',
	AskUserQuestion: () => 'asking you something',
}

function doingText(d: Digest, state: State, waitingFor?: string) {
	// repeating the status here wastes the widest column; show the question itself
	if (state === 'needs') return waitingFor ?? (d.asked ? firstSentence(d.text) || 'asked you something' : 'needs you')
	if (state === 'working' || state === 'shell') {
		if (!d.tool) return 'thinking…'
		if (d.tool.startsWith('mcp__')) return cut(d.tool.split('__').slice(1).join(' '), 28)
		const f = SAY[d.tool]
		return (f ? f(d.toolInput ?? {}) : cut(d.tool, 24)) || 'thinking…'
	}
	return firstSentence(d.text)
}

const hash = (s: string) => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

export function collect(): Session[] {
	const idx = transcriptIndex()
	const cm = cmuxMap()
	const now = Date.now()
	const registry = liveSessions()
	// Looks are handed out by index over a stable ordering, so a session keeps the
	// same character for its whole life and no two collide until the sheets run out.
	// seed the look by project so sessions in the same repo read as one team,
	// matching the pod nameplate they sit under
	const looks = assignLooks(
		[...registry]
			.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.sessionId.localeCompare(b.sessionId))
			.map((s) => s.sessionId),
	)
	return registry.map((s) => {
		const file = idx.get(s.sessionId)
		const d = file ? digest(file) : ({} as Digest)
		const tabInfo = cm.get(s.sessionId)
		const stale = now - (s.statusUpdatedAt || s.updatedAt || 0)
		// status is written on change, never as a heartbeat, so a session that
		// died mid-turn stays "busy" forever. Recency has to gate it.
		const raw = s.status ?? 'idle'
		// quiet = neither the registry nor the transcript has moved in a long time
		const quiet = Math.min(stale, d.lastTs ? now - d.lastTs : Infinity) > ZOMBIE_WINDOW
		const unread = !!tabInfo?.unread
		const state: State = d.failed
			? 'error'
			: raw === 'waiting'
				? 'needs'
				: d.asked && raw !== 'busy'
					? 'needs'
				: raw === 'busy' && !quiet
					? 'working'
					: raw === 'shell' && !quiet
						? 'shell'
						: // cmux knows whether you have looked at the tab, which beats guessing
							// "finished recently" from a clock
							unread && stale < DONE_WINDOW * 4
							? 'review'
							: stale < DONE_WINDOW
								? 'done'
								: 'parked'
		const u = d.usage
		const used = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
		// A session started from a container like ~/projects reports "projects" as
		// its name, which tells you nothing when eight of nine share it. Fall back to
		// the directory its own tool calls keep touching.
		const base = path.basename(s.cwd)
		const container = /^(projects|repos|workspace)$/.test(base)
		const proj = container && d.subProj ? d.subProj : base
		const tab = tabInfo
		return {
			id: s.sessionId,
			pid: s.pid,
			// the derived name ("projects-fa") says nothing; the AI title says what
			// the session is actually about, so prefer it wherever there is room
			name: s.name ?? proj,
			proj,
			cwd: s.cwd,
			state,
			waitingFor: s.waitingFor ?? (d.asked ? 'answer a question' : undefined),
			stale,
			title: d.title || (s.nameSource === 'derived' ? '' : (s.name ?? '')) || proj,
			doing: doingText(d, state, s.waitingFor),
			short: shortText(d, state, s.waitingFor),
			last: firstSentence(d.text),
			ctxUsed: used,
			ctxLimit: used > 190_000 ? 1_000_000 : 200_000,
			tab: tab?.tab,
			unread: !!tab?.unread,
			toolKind: (d.tool && KIND[d.tool]) || 'think',
			turns: d.turns ?? 0,
			level: levelFor(xpOf(d)),
			xp: Math.round(xpOf(d)),
			palette: looks.get(s.sessionId)?.palette ?? 0,
			hueShift: looks.get(s.sessionId)?.hueShift ?? 0,
		}
	})
}

/**
 * One function decides what deserves your attention. The gutter marker, the sort
 * tier, the faults filter and the header count all read from here, so adding a
 * condition touches exactly one place.
 */
export function needsAttention(s: Session): string | null {
	if (s.state === 'needs') return s.waitingFor ?? 'blocked'
	if (s.ctxUsed / s.ctxLimit > 0.9) return 'context almost full'
	return null
}

/**
 * Two tiers. Only the attention tier floats, and everything else stays in a
 * stable alphabetical order — if rows reshuffled whenever a status changed, the
 * cursor would land on a different session than the one you were reading.
 */
export function order(list: Session[]) {
	return [...list].sort((a, b) => {
		const at = needsAttention(a) ? 0 : 1
		const bt = needsAttention(b) ? 0 : 1
		if (at !== bt) return at - bt
		if (a.stale !== b.stale) return b.stale - a.stale
		return a.id.localeCompare(b.id)
	})
}

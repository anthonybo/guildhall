/**
 * Everything guildhall knows, read straight off disk. Nothing is installed and
 * no session is instrumented — Claude Code already writes a registry entry per
 * running process, and cmux already writes its window layout.
 */
import fs from 'node:fs'
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

export type State = 'needs' | 'working' | 'shell' | 'done' | 'parked'
export const RANK: Record<State, number> = { needs: 0, working: 1, shell: 2, done: 3, parked: 4 }

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
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** Process start times, so a recycled PID can't masquerade as a live session. */
function procStarts(pids: number[]) {
	const m = new Map<number, string>()
	if (!pids.length) return m
	try {
		const out = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		for (const line of out.split('\n')) {
			const t = line.trim()
			if (!t) continue
			const sp = t.indexOf(' ')
			m.set(Number(t.slice(0, sp)), t.slice(sp + 1).trim())
		}
	} catch {}
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

function transcriptIndex() {
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
		for (const f of files) if (f.endsWith('.jsonl')) idx.set(f.slice(0, -6), path.join(p, f))
	}
	return idx
}

/** Read only the tail — one of these transcripts is 164MB. */
function digest(file: string) {
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		return {} as Digest
	}
	let lines: string[] = []
	try {
		const size = fs.fstatSync(fd).size
		const start = Math.max(0, size - 140_000)
		const len = Math.min(140_000, size)
		const buf = Buffer.alloc(len)
		fs.readSync(fd, buf, 0, len, start)
		let s = buf.toString('utf8')
		if (start > 0) s = s.slice(s.indexOf('\n') + 1)
		lines = s.split('\n')
	} finally {
		fs.closeSync(fd)
	}
	const d: Digest = {}
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
		if (e.type === 'ai-title' && e.aiTitle) d.title = e.aiTitle
		else if (e.type === 'assistant') {
			const m = e.message ?? {}
			if (m.usage) d.usage = m.usage
			if (Array.isArray(m.content))
				for (const b of m.content) {
					if (b.type === 'tool_use') {
						d.tool = b.name
						d.toolInput = b.input
					} else if (b.type === 'text' && b.text.trim()) d.text = b.text.trim()
				}
		}
	}
	return d
}

type Digest = { title?: string; usage?: any; tool?: string; toolInput?: any; text?: string; lastTs?: number }

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
	if (state === 'needs') return waitingFor === 'permission prompt' ? 'Needs approval' : 'Waiting for input'
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
	if (state === 'needs') return waitingFor ?? 'needs you'
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
	const looks = assignLooks([...registry].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((s) => s.sessionId))
	return registry.map((s) => {
		const file = idx.get(s.sessionId)
		const d = file ? digest(file) : ({} as Digest)
		const stale = now - (s.statusUpdatedAt || s.updatedAt || 0)
		// status is written on change, never as a heartbeat, so a session that
		// died mid-turn stays "busy" forever. Recency has to gate it.
		const raw = s.status ?? 'idle'
		// quiet = neither the registry nor the transcript has moved in a long time
		const quiet = Math.min(stale, d.lastTs ? now - d.lastTs : Infinity) > ZOMBIE_WINDOW
		const state: State =
			raw === 'waiting'
				? 'needs'
				: raw === 'busy' && !quiet
					? 'working'
					: raw === 'shell' && !quiet
						? 'shell'
						: stale < DONE_WINDOW
							? 'done'
							: 'parked'
		const u = d.usage
		const used = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
		const proj = path.basename(s.cwd)
		const tab = cm.get(s.sessionId)
		return {
			id: s.sessionId,
			pid: s.pid,
			// the derived name ("projects-fa") says nothing; the AI title says what
			// the session is actually about, so prefer it wherever there is room
			name: s.name ?? proj,
			proj,
			cwd: s.cwd,
			state,
			waitingFor: s.waitingFor,
			stale,
			title: d.title || (s.nameSource === 'derived' ? '' : (s.name ?? '')) || proj,
			doing: doingText(d, state, s.waitingFor),
			short: shortText(d, state, s.waitingFor),
			last: firstSentence(d.text),
			ctxUsed: used,
			ctxLimit: used > 190_000 ? 1_000_000 : 200_000,
			tab: tab?.tab,
			unread: !!tab?.unread,
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
		const an = `${a.proj}${a.title}`
		const bn2 = `${b.proj}${b.title}`
		return an.localeCompare(bn2) || a.id.localeCompare(b.id)
	})
}

/**
 * Agent teams: which teammates belong to which lead session.
 *
 * A teammate is a separate Claude Code process in its own cmux pane, and it does NOT
 * register in `~/.claude/sessions` — measured, six registry entries and none of them a
 * teammate. So the room never drew one. Two sources carry them, and they do not agree
 * about the one thing that matters:
 *
 *  - `~/.claude/teams/<team>/config.json` lists the members with `isActive`, the agent
 *    type and the pane. Its `leadSessionId` is NOT the lead's session: measured, a team
 *    whose teammates all named `0cde036d…` as their parent recorded `443e89d3…` there.
 *    Anything that linked a team to its lead through this file would have drawn the
 *    teammates at the wrong desk.
 *  - The teammate PROCESS carries `--parent-session-id <the lead's session id>` in its
 *    own launch arguments, with `--agent-name`, `--team-name`, `--agent-color` and
 *    `--agent-type`. That is the link — read, not inferred. A second, independent check
 *    agreed: both teammates were launched through the cmux shim named in the lead's own
 *    `CMUX_CLAUDE_TEAMS_TMUX_SHIM`.
 *
 * Matching by directory was rejected on purpose. It would work in the measured case,
 * where one session had teams enabled, and fails silently the first time two do —
 * the same shape as the directory match that once opened an unrelated session's
 * terminal (MISTAKES.md).
 *
 * WHAT IT COSTS. `ps` is the most expensive thing a poll can do (registry.ts measured
 * 161ms for ten pids), so it runs only when a team exists AND something changed: a team
 * file was rewritten, a listed teammate has no known process, or a known teammate's pid
 * died — and liveness is `kill(pid, 0)`, which is free. A room with no teams never lists
 * processes at all.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { TEAMS_DIR } from './paths.ts'
import { cacheFile } from './ledgercache.ts'
import { writePrivate } from '../privatefile.ts'

export type Teammate = {
	name: string
	/** The color Claude Code labels this teammate's pane with — `blue`, `green`, … */
	color?: string
	/** The agent definition it runs, e.g. `qa-cast-mock`. */
	type?: string
	/** Working now. From the team file, which Claude Code keeps current. */
	active: boolean
	/** The tmux-compat pane id cmux gave it. */
	pane?: string
	pid?: number
}
export type Team = { name: string; members: Teammate[] }

/** What a teammate's launch arguments say about it. */
export type Proc = { pid: number; name: string; team: string; parent: string; color?: string; type?: string }

/**
 * Read one process's command line as a teammate, or not.
 *
 * Only the claude binary itself counts — `…/claude` or a versioned `…/claude/versions/x`.
 * The login shell and `sh -lc` wrappers around a teammate carry the same flags inside a
 * quoted string, and taking those would count every teammate three times.
 */
export function parseTeammate(pid: number, command: string): Proc | null {
	const sp = command.indexOf(' ')
	const bin = sp < 0 ? command : command.slice(0, sp)
	if (!/\/claude$|\/claude\/versions\/[^/\s]+$/.test(bin)) return null
	const arg = (k: string) => new RegExp(`(?:^|\\s)--${k}[ =]([^\\s]+)`).exec(command)?.[1]
	const name = arg('agent-name')
	const team = arg('team-name')
	const parent = arg('parent-session-id')
	// All three or nothing: a process missing its parent cannot be placed without guessing.
	if (!name || !team || !parent) return null
	return { pid, name, team, parent, color: arg('agent-color'), type: arg('agent-type') }
}

type Config = { name: string; members: { name: string; agentType?: string; isActive?: boolean; tmuxPaneId?: string; backendType?: string }[] }

/** Team files, re-read only when one changes. */
let configs = new Map<string, { mtime: number; c: Config }>()
function readConfigs(dir: string): Config[] {
	let names: string[] = []
	try {
		names = fs.readdirSync(dir)
	} catch {
		configs = new Map()
		return []
	}
	const next = new Map<string, { mtime: number; c: Config }>()
	for (const n of names) {
		const f = path.join(dir, n, 'config.json')
		let mtime: number
		try {
			mtime = fs.statSync(f).mtimeMs
		} catch {
			continue
		}
		const had = configs.get(f)
		if (had && had.mtime === mtime) {
			next.set(f, had)
			continue
		}
		try {
			const c = JSON.parse(fs.readFileSync(f, 'utf8')) as Config
			if (c && typeof c.name === 'string' && Array.isArray(c.members)) next.set(f, { mtime, c })
		} catch {
			// Mid-write by Claude Code. The next poll reads it whole.
		}
	}
	configs = next
	return [...next.values()].map((x) => x.c)
}

/** Teammate processes by `team/name`, from the last listing. */
let procs = new Map<string, Proc>()
let listedAt = 0
/** The team files as they were when `procs` was listed, so a rewrite forces a relist. */
let listedStamp = ''
/** Even when something is unresolved, list at most this often — a teammate that has
 *  exited but is still in its team file would otherwise cost a `ps` every poll. */
const LIST_EVERY = 15_000

/**
 * The listing, shared across processes.
 *
 * The menu bar's `--sessions` is a fresh process every 5 seconds, so an in-memory cache
 * never survives to be used: with a team running, every poll listed every process.
 * Measured at ~80 cpu-ms in the `ps` process alone — and invisible to the
 * fresh-process perf gate, which reads the node process's own CPU and not its
 * children's, exactly as the warm gate had been blind to the cold one.
 *
 * Trusted only while the team files are byte-for-byte the files it was listed against,
 * and for at most SHARE_FOR. The time bound is also the bound on a reused pid: macOS
 * hands pids out in increasing order, so one coming round inside a minute is not a
 * case worth more than that.
 */
const SHARE_FOR = 60_000
export type ProcStore = {
	load: () => { at: number; stamp: string; procs: Proc[] } | null
	save: (v: { at: number; stamp: string; procs: Proc[] }) => void
}
const storeFile = () => path.join(path.dirname(cacheFile()), 'teammates.json')
export const diskStore: ProcStore = {
	load() {
		try {
			const j = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as { v?: unknown; at?: unknown; stamp?: unknown; procs?: unknown }
			if (j.v !== 1 || typeof j.at !== 'number' || typeof j.stamp !== 'string' || !Array.isArray(j.procs)) return null
			const ok = (p: Proc) => Number.isInteger(p?.pid) && [p.name, p.team, p.parent].every((s) => typeof s === 'string' && s)
			return { at: j.at, stamp: j.stamp, procs: (j.procs as Proc[]).filter(ok) }
		} catch {
			return null
		}
	},
	save(v) {
		try {
			writePrivate(storeFile(), JSON.stringify({ v: 1, ...v }))
		} catch {
			// A cache that cannot be written costs the next process one listing.
		}
	},
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function listProcesses(): Map<string, Proc> {
	const out = new Map<string, Proc>()
	let text = ''
	try {
		text = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 })
	} catch {
		return out
	}
	for (const line of text.split('\n')) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line)
		if (!m || !m[2].includes('--parent-session-id')) continue
		const p = parseTeammate(Number(m[1]), m[2])
		if (p) out.set(`${p.team}/${p.name}`, p)
	}
	return out
}

/**
 * Teams keyed by the session id of the lead that spawned them.
 *
 * A team with no member process found is left out rather than attached anywhere: there
 * is nothing to read its lead from, and the point of this file is not to guess.
 */
export function teamsByLead(now = Date.now(), dir = TEAMS_DIR, list: () => Map<string, Proc> = listProcesses, store: ProcStore = diskStore): Map<string, Team> {
	const teams = readConfigs(dir)
	const out = new Map<string, Team>()
	const mates = teams.flatMap((t) => t.members.filter((m) => m.backendType !== 'in-process' && m.name !== 'team-lead').map((m) => ({ t, m })))
	if (!mates.length) {
		procs = new Map()
		return out
	}
	const stamp = [...configs.entries()]
		.map(([f, x]) => `${f}:${x.mtime}`)
		.sort()
		.join('|')
	// A fresh process — the menu bar's every poll — starts from what the last one listed,
	// if it was listed against these exact team files and recently enough.
	if (listedAt === 0) {
		const s = store.load()
		if (s && s.stamp === stamp && now - s.at < SHARE_FOR && now >= s.at) {
			procs = new Map(s.procs.map((p) => [`${p.team}/${p.name}`, p]))
			listedAt = s.at
			listedStamp = s.stamp
		}
	}
	const unresolved = mates.some(({ t, m }) => !procs.has(`${t.name}/${m.name}`))
	const died = [...procs.values()].some((p) => !alive(p.pid))
	const rewritten = stamp !== listedStamp
	if (rewritten || ((unresolved || died) && now - listedAt >= LIST_EVERY)) {
		procs = list()
		listedAt = now
		listedStamp = stamp
		store.save({ at: now, stamp, procs: [...procs.values()] })
	}
	for (const t of teams) {
		const members: Teammate[] = []
		let lead: string | undefined
		for (const m of t.members) {
			if (m.backendType === 'in-process' || m.name === 'team-lead') continue
			const p = procs.get(`${t.name}/${m.name}`)
			if (!p || !alive(p.pid)) continue
			// Every member must name the SAME parent; a team split across two leads is not
			// a shape to draw by picking one.
			if (lead && lead !== p.parent) {
				lead = undefined
				break
			}
			lead = p.parent
			members.push({ name: m.name, color: p.color, type: p.type ?? m.agentType, active: m.isActive === true, pane: m.tmuxPaneId, pid: p.pid })
		}
		if (lead && members.length) out.set(lead, { name: t.name, members })
	}
	return out
}

/** Test seam. */
export function resetTeams() {
	configs = new Map()
	procs = new Map()
	listedAt = 0
	listedStamp = ''
}

/**
 * What a session is doing right now, read from the end of its transcript.
 *
 * Only the tail is read. The interesting records — the AI title, the latest tool
 * call, whether the turn ended on a question — are always near the end, and the
 * files are far too large to scan for them. Lifetime totals come from the ledger
 * in `transcript.ts` instead, which accumulates rather than samples.
 */
import fs from 'node:fs'
import { advance, subagentCount } from './transcript.ts'
import type { Digest } from './types.ts'

/** Records average ~7.4KB, so this window holds roughly seventy of them. An
 *  earlier 140KB window routinely missed the newest title and question records. */
const TAIL_BYTES = 512_000

/** A transcript that has not grown cannot have changed, and a poll every two
 *  seconds must not re-read half a megabyte per session to find that out. */
const cache = new Map<string, { size: number; d: Digest }>()

export function digest(file: string) {
	let statSize = 0
	try {
		statSize = fs.statSync(file).size
	} catch {}
	const cached = cache.get(file)
	if (cached && cached.size === statSize) return cached.d
	const d = read(file)
	cache.set(file, { size: statSize, d })
	return d
}

/** Read the tail as whole lines, dropping the partial one at the front. */
function tailLines(file: string) {
	let fd: number
	try {
		fd = fs.openSync(file, 'r')
	} catch {
		return null
	}
	try {
		const size = fs.fstatSync(fd).size
		const start = Math.max(0, size - TAIL_BYTES)
		const len = Math.min(TAIL_BYTES, size)
		const buf = Buffer.alloc(len)
		fs.readSync(fd, buf, 0, len, start)
		let s = buf.toString('utf8')
		if (start > 0) s = s.slice(s.indexOf('\n') + 1)
		return s.split('\n')
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * The directory a session actually works in.
 *
 * Only real container directories, and only a directory name: `src` matches inside
 * every repository, which is how "data.ts" and even "null" once became project
 * names. Counted by weight of evidence across every path the session mentions.
 */
const CONTAINERS = /(?:^|\/)(projects|repos|workspace)\/([^/\s"'`;:.]+)(?=\/|$)/g

function projectVotes() {
	const seen = new Map<string, number>()
	const note = (v: unknown) => {
		if (typeof v !== 'string') return
		for (const m of v.matchAll(CONTAINERS)) {
			const name = m[2]
			if (!name || name.startsWith('.') || name.includes('*') || name === 'null' || name === 'undefined') continue
			seen.set(name, (seen.get(name) ?? 0) + 1)
		}
	}
	return { note, winner: () => (seen.size ? [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0] : undefined) }
}

/** Trailing punctuation must not hide a question mark. */
const endsOnQuestion = (text: string) => /\?\s*$/.test(text.replace(/[)*_`'"\]]+$/, '').trim())

function read(file: string): Digest {
	const lines = tailLines(file)
	if (!lines) return {}
	const d: Digest = {}
	const votes = projectVotes()

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
		votes.note(e.cwd)
		if (e.type === 'user' && !e.toolUseResult) d.asked = false
		// turn_duration carries the running message count; an API error or a failed
		// stop is the only failure signal the transcript exposes
		if (e.type === 'system' && e.subtype === 'turn_duration') {
			if (typeof e.messageCount === 'number') d.turns = e.messageCount
			// how many agents this session still has out, which is the difference
			// between "thinking" and "supervising four things at once"
			if (typeof e.pendingBackgroundAgentCount === 'number') d.pending = e.pendingBackgroundAgentCount
		}
		if (e.isApiErrorMessage === true || (e.type === 'system' && /fail|error/i.test(String(e.subtype ?? '')))) d.failed = true
		else if (e.type === 'assistant' || e.type === 'user') d.failed = false
		if (e.type === 'ai-title' && e.aiTitle) d.title = e.aiTitle
		else if (e.type === 'assistant') readAssistant(e.message ?? {}, d, votes.note)
	}

	d.subProj = votes.winner()
	const L = advance(file)
	d.commits = L.commits
	d.edits = L.edits
	d.activeMin = L.activeMs / 60_000
	d.subs = subagentCount(file)
	return d
}

function readAssistant(m: any, d: Digest, note: (v: unknown) => void) {
	if (m.usage) d.usage = m.usage
	if (!Array.isArray(m.content)) return
	for (const b of m.content) {
		if (b.type === 'tool_use') {
			d.tool = b.name
			d.toolInput = b.input
			// a session that opened a question dialog is waiting on you even though
			// the registry still calls it idle
			d.asked = b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode'
			for (const v of Object.values(b.input ?? {})) note(v)
		} else if (b.type === 'text' && b.text.trim()) {
			const text = b.text.trim()
			d.text = text
			// or ended its turn on a question, which the registry never reports
			d.asked = endsOnQuestion(text)
		}
	}
}

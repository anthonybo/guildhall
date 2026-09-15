/**
 * Sessions you have closed, and could open again.
 *
 * The room shows what is RUNNING. A session you close to free up a machine leaves no trace
 * in it at all — and from a phone the only thing on offer was starting a NEW session, which
 * is not the same thing and loses the conversation. This is the other half: the ones that
 * have a transcript on disk and no process attached.
 *
 * EVERYTHING HERE IS READ FROM WHAT CLAUDE CODE ALREADY WROTE. A transcript carries its own
 * `cwd` and its opening prompt, so a closed session can name itself and say where it ran
 * without guildhall keeping any bookkeeping of its own. That matters because the mapping
 * this project got wrong before — matching a session to a tab by DIRECTORY — was wrong
 * precisely because it inferred rather than read.
 *
 * THE ALLOWLIST IS THE SAME ONE SPAWNING USES. Resuming runs `claude` in a directory, which
 * is the same act as starting a session there, so it is gated the same way rather than on
 * the weaker ground of "this directory used to have a session in it".
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnAllowed } from './projects.ts'
import { liveSessions } from './registry.ts'
import { transcriptIndex } from './transcript.ts'

export type Closed = {
	/** The session id `claude --resume` takes. */
	id: string
	cwd: string
	proj: string
	/** When the transcript was last written — how long ago the session was used. */
	at: number
	/** The opening prompt, which is what makes one closed session tell itself from another. */
	title: string
}

/**
 * How much of a transcript to read looking for the directory and the first prompt.
 *
 * Both live in the opening lines, and these files reach 22MB on this machine — reading one
 * whole to find something in its first kilobyte would make opening a picker cost tens of
 * megabytes of IO.
 */
const HEAD = 64 * 1024
/** Beyond this a session is unlikely to be one you meant to come back to, and the list
 *  stops being a list you can read. */
const MAX_AGE = 30 * 24 * 3600 * 1000

/** Cheap identity for a transcript: if neither has moved, the parse is still good. */
type Cached = { size: number; at: number; head: { cwd: string; title: string } | null }
const cache = new Map<string, Cached>()

/** The first `HEAD` bytes, without reading the rest. */
function headOf(file: string): string {
	let fd: number | undefined
	try {
		fd = fs.openSync(file, 'r')
		const buf = Buffer.alloc(HEAD)
		const n = fs.readSync(fd, buf, 0, HEAD, 0)
		return buf.subarray(0, n).toString('utf8')
	} catch {
		return ''
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd) } catch {}
	}
}

/** The directory a session ran in, and what it was first asked to do. */
function describe(file: string): { cwd: string; title: string } | null {
	let cwd = ''
	let title = ''
	for (const line of headOf(file).split('\n')) {
		if (!line) continue
		let j: Record<string, unknown>
		try {
			j = JSON.parse(line)
		} catch {
			// A truncated last line is expected — the read stops mid-file by design.
			continue
		}
		if (!cwd && typeof j.cwd === 'string') cwd = j.cwd
		if (!title && j.type === 'user') {
			const c = (j.message as { content?: unknown } | undefined)?.content
			const text = typeof c === 'string' ? c : Array.isArray(c) ? ((c.find((x) => (x as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? '') : ''
			// Skip the synthetic openers Claude Code writes — a command stub or a pasted
			// system block is not what the session was about.
			if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) title = text.replace(/\s+/g, ' ').trim()
		}
		if (cwd && title) break
	}
	return cwd ? { cwd, title } : null
}

/**
 * Closed sessions, newest first.
 *
 * `live` is passed in rather than read here so a caller that already has the session list
 * does not pay for the registry twice, and so a test can drive it with no registry at all.
 */
export function closedSessions(live: Iterable<string> = liveSessions().map((s) => s.sessionId), now = Date.now(), max = 12): Closed[] {
	const running = new Set(live)
	const out: Closed[] = []
	for (const [id, file] of transcriptIndex()) {
		if (running.has(id)) continue
		let st: fs.Stats
		try {
			st = fs.statSync(file)
		} catch {
			continue
		}
		if (now - st.mtimeMs > MAX_AGE) continue
		const was = cache.get(file)
		const head = was && was.size === st.size && was.at === st.mtimeMs ? was.head : describe(file)
		cache.set(file, { size: st.size, at: st.mtimeMs, head })
		if (!head) continue
		// Same gate as spawning, for the same reason: this starts a process in a directory.
		if (!spawnAllowed(head.cwd)) continue
		out.push({ id, cwd: head.cwd, proj: path.basename(head.cwd), at: st.mtimeMs, title: head.title || 'no opening prompt' })
	}
	// Newest first: the one you just closed is the one you are most likely to want.
	out.sort((a, b) => b.at - a.at)
	// Forget transcripts that have gone away, or this grows for the life of a program meant
	// to be left running for days — the rule `keepOnly` and `prune` already follow.
	if (cache.size > 200) for (const k of [...cache.keys()]) if (!fs.existsSync(k)) cache.delete(k)
	return out.slice(0, max)
}

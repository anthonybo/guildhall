/**
 * Finding a session's transcript, and counting the work recorded in it.
 *
 * Transcripts are append-only JSONL and can be very large — the biggest measured
 * here is 171MB, 1.2s to parse in full. Everything in this module is shaped by
 * that: totals are accumulated once and then advanced by the bytes appended since,
 * never recomputed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { PROJ_DIR } from './paths.ts'

/** Uncached on purpose: this is reached only when two directories hold the same
 *  session id, and a cached mtime would freeze that choice as the files grow. */
function mtime(f: string) {
	try {
		return fs.statSync(f).mtimeMs
	} catch {
		return 0
	}
}

/** Session id → the transcript that is actually live for it. */
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

/**
 * Lifetime work counters, advanced incrementally.
 *
 * These have to be exact totals rather than a sample of the tail. Transcripts are
 * append-only, so the byte offset reached last time is kept and only what has been
 * added since is parsed. The full pass happens once, at startup.
 */
type Ledger = { off: number; tail: string; commits: number; edits: number; activeMs: number }
const ledgers = new Map<string, Ledger>()
const blank = (): Ledger => ({ off: 0, tail: '', commits: 0, edits: 0, activeMs: 0 })

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const COMMIT = /\bgit\s+commit\b/

function tally(L: Ledger, line: string) {
	// Substring prefilter first: JSON.parse on every record of a 171MB transcript
	// is essentially the entire cost of this function.
	if (line.length < 40) return
	if (!line.includes('durationMs') && !line.includes('tool_use')) return
	let e: { durationMs?: unknown; message?: { content?: unknown } }
	try {
		e = JSON.parse(line)
	} catch {
		return
	}
	if (typeof e.durationMs === 'number') L.activeMs += e.durationMs
	const content = e.message?.content
	if (!Array.isArray(content)) return
	for (const b of content) {
		if (b?.type !== 'tool_use') continue
		if (EDIT_TOOLS.has(b.name)) L.edits++
		else if (b.name === 'Bash' && COMMIT.test(b.input?.command ?? '')) L.commits++
	}
}

/** Read whatever has been appended since last time and fold it into the totals. */
export function advance(file: string) {
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

/** Sub-agents this session dispatched, counted from their own transcripts. */
export function subagentCount(file: string) {
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
			// a stub transcript means the agent barely ran; only real work counts
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

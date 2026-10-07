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
import { type Stored, loadLedgers, saveLedgers } from './ledgercache.ts'

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
/**
 * `done` is the byte just past the last complete line, which is the offset the counters
 * are exact for and the only one safe to resume from. Tracked from the raw bytes rather
 * than computed as `off - byteLength(tail)`, because the decoder can be holding up to
 * three bytes of a character split across a chunk boundary that are in neither — and
 * resuming from that computed offset would start mid-character and garble a record.
 */
type Ledger = { ino: number; off: number; done: number; tail: string; commits: number; edits: number; activeMs: number }
const ledgers = new Map<string, Ledger>()
const blank = (ino = 0): Ledger => ({ ino, off: 0, done: 0, tail: '', commits: 0, edits: 0, activeMs: 0 })

/**
 * Seeded from disk on first use, so a fresh process resumes rather than re-parsing.
 *
 * "The full pass happens once, at startup" above was true of a long-lived process and
 * expensive for a short one: every `guildhall --sessions` the menu bar ran paid ~8 cpu-s
 * re-reading gigabytes of transcript. See ledgercache.ts for the measurement.
 */
let seeded = false
function seed() {
	if (seeded) return
	seeded = true
	// A stored offset is always a line boundary, so it is both where reading resumes and
	// where the counters are exact.
	for (const [file, s] of loadLedgers()) ledgers.set(file, { ...s, done: s.off, tail: '' })
}

/** A ledger moved since the last save, so the cache is behind. */
let dirty = false
let savedAt = 0
/**
 * How often a long-lived process writes the cache. A short one writes on its first call,
 * since `savedAt` starts at zero — which is exactly `--sessions`, run once and gone.
 * Sixty seconds because the cache only has to be close: an entry a minute old costs the
 * next fresh process one minute of appended bytes, which is nothing.
 */
const SAVE_EVERY = 60_000

/** Write the ledgers if any moved and the last write was long enough ago. */
export function persistLedgers(now = Date.now()) {
	if (!dirty || now - savedAt < SAVE_EVERY) return false
	const out = new Map<string, Stored>()
	for (const [file, L] of ledgers) {
		// The last complete line, not how far reading got. The fragment past it is not
		// stored: the next process re-reads it — one line — rather than trusting a partial
		// line it did not read itself.
		out.set(file, { ino: L.ino, off: L.done, commits: L.commits, edits: L.edits, activeMs: L.activeMs })
	}
	savedAt = now
	dirty = false
	return saveLedgers(out)
}

/** Test seam: forget everything, including that the cache was ever read. */
export function resetLedgers() {
	ledgers.clear()
	seeded = false
	dirty = false
	savedAt = 0
}

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
	seed()
	let L = ledgers.get(file)
	let st: fs.Stats
	try {
		st = fs.statSync(file)
	} catch {
		return L ?? blank()
	}
	const size = st.size
	if (!L) {
		L = blank(st.ino)
		ledgers.set(file, L)
	}
	// A DIFFERENT FILE at the same path: the totals belong to its predecessor. Shorter
	// than where we stopped was the only check while ledgers lived for one process; once
	// they outlive it, a transcript replaced by a LONGER one would pass that check and
	// have its counts added to a stranger's. The inode catches both.
	if (size < L.off || (L.ino && st.ino !== L.ino)) {
		L = blank(st.ino)
		ledgers.set(file, L)
		dirty = true
	}
	L.ino = st.ino
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
			const at = L.off
			const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - L.off), L.off)
			if (n <= 0) break
			L.off += n
			const lines = (L.tail + dec.write(buf.subarray(0, n))).split('\n')
			L.tail = lines.pop() ?? '' // the last line may still be being written
			for (const line of lines) tally(L, line)
			// Byte-exact: 0x0a never appears inside a multibyte UTF-8 sequence, so the last
			// newline in the raw chunk is the end of the last line tallied.
			const nl = buf.lastIndexOf(0x0a, n - 1)
			if (nl >= 0) L.done = at + nl + 1
			dirty = true
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

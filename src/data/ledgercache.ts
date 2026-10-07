/**
 * The transcript ledgers, kept on disk so a fresh process starts where the last one
 * stopped.
 *
 * WHY THIS EXISTS. A ledger is the running total of one transcript's work — commits,
 * edits, active time — plus the byte offset it has been read to. A long-lived guildhall
 * parses each transcript once and then reads only what has been appended, which is why
 * `collect()` costs 3-4 cpu-ms. A FRESH process has no ledgers and re-parses every
 * transcript from byte zero.
 *
 * And the menu bar runs a fresh process on every poll: `guildhall --sessions`, every 5
 * seconds idle and every 2 with its popover open. Measured on this machine, with 2.8GB of
 * transcripts and the largest at 726MB, one cold `collect()` cost 7,802 cpu-ms and a whole
 * `--sessions` run ~9 cpu-seconds and 225MB. Its design comment justified the spawn with
 * "collect() is measured at about 4 cpu-ms" — the warm number, which is what the perf gate
 * measures, so the gate could never see this. The result was most of a core, continuously,
 * reported as the machine lagging.
 *
 * WHAT IS STORED, AND WHAT IS NOT. The offset is rewound to the last complete line and the
 * partial line is dropped, so a resumed process re-reads at most one line and never has to
 * trust a fragment written by somebody else. The inode is kept so a transcript REPLACED by
 * a longer one is caught — the in-memory ledger only noticed a file that got shorter.
 *
 * SEVERAL WRITERS, NO LOCK. The terminal room, the headless service and the menu bar's
 * `--sessions` runs all share this file. Each write is a whole-file atomic rename, and each
 * entry is self-consistent — its counters are exactly the total over [0, off) — so whoever
 * writes last wins, and a slightly older entry only means re-reading a few extra bytes.
 * Never a wrong total.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writePrivate } from '../privatefile.ts'

export type Stored = { ino: number; off: number; commits: number; edits: number; activeMs: number }

/** Bumped when the stored shape changes, so an old cache is ignored rather than misread. */
const VERSION = 1

/**
 * The cache directory.
 *
 * Derived from the same home `paths.ts` reads transcripts from, so a test that points the
 * transcripts at a fixture gets an isolated cache with it and never writes the real one.
 * Platform caches dir rather than `~/.config/guildhall`: that holds settings and secrets,
 * and this is disposable — deleting it costs one slow start and nothing else.
 */
export function cacheFile(): string {
	if (process.env.GUILDHALL_CACHE_DIR) return path.join(process.env.GUILDHALL_CACHE_DIR, 'ledgers.json')
	const home = process.env.GUILDHALL_HOME || os.homedir()
	const dir = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'guildhall') : path.join(home, '.cache', 'guildhall')
	return path.join(dir, 'ledgers.json')
}

/** Read the cache. Anything unreadable is treated as empty: correct, just slow once. */
export function loadLedgers(): Map<string, Stored> {
	const out = new Map<string, Stored>()
	try {
		const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as { v?: unknown; ledgers?: Record<string, unknown> }
		if (raw.v !== VERSION || !raw.ledgers || typeof raw.ledgers !== 'object') return out
		for (const [file, e] of Object.entries(raw.ledgers)) {
			const s = e as Partial<Stored>
			// Every field checked: a hand-edited or truncated cache must not inject a bogus
			// offset, which would skip bytes and silently under-count.
			if (![s.ino, s.off, s.commits, s.edits, s.activeMs].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) continue
			out.set(file, s as Stored)
		}
	} catch {
		// Missing on first run, or mid-replace by another writer. Start cold.
	}
	return out
}

/** Write the cache atomically, private to this user — it lists project paths. */
export function saveLedgers(ledgers: Map<string, Stored>): boolean {
	try {
		// writePrivate makes the directory, writes a pid-suffixed temp file and renames it,
		// which is the atomicity the several-writers note above depends on.
		writePrivate(cacheFile(), JSON.stringify({ v: VERSION, ledgers: Object.fromEntries(ledgers) }))
		return true
	} catch {
		return false
	}
}

/** Taking you to a session's cmux tab: ⏎ on a row, or a digit for the tab itself. */
import { execFileSync, spawn } from 'node:child_process'
import { CMUX } from '../data/cmux-bin.ts'

/**
 * Jump to a tab by its POSITION, the number the user sees.
 *
 * `select-workspace --workspace N` resolves a bare number as a ref, and cmux's
 * refs do not follow its display order — ref 1 was the fourth tab here — so
 * passing the position directly lands on the wrong session. Ask cmux for its own
 * ordering and translate.
 */
export function jump(position: number) {
	try {
		const out = execFileSync(CMUX, ['workspace', 'list'], {
			encoding: 'utf8',
			env: { ...process.env, CMUX_QUIET: '1' },
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		const refs = out
			.split('\n')
			.map((l) => /workspace:(\d+)/.exec(l)?.[1])
			.filter((r): r is string => !!r)
		const ref = refs[position - 1]
		if (!ref) return
		spawn(CMUX, ['select-workspace', '--workspace', `workspace:${ref}`], { stdio: 'ignore', detached: true }).unref()
		raiseCmux()
	} catch {}
}

/**
 * Bring cmux's window in front of whatever is on screen.
 *
 * `select-workspace` changes which tab is current INSIDE cmux and does not touch
 * window ordering. That is invisible from here, because the room is normally run in a
 * cmux pane and cmux is therefore already frontmost — so the jump looked complete.
 * Run guildhall from any other terminal and clicking a desk switched a tab nobody was
 * looking at. The menu bar app is always in that second case, which is where this was
 * finally noticed.
 *
 * Measured on this machine with another app deliberately in front:
 *
 *   select-workspace           exit 0, the other app stayed frontmost
 *   focus-window --window …    exit 0 and prints "OK", the other app stayed frontmost
 *   open -a <cmux.app>         cmux came to the front
 *
 * `focus-window` is the trap — documented as "bring to front", reports success, does
 * nothing visible. macOS does not let a background process reorder another app's
 * windows; LaunchServices is the route that is allowed to.
 */
function raiseCmux() {
	// The .app that owns whatever CMUX resolved to, so this cannot name a second path
	// that drifts from it. A cmux found on PATH is not inside a bundle: skip rather
	// than guess, since `open -a cmux` by name can resolve to a different install.
	const app = /^(.*\.app)\//.exec(CMUX)?.[1]
	if (!app) return
	spawn('open', ['-a', app], { stdio: 'ignore', detached: true }).unref()
}

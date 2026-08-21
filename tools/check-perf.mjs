#!/usr/bin/env node
/**
 * The performance budget, enforced.
 *
 * This exists because every cost in this app arrived the same way: nobody was
 * watching. A per-frame call whose arguments never change sat in the renderer for
 * months and was 77.6% of the frame. A cache TTL was set to thirty seconds without
 * measuring that each refresh cost 9.76 CPU-seconds. A "push only when something
 * changed" guard compared a field that changes by construction, so it pushed
 * always. None of that was a hard problem — it was an unmeasured one.
 *
 * So the numbers below are gates, not notes. Anything that crosses one fails the
 * commit, and the message says what the number was when the budget was set.
 *
 * MEASURED IN CPU TIME, NOT WALL CLOCK. Wall clock on this machine is meaningless:
 * it routinely sits above load 10 with a dozen Claude sessions running, and the same
 * benchmark read anywhere from 2.4 to 17.7ms depending on what else was happening.
 *
 * CPU time is better but NOT load-proof, which I originally claimed and was wrong
 * about — see the note above `run()` for the numbers and for the normalisation
 * experiment that failed. Ceilings are set from the worst honest reading on a busy
 * machine, so this catches a doubling rather than a creep.
 *
 *   node tools/check-perf.mjs           check, exit 1 on a breach
 *   node tools/check-perf.mjs --report  print the numbers and exit 0
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const report = process.argv.includes('--report')
const tsx = join(ROOT, 'node_modules/.bin/tsx')

/** Median of a few runs: one sample under load can be unlucky, three rarely are. */
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/**
 * CPU time is NOT load-independent, which I had wrong when I set these budgets.
 *
 * Within one run it is beautifully stable — six measurements of renderRoom spread
 * 0.56ms. But the whole LEVEL moves with machine load, because contention costs
 * real cycles in cache and TLB misses. Measured here: renderRoom cost 9.9 cpu-ms at
 * load 3, 11.7-13.3 at load 12, and 15.3-16.2 at load 27. A ceiling set from a
 * quiet machine therefore fails honest work whenever the machine is busy — which is
 * when somebody is most likely to be committing. The first thing this gate blocked
 * was its own author's commit, at load 24.
 *
 * NORMALISING AGAINST A REFERENCE WORKLOAD WAS TRIED AND IS WORSE. Written down so
 * nobody spends the afternoon rediscovering it:
 *
 *  - Reference sampled 6x: renderRoom spread 5.7%, the RATIO spread 20%. The
 *    reference's own noise was larger than the signal it was meant to remove.
 *  - Reference sampled 30x to quieten it: the reference went bimodal, 5.5 and 11.9
 *    cpu-ms in alternate runs. That is JIT tiering — the loop gets optimised partway
 *    through, so the mean depends on when the optimiser fired. A clock that changes
 *    speed is not a clock.
 *
 * So: fixed ceilings, set from the WORST honest reading rather than the best, and
 * understood for what they are. This gate catches a DOUBLING, not a 20% creep. That
 * is enough for the regressions this codebase actually produces — choose() was 3x,
 * the pixel loop 1.8x — and pretending to finer resolution would only mean failing
 * commits for weather.
 */
const run = (src) => Number(execFileSync(tsx, ['-e', src], { cwd: ROOT, encoding: 'utf8' }).trim())

const checks = []

/**
 * The terminal frame, on the path production actually takes.
 *
 * `--bench` used to force images off, which skipped the entire kitty path — so the
 * one number anybody consulted was blind to the most expensive function in the
 * renderer. It measures the real path now; keep it that way.
 */
checks.push({
	name: 'terminal frame',
	unit: 'cpu-ms/frame',
	budget: 4.0,
	was: 1.7,
	note: 'was 5.6 before choose() was memoised; ceiling covers a loaded machine',
	measure: () =>
		median(
			[1, 2, 3].map(() => {
				// bench reports on STDERR, deliberately — its stdout is the frame dump.
				// Reading only stdout here produced a silent NaN, which the budget then
				// reported as a breach: a check that cannot measure must say so loudly,
				// not fail closed with a number nobody can explain.
				// Images forced ON, or the measured path depends on who invoked the hook: a
				// GUI git client, CI, tmux and VS Code's terminal all have no TERM_PROGRAM,
				// take the half-block branch, and read 3.1-3.8 against a 4.0 ceiling. Same
				// number, different renderer, failing for weather rather than a regression.
				const r = spawnSync('npm', ['run', '--silent', 'bench'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GUILDHALL_FORCE_IMAGES: '1' } })
				const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
				const m = /([\d.]+) ms\/frame/.exec(out)
				if (!m) throw new Error(`bench printed no frame time: ${out.trim().split('\n').pop()}`)
				return Number(m[1])
			}),
		),
})

/**
 * One poll of the session data, with the digest cache warm.
 *
 * The budget is deliberately well above the idle figure: this rises with how many
 * sessions are actively appending to their transcripts, and a machine mid-burst
 * must not fail a commit. It is here to catch a structural regression — a cache
 * that stops working, a directory walk added to the hot path — not to police noise.
 */
checks.push({
	name: 'collect() poll',
	unit: 'cpu-ms',
	budget: 12,
	was: 3.9,
	note: 'rises with session activity; catches a broken cache, not noise',
	measure: () =>
		run(`
			import { collect } from './src/data.ts'
			collect()
			const c = process.cpuUsage(); const N = 15
			for (let i = 0; i < N; i++) collect()
			const u = process.cpuUsage(c)
			console.log((u.user + u.system) / 1000 / N)
		`),
})

/**
 * The SECOND harness on the same poll, against a history the size of a year's use.
 *
 * The gate above calls `collect()` with no argument, which means Codex is off — so the
 * check that exists to "catch a directory walk added to the hot path" could not see the
 * directory walk that was added to the hot path. That is the same mistake this project
 * already recorded about `--bench` forcing images off: a benchmark that measures the
 * wrong path is worse than none, because it is trusted.
 *
 * Measured against a FIXTURE rather than `~/.codex`, so the number does not depend on
 * how much Codex the person running this happens to have used. A thousand rollouts is
 * about a year at the rate this machine accumulates them.
 *
 * The first implementation walked and statted every rollout ever written on every poll:
 * 3.91 cpu-ms at 45 files, 10.46 at 500, 22.36 at 2000, with ONE live thread throughout
 * — and Codex never deletes rollouts. Remembering each thread's path made it flat.
 */
checks.push({
	name: 'codex poll @ 1000 rollouts',
	unit: 'cpu-ms',
	budget: 3,
	was: 22.4,
	note: 'must not scale with history; one live thread among a year of files',
	measure: () =>
		run(`
			import fs from 'node:fs'
			import os from 'node:os'
			import path from 'node:path'
			import { codexSessions, resetCodexCache } from './src/data/codex.ts'
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-perf-codex-'))
			const dir = path.join(root, 'sessions'), locks = path.join(root, 'locks')
			fs.mkdirSync(locks, { recursive: true })
			const NL = String.fromCharCode(10)
			const rec = (t, p) => JSON.stringify({ type: t, payload: p ?? { type: t } })
			let first = ''
			for (let i = 0; i < 1000; i++) {
				const id = i.toString(16).padStart(8, '0') + '-1111-2222-3333-444444444444'
				if (!first) first = id
				const at = path.join(dir, '2026', String((i % 12) + 1).padStart(2, '0'), String((i % 28) + 1).padStart(2, '0'))
				fs.mkdirSync(at, { recursive: true })
				const body = [rec('session_meta', { id, cwd: '/x/projects/p' + (i % 7) })]
				for (let k = 0; k < 8; k++) body.push(rec('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 200000 } }))
				body.push(rec('event_msg', { type: 'task_started' }), rec('event_msg', { type: 'task_complete' }))
				fs.writeFileSync(path.join(at, 'rollout-2026-08-20T10-00-00-' + id + '.jsonl'), body.join(NL) + NL)
			}
			// One live thread, deliberately the OLDEST file: a session open for months is
			// the case that defeats any date-based shortcut.
			fs.writeFileSync(path.join(locks, first + '.lock'), '')
			resetCodexCache()
			codexSessions(Date.now(), dir, locks)
			const c = process.cpuUsage(); const N = 15
			for (let i = 0; i < N; i++) codexSessions(Date.now(), dir, locks)
			const u = process.cpuUsage(c)
			fs.rmSync(root, { recursive: true, force: true })
			console.log((u.user + u.system) / 1000 / N)
		`),
})

/**
 * The room at the browser's scale, which is where the pixel loop hurt.
 *
 * The terminal renders a far smaller grid, so the terminal frame check above does
 * not cover this. It was 17.7ms — over a 60fps budget on its own, meaning the loop
 * saturated a core and could not keep up.
 */
checks.push({
	name: 'renderRoom @ browser scale',
	unit: 'cpu-ms/frame',
	budget: 20,
	was: 9.9,
	note: 'was 17.7; reads 16.2 at load 27, so the ceiling covers that',
	measure: () =>
		run(`
			import { Canvas } from './src/canvas.ts'
			import { renderRoom } from './src/render.ts'
			import { Office } from './src/office.ts'
			import { collect } from './src/data.ts'
			const sessions = collect()
			const off = new Office(104, 48)
			const cv = new Canvas(104 * 4, 48 * 4)
			cv.clear([40, 38, 52])
			off.draw(cv, sessions)
			const scene = { props: off.props, monitors: off.monitors, badges: off.badges, logos: off.logos, plates: [] }
			for (let i = 0; i < 20; i++) renderRoom(cv, scene, [], 4, 8, 2)
			const c = process.cpuUsage(); const N = 60
			for (let i = 0; i < N; i++) renderRoom(cv, scene, [], 4, 8, i % 4)
			const u = process.cpuUsage(c)
			console.log((u.user + u.system) / 1000 / N)
		`),
})

/**
 * Perpetual CSS animations, counted rather than timed.
 *
 * No flakiness at all, and it guards a cost that is invisible locally and expensive
 * on a phone left open: an always-running animation costs roughly 15% of a core
 * whether or not anyone is looking at it. One is deliberate — the `sweep` on a
 * working session, transform-only and therefore composited. A second one should be
 * a decision, not an accident.
 */
checks.push({
	name: '@keyframes in built css',
	unit: 'count',
	budget: 1,
	was: 1,
	note: 'sweep only, transform-only so it composites',
	measure: () => (readFileSync(join(ROOT, 'web/app.css'), 'utf8').match(/@keyframes/g) ?? []).length,
})

/**
 * The browser bundle, which a phone downloads over a tailnet.
 *
 * Static, so it never flakes. Here because the client is the part that runs on the
 * slowest hardware in the picture.
 */
checks.push({
	name: 'web/app.js',
	unit: 'KB',
	budget: 170,
	was: 118,
	note: 'downloaded by a phone',
	measure: () => Math.round(statSync(join(ROOT, 'web/app.js')).size / 1024),
})

let failed = 0
const rows = []
for (const c of checks) {
	let value
	try {
		value = c.measure()
	} catch (e) {
		rows.push([c.name, 'ERROR', `${c.budget}`, c.unit, String(e).split('\n')[0].slice(0, 60)])
		failed++
		continue
	}
	const over = !Number.isFinite(value) || value > c.budget
	if (over) failed++
	rows.push([c.name, Number.isInteger(value) ? String(value) : value.toFixed(2), `${c.budget}`, c.unit, `${over ? 'OVER — ' : ''}${c.note}`])
}

const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), ['check', 'now', 'budget', ''][i].length))
console.log(`  ${'check'.padEnd(w[0])}  ${'now'.padStart(w[1])}  ${'budget'.padStart(w[2])}  ${''.padEnd(w[3])}`)
for (const r of rows) console.log(`  ${r[0].padEnd(w[0])}  ${r[1].padStart(w[1])}  ${r[2].padStart(w[2])}  ${r[3].padEnd(w[3])}  ${r[4]}`)

if (report) process.exit(0)
if (failed) {
	console.error(`\nperf budget: ${failed} over. Either make it cheaper, or change the budget in tools/check-perf.mjs and say why in the commit.`)
	process.exit(1)
}
console.log('\nperf budget: within limits')

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
 * MEASURED IN CPU TIME, NOT WALL CLOCK. This machine routinely sits at a load
 * average above 10 with a dozen Claude sessions running, and wall clock under that
 * is noise: the same benchmark varied 2.36 to 17.7ms depending on what else was
 * happening. CPU time held to ±3% across runs at the same load, which is what makes
 * a threshold enforceable rather than flaky.
 *
 * Thresholds sit at roughly 1.7x the measured value — tight enough to catch the
 * regressions that actually happened here (all of which were 3x or worse), loose
 * enough that an unlucky run does not block a commit.
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
	budget: 3.0,
	was: 1.7,
	note: 'was 5.6 before choose() was memoised',
	measure: () =>
		median(
			[1, 2, 3].map(() => {
				// bench reports on STDERR, deliberately — its stdout is the frame dump.
				// Reading only stdout here produced a silent NaN, which the budget then
				// reported as a breach: a check that cannot measure must say so loudly,
				// not fail closed with a number nobody can explain.
				const r = spawnSync('npm', ['run', '--silent', 'bench'], { cwd: ROOT, encoding: 'utf8' })
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
 * The room at the browser's scale, which is where the pixel loop hurt.
 *
 * The terminal renders a far smaller grid, so the terminal frame check above does
 * not cover this. It was 17.7ms — over a 60fps budget on its own, meaning the loop
 * saturated a core and could not keep up.
 */
checks.push({
	name: 'renderRoom @ browser scale',
	unit: 'cpu-ms/frame',
	budget: 16,
	was: 9.9,
	note: 'was 17.7 — over the 60fps budget by itself',
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
			const scene = { props: off.props, monitors: off.monitors, badges: off.badges, plates: [] }
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

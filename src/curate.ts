/**
 * Pick the most mutually-distinguishable creatures out of the 180 in the set.
 *
 * The tiles ship ordered in colour-variant families, so taking the first N gives
 * you near-duplicates. Greedy farthest-point selection on perceptual distance
 * picks a set where even the closest pair is far apart, which is what actually
 * matters — one confusable pair is enough to make you misread the town.
 *
 * Run with: npm run curate
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePNG, alphaBounds, resamplePixelArt } from './png.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TILES = path.join(ROOT, 'assets/tiny-creatures/Tiles')
const OUT = path.join(ROOT, 'assets/creatures.json')
const GRID = 12 // compare at 12x12; finer than that measures noise, not identity
const WANT = Number(process.argv[2]) || 36

type Lab = [number, number, number]

function toLab(r: number, g: number, b: number): Lab {
	// sRGB -> linear -> XYZ (D65) -> CIELAB
	const lin = (c: number) => {
		c /= 255
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}
	const [R, G, B] = [lin(r), lin(g), lin(b)]
	const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.9505
	const y = R * 0.2126 + G * 0.7152 + B * 0.0722
	const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.089
	const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
	const [fx, fy, fz] = [f(x), f(y), f(z)]
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** One creature reduced to a comparable fingerprint: LAB per cell, plus a mask. */
function fingerprint(file: string) {
	const img = decodePNG(file)
	const box = alphaBounds(img)
	const small = resamplePixelArt(img, box, GRID, GRID)
	const lab: (Lab | null)[] = []
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const c = small.grid[y][x]
			lab.push(c ? toLab(c[0], c[1], c[2]) : null)
		}
	}
	return lab
}

/**
 * Distance between two creatures. Cells opaque in both contribute their colour
 * difference; cells opaque in only one contribute a flat silhouette penalty, so
 * shape difference counts as well as colour.
 */
function distance(a: (Lab | null)[], b: (Lab | null)[]) {
	let sum = 0
	for (let i = 0; i < a.length; i++) {
		const p = a[i]
		const q = b[i]
		if (p && q) sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
		else if (p || q) sum += 40 // silhouette mismatch
	}
	return sum / a.length
}

const files = fs
	.readdirSync(TILES)
	.filter((f) => f.endsWith('.png'))
	.sort()
const prints = files.map((f) => fingerprint(path.join(TILES, f)))

// pairwise matrix once, then greedy farthest-point
const D: number[][] = files.map(() => new Array(files.length).fill(0))
for (let i = 0; i < files.length; i++) {
	for (let j = i + 1; j < files.length; j++) {
		D[i][j] = D[j][i] = distance(prints[i], prints[j])
	}
}

// seed with the single most distinctive tile (largest mean distance to all others)
const means = D.map((row) => row.reduce((a, b) => a + b, 0) / (row.length - 1))
const picked = [means.indexOf(Math.max(...means))]
while (picked.length < Math.min(WANT, files.length)) {
	let best = -1
	let bestScore = -Infinity
	for (let i = 0; i < files.length; i++) {
		if (picked.includes(i)) continue
		// score a candidate by its distance to the NEAREST already-picked creature:
		// maximising that is what pushes the worst pair apart
		const nearest = Math.min(...picked.map((p) => D[i][p]))
		if (nearest > bestScore) ((bestScore = nearest), (best = i))
	}
	if (best < 0) break
	picked.push(best)
}

const worstPair = (idx: number[]) => {
	let worst = Infinity
	for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length; j++) worst = Math.min(worst, D[idx[i]][idx[j]])
	return worst
}

const chosen = picked.map((i) => files[i])
const sequential = files.slice(0, picked.length).map((_, i) => i)
fs.writeFileSync(OUT, JSON.stringify(chosen, null, '\t') + '\n')

console.log(`${files.length} tiles → picked ${chosen.length}`)
console.log(`  worst pair, curated:    ${worstPair(picked).toFixed(1)}`)
console.log(`  worst pair, first ${String(picked.length).padStart(2)}:   ${worstPair(sequential).toFixed(1)}  (what you get without curating)`)
console.log(`wrote ${path.relative(ROOT, OUT)}`)

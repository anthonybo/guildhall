import assert from 'node:assert/strict'
import test from 'node:test'
import { frameOf } from './characters.ts'
import { TIERS } from './theme.ts'
import { loadSheets } from './sheets.ts'

// frameOf no longer reads the disk itself, so the sheets have to be supplied —
// that split is what lets the browser share this module
loadSheets()

test('the level badge is pinned on the shirt, never floating beside it', () => {
	for (const pose of ['typing', 'walk', 'reading'] as const) {
		for (const facing of ['down', 'up', 'right', 'left'] as const) {
			const plain = frameOf(0, 0, facing, pose, 0)
			const badged = frameOf(0, 0, facing, pose, 0, TIERS[4].color)
			let changed = 0
			let onBody = 0
			for (let y = 0; y < plain.h; y++) {
				for (let x = 0; x < plain.w; x++) {
					const a = plain.grid[y][x]
					const b = badged.grid[y][x]
					if (JSON.stringify(a) === JSON.stringify(b)) continue
					changed++
					// every changed pixel must already have been part of the character
					if (a) onBody++
				}
			}
			assert.ok(changed > 0, `${facing}/${pose} got no badge`)
			assert.equal(changed, onBody, `${facing}/${pose} painted the badge off the body`)
		}
	}
})

test('each tier produces a visibly different badge', () => {
	const seen = new Set<string>()
	for (const t of TIERS) {
		const g = frameOf(0, 0, 'down', 'typing', 0, t.color)
		seen.add(JSON.stringify(g.grid))
	}
	assert.equal(seen.size, TIERS.length, 'two tiers render identically')
})

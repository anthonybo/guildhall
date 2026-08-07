/** Readability of the list's computed colour pairs. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { contrast, mix, readable } from './contrast.ts'
import { LOOK, projectColours, type RGB } from './theme.ts'

const PANEL: RGB = [34, 31, 46]
const BG: RGB = [25, 23, 34]
/** the same ramp list.ts paints with */
const WEIGHT: Record<string, number> = { error: 0.26, needs: 0.22, working: 0.16, shell: 0.16, review: 0.11, done: 0.07, parked: 0.03 }

test('a colour that already reads is left alone', () => {
	// the whole point is to move as little as possible: nudging a hue that is
	// already legible would drift the palette for nothing
	const white: RGB = [255, 255, 255]
	assert.deepEqual(readable(white, PANEL), white)
})

test('a colour that does not read is lifted until it does, and no further', () => {
	// brightwater's hue measures 4.18 on a working card — a nudge, not a rewrite
	const dim: RGB = [228, 96, 92]
	const card = mix(LOOK.working.color as RGB, 0.16, PANEL)
	assert.ok(contrast(dim, card) < 4.5, 'fixture no longer reproduces the problem')
	const fixed = readable(dim, card)
	assert.ok(contrast(fixed, card) >= 4.5, `lifted colour still measures ${contrast(fixed, card).toFixed(2)}`)
	// it stops at the floor rather than going white: more than a little over means
	// the search overshot and the hue has been washed out
	assert.ok(contrast(fixed, card) < 5.0, `overshot to ${contrast(fixed, card).toFixed(2)}`)
})

test('every project hue reads on every band it can land on', () => {
	// The failure this exists for: the list tints each card by its status, so one
	// fixed text colour cannot serve nine different backgrounds. Measured before
	// the fix, 32 of these pairs were under the floor and the worst was 2.15.
	const projects = ['brightwater', 'tidepool', 'saltmarsh', 'willow', 'quillfeather', 'quillfeather', 'ironwood', 'foxglove']
	const hues = projectColours(projects)
	for (const state of Object.keys(WEIGHT)) {
		const card = mix(LOOK[state as keyof typeof LOOK].color as RGB, WEIGHT[state], PANEL)
		for (const p of projects) {
			const r = contrast(readable(hues.get(p)!, card), card)
			assert.ok(r >= 4.5, `${p} on a ${state} card measures ${r.toFixed(2)}`)
		}
		// the status word and the context figure sit on the same card
		for (const [what, c] of [
			['state', LOOK[state as keyof typeof LOOK].color as RGB],
			['hot', [255, 95, 95] as RGB],
		] as [string, RGB][]) {
			const r = contrast(readable(c, card), card)
			assert.ok(r >= 4.5, `${what} on a ${state} card measures ${r.toFixed(2)}`)
		}
	}
})

test('band headings read against the page, not the panel', () => {
	// a band is tinted into the page background rather than a card, so it is a
	// different pairing and has to be checked separately
	for (const state of Object.keys(WEIGHT)) {
		const band = mix(LOOK[state as keyof typeof LOOK].color as RGB, WEIGHT[state], BG)
		const r = contrast(readable(LOOK[state as keyof typeof LOOK].color as RGB, band), band)
		assert.ok(r >= 4.5, `${state} heading measures ${r.toFixed(2)}`)
	}
})

test('the colours list.ts computes with match the ones the stylesheet paints', () => {
	// list.ts has to do arithmetic on the palette — it lifts text against the wash
	// each card ends up with — so it holds numeric copies of four values that
	// web/src.css also declares. Nothing else keeps them in step, and a silent
	// divergence would mean every contrast decision was made against a background
	// the page does not actually have.
	const css = fs.readFileSync(new URL('../web/src.css', import.meta.url), 'utf8')
	const ts = fs.readFileSync(new URL('../web/list.ts', import.meta.url), 'utf8')
	const hex = (name: string) => {
		const m = new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`).exec(css)
		assert.ok(m, `web/src.css no longer declares --color-${name}`)
		return [1, 3, 5].map((i) => parseInt(`#${m[1]}`.slice(i, i + 2), 16))
	}
	const tuple = (name: string) => {
		const m = new RegExp(`const ${name}: RGB = \\[(\\d+), ?(\\d+), ?(\\d+)\\]`).exec(ts)
		assert.ok(m, `web/list.ts no longer declares ${name}`)
		return [Number(m[1]), Number(m[2]), Number(m[3])]
	}
	for (const [tsName, cssName] of [
		['BG', 'bg'],
		['PANEL', 'panel'],
		['FAINT', 'faint'],
		['MUTED', 'muted'],
	]) {
		assert.deepEqual(tuple(tsName), hex(cssName), `${tsName} in list.ts has drifted from --color-${cssName}`)
	}
})

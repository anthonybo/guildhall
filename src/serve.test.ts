import assert from 'node:assert/strict'
import test from 'node:test'
import { load } from './config.ts'
import { summary } from './table.ts'
import { panel } from './help.ts'
import { demoSessions } from './demo.ts'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('sharing is off unless someone turned it on', () => {
	// a network listener must never appear by default: most people watching their
	// own sessions on their own machine do not want one, and the cost of it being
	// on unnoticed is that what they are working on becomes readable
	const cfg = load()
	assert.equal(typeof cfg.serve, 'boolean')
	// the shipped default, whatever the local machine happens to have saved
	const { serve } = JSON.parse(JSON.stringify({ serve: false, port: 4318, host: '0.0.0.0' }))
	assert.equal(serve, false)
})

test('the sharing badge is never the first thing a narrow header drops', () => {
	// it was: the header was one string clipped from the end, so "this machine is
	// answering on the network" vanished before the status counts did
	const s = demoSessions()
	for (const w of [150, 120, 100, 80, 60]) {
		const line = strip(summary(s, w, { armed: true, holding: true }, '', { on: true, port: 4318 }))
		assert.match(line, /sharing/, `lost the sharing badge at ${w} columns`)
		assert.ok(line.length <= w, `header overflowed ${w}`)
	}
})

test('nothing is announced when sharing is off', () => {
	const s = demoSessions()
	const line = strip(summary(s, 150, { armed: true, holding: false }, '', { on: false, port: 4318 }))
	assert.doesNotMatch(line, /sharing/, 'announced a listener that is not running')
})

test('a failed listener says so rather than looking off', () => {
	const s = demoSessions()
	const line = strip(summary(s, 150, { armed: true, holding: false }, '', { on: false, port: 4318, error: 'port 4318 in use' }))
	assert.match(line, /share failed/)
})

test('the help panel explains what sharing exposes', () => {
	// somebody deciding whether to turn this on needs to know what it hands over
	const t = strip(panel(100, 60).join(' '))
	assert.match(t, /off by default/)
	assert.match(t, /read session titles|filenames being edited/, 'does not say what is exposed')
	assert.match(t, /never|public internet/, 'does not bound where it is reachable')
	assert.match(t, /passcode/, 'does not mention authentication')
})

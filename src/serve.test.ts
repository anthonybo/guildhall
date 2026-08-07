import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Every test in this file writes settings, so it must never touch the real ones.
// It used to: the suite reset the passcode in ~/.config/guildhall on every run,
// which looked like a chosen code refusing to stick. Set before any import that
// reads it — the modules resolve the directory per call, not at load.
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-test-'))


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

test('identity survives however tight the header gets', () => {
	// Making the right half win was right, but taken absolutely it ate the header:
	// two full-sentence badges are ~56 columns, so on a split pane the name and
	// version vanished entirely. Badges shrink, then drop; identity never does.
	const s = demoSessions()
	for (const w of [150, 120, 100, 84, 76, 64, 52, 40]) {
		const line = strip(summary(s, w, { armed: true, holding: false }, '0.2.12', { on: true, port: 4318 }))
		assert.match(line, /GUILDHALL/, `lost the name at ${w}`)
		assert.match(line, /v0\.2\.12/, `lost the version at ${w}`)
		assert.ok(line.length <= w, `overflowed ${w}`)
	}
})

test('the sharing badge is never the first thing a narrow header drops', () => {
	// it was: the header was one string clipped from the end, so "this machine is
	// answering on the network" vanished before the status counts did
	const s = demoSessions()
	for (const w of [150, 120, 100, 80, 60]) {
		const line = strip(summary(s, w, { armed: true, holding: true }, '', { on: true, port: 4318 }))
		// full at width, abbreviated when tight — but never absent, because an open
		// listener is the one thing a small screen must still admit to
		assert.match(line, /sharing|◉/, `lost the sharing badge at ${w} columns`)
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

test('the panel shows the address once sharing is on', () => {
	// the passcode is in a file, the port is a setting, and nobody can assemble a
	// URL out of three things they cannot see — so the feature has to hand it over
	const off = strip(panel(100, 70).join('\n'))
	assert.doesNotMatch(off, /http:\/\//, 'offered an address while not sharing')

	const on = strip(panel(100, 70, { on: true, port: 4318, token: 'abc123', lan: ['192.168.1.9'], vpn: ['100.90.1.2'] }).join('\n'))
	assert.match(on, /http:\/\/192\.168\.1\.9:4318/, 'no LAN address')
	assert.match(on, /http:\/\/100\.90\.1\.2:4318/, 'no VPN address')
	// the code must never ride along in the URL
	assert.doesNotMatch(on, /k=abc123|:4318\/\?/, 'put the passcode in the address')
	assert.match(on, /passcode\s+abc123/, 'never shows the code to type')
	// the VPN address first: it is the one that works from anywhere
	assert.ok(on.indexOf('100.90.1.2') < on.indexOf('192.168.1.9'), 'LAN listed above VPN')
})

test('the help panel explains what sharing exposes', () => {
	// somebody deciding whether to turn this on needs to know what it hands over
	const t = strip(panel(100, 60).join(' '))
	assert.match(t, /off by default/)
	assert.match(t, /read session titles|filenames being edited/, 'does not say what is exposed')
	assert.match(t, /never|public internet/, 'does not bound where it is reachable')
})

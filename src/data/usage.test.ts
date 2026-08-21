import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// never touch the real cache; set before the import that reads it
process.env.GUILDHALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-usage-'))

import { usage } from './usage.ts'

const file = () => path.join(process.env.GUILDHALL_CONFIG_DIR!, 'usage.json')
const put = (u: unknown) => fs.writeFileSync(file(), JSON.stringify(u))

test('the displayed cost is the sum of the harnesses', () => {
	put({ limits: [], claudeCost: 3.5, codexCost: 1.25, costAt: Date.now(), codexCostAt: Date.now(), at: Date.now() })
	// `usage()` reads the file; the total is what a reader sees as "today $X".
	const u = usage()!
	assert.equal(u.claudeCost, 3.5)
	assert.equal(u.codexCost, 1.25)
	// The figure a person actually reads as "today $X" — the claim, not the parts.
	assert.equal(u.cost, 4.75, 'the displayed total is not the sum of the harnesses')
})

test('a cache written before Codex existed keeps its figure as the Claude part', () => {
	// The upgrade path. An old file has `cost` and no parts, and that number is the
	// Claude spend — it must not be dropped, and it must not be counted twice.
	put({ limits: [], cost: 2.75, costAt: Date.now(), at: Date.now() })
	const u = usage()!
	assert.equal(u.cost, 2.75, 'the existing figure vanished on upgrade')
})

test('two writes in a row do not compound the total', () => {
	// The trap this design exists to avoid: if each fetch ADDED its figure to the
	// running total, the second pass would double-count. The parts are stored and the
	// total is derived, so writing twice is idempotent.
	put({ limits: [], claudeCost: 4, codexCost: 1, at: Date.now() })
	const first = usage()!
	put(first)
	const second = usage()!
	assert.equal(second.claudeCost, 4, 'the Claude part moved')
	assert.equal(second.codexCost, 1, 'the Codex part moved')
	assert.ok((second.cost ?? 0) <= 5.001, `total compounded to ${second.cost}`)
})

test('each half has its own clock, so one cannot silence the other', () => {
	// The lesson already in this file for the quota and the cost: a shared timestamp
	// meant a quota refresh kept declaring the spend fresh, and it was never fetched.
	put({ limits: [], claudeCost: 1, costAt: Date.now(), at: Date.now() })
	const u = usage()!
	assert.equal(u.codexCostAt, undefined, 'the Codex clock was set by a Claude fetch')
})

test.after(() => fs.rmSync(process.env.GUILDHALL_CONFIG_DIR!, { recursive: true, force: true }))

test('a Codex figure does not shorten the Claude backoff', () => {
	// The bug adding a derived field created: `cost` is computed from the parts, so
	// once `codexCost` exists `cost` is defined even when the Claude fetch has never
	// succeeded — and the backoff test read that as "we have a number". A failing
	// fetch then retried on the 30-minute TTL instead of the 60-minute backoff.
	//
	// Asserted on the parts rather than by observing a spawn: what went wrong was a
	// condition reading the wrong field, and that is what this pins.
	put({ limits: [], codexCost: 1.5, codexCostAt: Date.now(), costAt: Date.now() - 40 * 60_000, at: Date.now() })
	const u = usage()!
	assert.equal(u.claudeCost, undefined, 'a Codex-only cache invented a Claude figure')
	assert.equal(u.cost, 1.5, 'the total should still report the one part it has')
})

test('the spend total does not ratchet up across quota refreshes', () => {
	// The bug a reviewer measured: the quota writes named their fields and carried
	// `cost` but not the parts, so the derived total was promoted into `claudeCost` and
	// the next Codex fetch added its figure on top. 12 became 14, then 16, every five
	// minutes — a money figure climbing on its own.
	put({ limits: [], claudeCost: 10, codexCost: 2, costAt: Date.now(), codexCostAt: Date.now(), at: Date.now() })
	assert.equal(usage()!.cost, 12)

	// A quota refresh, as `maybeQuota` performs it: spread the previous state, replace
	// the limits. The parts must survive it.
	const before = usage()!
	put({ ...before, limits: [{ title: 'five hours', percent: 10 }], at: Date.now() })
	const after = usage()!
	assert.equal(after.claudeCost, 10, 'the Claude part was overwritten by the total')
	assert.equal(after.codexCost, 2, 'the Codex part was dropped')
	assert.equal(after.cost, 12, `the total grew to ${after.cost} without a single new fetch`)
})

test('a combined total is never promoted to the Claude part', () => {
	// Belt and braces for the same bug: even if a write does drop the parts, a cache
	// that has ever fetched Codex carries `codexCostAt`, and that is enough to know
	// `cost` is a combined figure rather than a Claude one.
	put({ limits: [], cost: 12, codexCostAt: Date.now(), costAt: Date.now(), at: Date.now() })
	assert.equal(usage()!.claudeCost, undefined, 'a combined total was promoted and will be added to again')
})

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

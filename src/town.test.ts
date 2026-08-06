import assert from 'node:assert/strict'
import test from 'node:test'
import { Canvas, Town } from './town.ts'
import type { Session, State } from './data.ts'

function session(id: string, proj: string, state: State): Session {
	return {
		id,
		pid: 1,
		name: id,
		proj,
		cwd: `/x/${proj}`,
		state,
		stale: 1000,
		title: `work on ${proj}`,
		doing: 'doing a thing',
		last: 'said a thing',
		ctxUsed: 50_000,
		ctxLimit: 200_000,
		tab: 1,
		unread: false,
		creature: 'tile_0001.png',
	}
}

const positions = (t: Town, cv: Canvas) =>
	t
		.draw(cv)
		.map((p) => `${p.s.id}@${p.x},${p.y}`)
		.join(' ')

test('drawing does not move anybody — only tick() does', () => {
	const cv = new Canvas(100, 60)
	const town = new Town(100, 60)
	town.layout([session('a', 'alpha', 'working'), session('b', 'beta', 'done')])
	const first = positions(town, cv)
	// a keypress redraws; it must not advance the simulation
	for (let i = 0; i < 20; i++) assert.equal(positions(town, cv), first, 'redraw moved a creature')
})

test('resize keeps creatures where they were', () => {
	const cv = new Canvas(100, 60)
	const town = new Town(100, 60)
	const list = [session('a', 'alpha', 'working')]
	town.layout(list)
	for (let i = 0; i < 40; i++) town.tick() // let it walk to the door
	const settled = positions(town, cv)
	// re-laying out on the 2s data poll must not teleport anyone
	town.layout(list)
	assert.equal(positions(town, cv), settled, 'a data refresh reset a position')
})

test('a parked session stays indoors', () => {
	const cv = new Canvas(100, 60)
	const town = new Town(100, 60)
	town.layout([session('a', 'alpha', 'parked'), session('b', 'alpha', 'working')])
	const drawn = town.draw(cv)
	assert.deepEqual(
		drawn.map((p) => p.s.id),
		['b'],
	)
	assert.equal(town.lots[0].indoors, 1)
})

test('every rendered row is exactly the canvas width', () => {
	const cv = new Canvas(100, 60)
	const town = new Town(100, 60)
	town.layout([session('a', 'alpha', 'needs'), session('b', 'beta', 'working')])
	town.overlay(cv, town.draw(cv))
	for (const line of cv.render()) {
		const bare = [...line.replace(/\x1b\[[0-9;]*m/g, '')].length
		assert.equal(bare, 100, `row was ${bare} columns, expected 100`)
	}
})

/**
 * Shared fixtures for the office tests. A seeded generator keeps every
 * behavioural assertion reproducible: the simulation is deliberately random, so
 * an unseeded failure would be unreproducible and therefore useless.
 */
import { Canvas } from '../canvas.ts'
import { Office } from '../office.ts'
import type { Session, State } from '../data/types.ts'

/** Seeded LCG so every behavioural test is reproducible. */
export const seeded = (seed = 12345) => {
	let s = seed >>> 0
	return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)
}

export function session(id: string, proj: string, state: State): Session {
	return {
		id,
		pid: 1,
		xp: 0,
		name: id,
		proj,
		cwd: `/x/${proj}`,
		state,
		stale: 60_000,
		title: `work on ${proj}`,
		doing: 'editing a file',
		short: 'Editing a file',
		last: 'said a thing',
		ctxUsed: 50_000,
		ctxLimit: 200_000,
		tab: 1,
		unread: false,
		toolKind: 'edit' as const,
		turns: 40,
		level: 5,
		palette: 0,
		hueShift: 0,
	}
}

export const room = (list: Session[], w = 88, h = 76) => {
	const cv = new Canvas(w, h)
	const office = new Office(seeded())
	office.fit(cv.w, cv.h, list)
	office.assign(list)
	return { cv, office }
}

export const desks = (o: Office) => [...o.spots.values()].filter((s) => s.kind === 'desk')
export const seatOf = (o: Office, id: string) => o.spots.get(o.chars.get(id)!.seatId!)!
export const posOf = (o: Office, id: string) => {
	const c = o.chars.get(id)!
	return `${c.col},${c.row},${c.state}`
}


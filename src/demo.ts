/**
 * A fictional office, for documentation and for trying the app with nothing running.
 *
 * Every name, sentence and number here is invented. The README images are built
 * from this rather than from a real machine, so they are reproducible, contain
 * nobody's project names or half-finished thoughts, and stay honest about what the
 * app shows — the layout is the real layout, only the contents are made up.
 *
 * Spread is deliberate: something working, something blocked on a human, something
 * with a nearly full context window, and a long tail of parked work. A screenshot
 * where everything is green teaches nothing about what the states look like.
 */
import type { Session, State } from './data.ts'
import { assignLooks } from './characters.ts'

type Sketch = {
	proj: string
	state: State
	doing: string
	title: string
	level: number
	turns: number
	ctxPct: number
	idleMin: number
	tab: number
	waitingFor?: string
	unread?: boolean
}

const CAST: Sketch[] = [
	{ proj: 'tidepool', state: 'working', doing: '$ cargo test --workspace', title: 'Port the parser to streaming input', level: 34, turns: 1840, ctxPct: 61, idleMin: 0, tab: 1 },
	{ proj: 'kestrel', state: 'working', doing: 'editing scheduler.go', title: 'Fair-share scheduling for the job queue', level: 22, turns: 910, ctxPct: 44, idleMin: 0, tab: 2 },
	{ proj: 'lanternfish', state: 'needs', doing: 'permission prompt', title: 'Migrate the billing tables', level: 18, turns: 620, ctxPct: 38, idleMin: 4, tab: 3, waitingFor: 'permission prompt' },
	{ proj: 'orchard', state: 'needs', doing: 'Should the importer skip malformed rows or fail loudly?', title: 'CSV importer for the admin console', level: 15, turns: 480, ctxPct: 52, idleMin: 11, tab: 4, waitingFor: 'answer a question' },
	{ proj: 'saltmarsh', state: 'shell', doing: '$ npm run build', title: 'Ship the docs site', level: 12, turns: 310, ctxPct: 93, idleMin: 1, tab: 5 },
	{ proj: 'brightwater', state: 'review', doing: 'Both deployed and verified against staging.', title: 'Retry policy for webhook delivery', level: 20, turns: 700, ctxPct: 47, idleMin: 6, tab: 6, unread: true },
	{ proj: 'foxglove', state: 'done', doing: 'Committed and pushed.', title: 'Dark mode for the dashboard', level: 9, turns: 210, ctxPct: 29, idleMin: 24, tab: 7 },
	{ proj: 'ironwood', state: 'parked', doing: 'Cleaned up and committed.', title: 'Replace the cron runner', level: 13, turns: 350, ctxPct: 33, idleMin: 190, tab: 8 },
	{ proj: 'quillfeather', state: 'parked', doing: 'v0.4.1 is live.', title: 'Release automation', level: 7, turns: 160, ctxPct: 21, idleMin: 640, tab: 9 },
	{ proj: 'wrenhaven', state: 'parked', doing: 'Moved the seed data into fixtures.', title: 'Test fixtures for the API suite', level: 4, turns: 90, ctxPct: 18, idleMin: 1500, tab: 10 },
]

const KIND: Record<string, Session['toolKind']> = {
	tidepool: 'run',
	kestrel: 'edit',
	lanternfish: 'edit',
	orchard: 'think',
	saltmarsh: 'run',
	brightwater: 'read',
	foxglove: 'edit',
	ironwood: 'search',
	quillfeather: 'agent',
	wrenhaven: 'read',
}

/** A short label for the character's head, matching what the real one would say. */
const SHORT: Record<State, (d: string) => string> = {
	working: (d) => (d.startsWith('$') ? `Running ${d.slice(2).split(' ')[0]}` : 'Editing'),
	shell: (d) => `Running ${d.slice(2).split(' ')[0]}`,
	needs: () => 'Needs you',
	review: () => '',
	done: () => '',
	parked: () => '',
	error: () => '',
}

export function demoSessions(): Session[] {
	const looks = assignLooks(CAST.map((c) => c.proj))
	return CAST.map((c) => {
		const limit = 200_000
		return {
			id: c.proj,
			pid: 1000 + c.tab,
			name: c.proj,
			proj: c.proj,
			cwd: `/Users/you/projects/${c.proj}`,
			state: c.state,
			waitingFor: c.waitingFor,
			stale: c.idleMin * 60_000,
			title: c.title,
			doing: c.doing,
			short: SHORT[c.state](c.doing),
			last: c.doing,
			ctxUsed: Math.round((c.ctxPct / 100) * limit),
			ctxLimit: limit,
			tab: c.tab,
			unread: !!c.unread,
			toolKind: KIND[c.proj] ?? 'think',
			turns: c.turns,
			level: c.level,
			xp: Math.round(c.level ** 3 / 3),
			palette: looks.get(c.proj)?.palette ?? 0,
			hueShift: looks.get(c.proj)?.hueShift ?? 0,
		}
	})
}

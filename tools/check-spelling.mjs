#!/usr/bin/env node
/**
 * American spellings in anything a reader sees.
 *
 * This repo is written in US English and the prose kept drifting British —
 * "colour", "behaviour", "licence" — because whoever is typing does not notice.
 * Every other rule here that mattered got a check, and this one had none, so it
 * had to be caught by eye every time and was caught late.
 *
 * Two kinds of file are scanned:
 *
 *  - MARKDOWN, all of it, because it is prose end to end.
 *  - QUOTED STRINGS in `src/` and `web/`, which is what the program puts on
 *    screen. Code identifiers are deliberately NOT scanned: `colourOf` is an API
 *    name in office.ts, renaming it is a refactor rather than a spelling fix, and
 *    a check that demands one to pass would just get switched off.
 *
 * Word boundaries are the whole difficulty. An early version listed `arse` and
 * flagged `parsed` and `git rev-parse`; a list that cries wolf is a list somebody
 * disables. Every entry here is anchored, and anything genuinely ambiguous was
 * dropped rather than guessed at.
 *
 * `allow-uk: <why>` on the line exempts it, and the reason is required — same
 * shape as check-secrets, for the same reason: an exemption should be a decision
 * somebody made, not a habit.
 *
 *     node tools/check-spelling.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** British -> American. Only pairs where the American form is unambiguous. */
const SWAP = {
	colour: 'color',
	coloured: 'colored',
	colours: 'colors',
	behaviour: 'behavior',
	behaviours: 'behaviors',
	favour: 'favor',
	honour: 'honor',
	labour: 'labor',
	neighbour: 'neighbor',
	rumour: 'rumor',
	humour: 'humor',
	armour: 'armor',
	flavour: 'flavor',
	endeavour: 'endeavor',
	centre: 'center',
	centred: 'centered',
	metre: 'meter',
	fibre: 'fiber',
	calibre: 'caliber',
	organise: 'organize',
	organised: 'organized',
	organisation: 'organization',
	realise: 'realize',
	realised: 'realized',
	recognise: 'recognize',
	recognised: 'recognized',
	memoise: 'memoize',
	memoised: 'memoized',
	prioritise: 'prioritize',
	normalise: 'normalize',
	normalised: 'normalized',
	minimise: 'minimize',
	maximise: 'maximize',
	optimise: 'optimize',
	customise: 'customize',
	summarise: 'summarize',
	apologise: 'apologize',
	emphasise: 'emphasize',
	utilise: 'utilize',
	analyse: 'analyze',
	analysed: 'analyzed',
	paralyse: 'paralyze',
	visualise: 'visualize',
	visualised: 'visualized',
	visualisation: 'visualization',
	licence: 'license',
	defence: 'defense',
	offence: 'offense',
	pretence: 'pretense',
	travelled: 'traveled',
	travelling: 'traveling',
	cancelling: 'canceling',
	modelled: 'modeled',
	labelled: 'labeled',
	signalled: 'signaled',
	marvellous: 'marvelous',
	grey: 'gray',
	programme: 'program',
	aeroplane: 'airplane',
	storey: 'story',
	sceptical: 'skeptical',
	whilst: 'while',
	amongst: 'among',
	judgement: 'judgment',
	acknowledgement: 'acknowledgment',
	ageing: 'aging',
}

const WORDS = new RegExp(`\\b(${Object.keys(SWAP).join('|')})\\b`, 'gi')
/**
 * What the program SAYS: single- and double-quoted strings only.
 *
 * Backticks are excluded on purpose. In a comment they wrap code — `colourOf` is
 * a real API name in office.ts — so including them turned every honest reference
 * to an identifier into a spelling error, which is how a check earns its way into
 * being ignored.
 */
const SPOKEN = /'([^'\n]{6,})'|"([^"\n]{6,})"/g

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
		const full = path.join(dir, e.name)
		if (e.isDirectory()) walk(full, out)
		else out.push(full)
	}
	return out
}

const hits = []
for (const file of walk(ROOT)) {
	const rel = path.relative(ROOT, file)
	const markdown = file.endsWith('.md')
	// Tests are excluded: their names are read by whoever runs the suite, not by a
	// user, and `test('a colour is kept')` is not prose anybody ships.
	const code = /^(src|web)\//.test(rel) && /\.(ts|tsx|html)$/.test(file) && !/\.test\.ts$/.test(file)
	// app.js and app.css are generated from web/ sources; flagging both would
	// report every hit twice and the fix only ever belongs upstream.
	if (/^web\/app\.(js|css)$/.test(rel)) continue
	if (!markdown && !code) continue

	const lines = fs.readFileSync(file, 'utf8').split('\n')
	lines.forEach((line, i) => {
		if (/allow-uk:/.test(line)) return
		// Comments are not what the program says. They are where the reasoning lives,
		// and that reasoning frequently names identifiers spelled the other way.
		if (!markdown && /^\s*(\/\/|\*|\/\*)/.test(line)) return
		// In code, only what is inside quotes — never an identifier. In markdown,
		// everything EXCEPT inline code spans, for the same reason backticks are
		// excluded above: `colourOf` in prose is naming a symbol, not misspelling a
		// word, and this file has to be able to quote the words it bans.
		const subject = markdown ? line.replace(/`[^`]*`/g, ' ') : [...line.matchAll(SPOKEN)].map((m) => m[1] ?? m[2] ?? m[3]).join(' ')
		if (!subject) return
		for (const m of subject.matchAll(WORDS)) {
			const word = m[0].toLowerCase()
			hits.push(`${rel}:${i + 1}  ${m[0]} -> ${SWAP[word]}`)
		}
	})
}

if (hits.length) {
	console.error('British spellings in text a reader sees:\n')
	for (const h of hits) console.error(`  ${h}`)
	console.error(`\n${hits.length} to fix. If one is genuinely correct — an API value, a quoted name — put \`allow-uk: <why>\` on the line.`)
	process.exit(1)
}
console.log('spelling: US English')

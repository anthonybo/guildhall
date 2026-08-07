/**
 * The table under the town.
 *
 * Column order follows k9s: identity, then health, then the one free-text column,
 * then numbers, with age last. The flex column sits immediately left of the
 * numerics on purpose — a variable-width column with fixed columns on both sides
 * transmits its ragged edge in both directions, which is what makes a terminal
 * table look "all over the place".
 */
import { C, LOOK, R, ago, bg, bold, clip, fg, gauge, levelGlyph, padL, padR, tierOf, tokens, width, type RGB } from './theme.ts'
import { BUILD } from './version.ts'
import { cut, needsAttention, order, type Session } from './data.ts'

export type Row = { s: Session; line: string }

const GUTTER = 2
const W_TAB = 4
const W_PROJ = 13
const W_STATE = 2 + Math.max(...Object.values(LOOK).map((l) => l.label.length))
const W_CTX = 12
const W_IDLE = 4
const W_LVL = 2

/**
 * Identity is never dropped.
 *
 * The project column used to disappear below 84 columns, which left a row
 * identified only by a tab number — you could read what a session was doing but
 * not which one it was, and the table has one job. It narrows instead, and the
 * context gauge is what goes when there is genuinely no room: a bar you cannot
 * read is worth less than knowing whose row you are looking at.
 */
export function tableWidths(total: number) {
	const proj = total >= 84 ? W_PROJ : total >= 62 ? 9 : 7
	const showCtx = total >= 70
	const fixed = GUTTER + W_TAB + W_LVL + proj + W_STATE + (showCtx ? W_CTX : 0) + W_IDLE
	const gaps = showCtx ? 7 : 6
	return { proj, showCtx, flex: Math.max(10, total - fixed - gaps) }
}

export function header(total: number) {
	const { proj, showCtx, flex } = tableWidths(total)
	const cells = [
		' '.repeat(GUTTER),
		padL('TAB', W_TAB),
		padL('LV', W_LVL),
		padR('PROJECT', proj),
		padR('STATUS', W_STATE),
		padR('DOING NOW', flex),
		showCtx ? padR('CONTEXT', W_CTX) : '',
		padL('IDLE', W_IDLE),
	].filter((c) => c !== '')
	return `${fg(C.faint)}${cells.join(' ')}${R}`
}

/**
 * `colourOf` is the room's own project colour — the same hue as that project's
 * carpet and nameplate upstairs. Sharing it makes the two halves of the screen one
 * view: a character you notice in the office has a row down here in the same
 * colour, and scanning the table for a project becomes a colour match rather than
 * reading ten near-identical grey words.
 */
export function rows(list: Session[], total: number, selected?: string, colourOf?: (proj: string) => RGB): Row[] {
	const { proj: wProj, showCtx, flex } = tableWidths(total)
	return order(list).map((s) => {
		const look = LOOK[s.state]
		const attention = needsAttention(s)
		const sel = s.id === selected
		const frac = s.ctxUsed / s.ctxLimit
		// the gutter is reserved for one thing only: a column that is blank on
		// nine rows out of ten is the loudest thing on the screen
		const gutter = attention ? `${fg(LOOK.needs.color)}▸${R} ` : '  '
		const ctx = s.ctxUsed
			? `${gauge(frac, 6)} ${fg(frac > 0.9 ? C.fillHot : C.muted)}${padL(`${Math.round(frac * 100)}%`, 4)}${R}`
			: `${fg(C.faint)}${padR('', W_CTX)}${R}`
		const cells = [
			gutter,
			`${fg(C.faint)}${padL(s.tab ? `⌘${s.tab}` : '·', W_TAB)}${R}`,
			// level is identity, so it sits beside the tab rather than with the status
			`${bg(tierOf(s.level).color)}${fg(C.night)}${padL(levelGlyph(s.level), W_LVL)}${R}`,
			// the project's own colour from the room, and bold — this is the column you
			// scan down, so it has to win against the sentence beside it
			`${bold}${fg(colourOf?.(s.proj) ?? C.label)}${padR(cut(s.proj, wProj), wProj)}${R}`,
			`${fg(look.color)}${padR(`${look.glyph} ${look.label}`, W_STATE)}${R}`,
			`${fg(s.state === 'parked' ? C.muted : C.label)}${padR(cut(s.doing || '—', flex), flex)}${R}`,
			showCtx ? padR(ctx, W_CTX) : '',
			`${fg(C.faint)}${padL(ago(s.stale), W_IDLE)}${R}`,
		].filter((c) => c !== '')
		const line = cells.join(' ')
		return { s, line: sel ? `${bg(C.selBg)}${padR(clip(line, total), total)}${R}` : clip(line, total) }
	})
}

/** One line spelling out the selected session, where there is room for a sentence. */
export function detail(s: Session | undefined, total: number) {
	if (!s) return ['', '']
	const ctx = s.ctxUsed ? `${tokens(s.ctxUsed)}/${tokens(s.ctxLimit)} context` : 'no context yet'
	const meta = `${s.proj}${s.tab ? ` · ⌘${s.tab}` : ''} · lv${s.level} ${tierOf(s.level).name} · ${s.turns} turns · ${ctx}`
	return [
		clip(`${fg(C.gold)}◆ ${fg(C.label)}${bold}${cut(s.title, Math.max(20, total - width(meta) - 6))}${R}  ${fg(C.faint)}${meta}${R}`, total),
		clip(`${fg(C.muted)}  ${cut(s.doing || s.last || '—', total - 4)}${R}`, total),
	]
}

/**
 * The keep-awake state, in three states rather than two.
 *
 * "Armed but nobody working" and "switched off" are different facts with the same
 * consequence right now, and conflating them means you cannot tell a disabled
 * feature from a quiet room. Each state carries three redundant signals — colour,
 * glyph and wording — so it survives a colour-blind reader or a mono terminal,
 * and every colour is one of the measured-contrast values rather than a dim grey.
 *
 * OFF is amber, not grey: it is the state in which you can lose an overnight
 * build, which is worth noticing rather than hiding.
 */
export function awakeBadge({ armed, holding }: { armed: boolean; holding: boolean }) {
	// The rule, not the switch position. "awake ON" invited the reading that the
	// machine would never sleep, when what it actually promises is narrower: sleep
	// is blocked WHILE something is working, and released the moment it stops.
	// Naming the condition is the whole job of this badge.
	if (holding) return `${fg(C.fillOk)}●${fg(C.label)} ${bold}holding awake${R}${fg(C.fillOk)} · work in progress${R}`
	if (armed) return `${fg(C.screenEdit)}◐${fg(C.label)} awake ${bold}when working${R}${fg(C.screenEdit)} · idle, may sleep${R}`
	return `${fg(C.fillWarn)}○${fg(C.label)} ${bold}sleeps normally${R}${fg(C.fillWarn)} · never held${R}`
}

/**
 * `build` is overridable so the documentation image can leave it out. Baking the
 * commit hash into a screenshot means the file changes on every single commit,
 * which buries a real appearance change in noise — the picture should move when
 * the app looks different, not when anything at all happens.
 */
export type Share = { on: boolean; port: number; error?: string }

/**
 * Sharing is only ever shown when it is ON, or when it failed to start.
 *
 * The opposite of the awake badge, deliberately. Awake has three states you want
 * to tell apart at a glance; sharing has one state worth announcing — that this
 * machine is currently answering on the network — and saying "off" on every other
 * frame would train the eye to ignore the place the warning appears.
 */
function shareBadge(share?: Share) {
	if (share?.error) return `  ${fg(C.fillHot)}⚠ share failed${fg(C.muted)} · ${share.error}${R}`
	if (!share?.on) return ''
	return `  ${fg(C.screenAgent)}◉ ${bold}sharing${R}${fg(C.screenAgent)} · :${share.port}${R}`
}

export function summary(list: Session[], total: number, awake: { armed: boolean; holding: boolean }, build = BUILD, share?: Share) {
	const counts: Record<string, number> = {}
	for (const s of list) counts[s.state] = (counts[s.state] ?? 0) + 1
	const pills = (['error', 'needs', 'working', 'shell', 'review', 'done', 'parked'] as const)
		.filter((k) => counts[k])
		.map((k) => `${fg(LOOK[k].color)}${LOOK[k].glyph}${fg(C.label)} ${counts[k]} ${LOOK[k].label}${R}`)
	// Two halves, and the RIGHT one wins. Everything was one string clipped from
	// the end, so on a 120-column terminal the machine-state badges fell off — the
	// "this is answering on the network" warning was the very first thing to go,
	// which is exactly backwards. Counts are recoverable by looking at the room;
	// whether a listener is open is not.
	const stamp = build ? `${fg(C.faint)}v${build}${R}  ` : ''
	const right = `${awakeBadge(awake)}${shareBadge(share)}`
	const head = `${bold}${fg(C.gold)} GUILDHALL ${R}${stamp}${fg(C.faint)}${list.length} sessions${R}`
	const room = total - width(right) - 2
	if (room < 20) return clip(right.trimStart(), total)

	// Drop whole pills rather than slicing one in half. Character-clipping left a
	// bare glyph with no count attached — a mark that means nothing and reads as a
	// rendering fault rather than as "there was not room for this".
	let used = width(head)
	const kept: string[] = []
	for (const p of pills) {
		const next = used + 2 + width(p)
		if (next > room) break
		kept.push(p)
		used = next
	}
	return `${clip(head + (kept.length ? '  ' + kept.join('  ') : ''), room)}  ${right}`
}

export function footer(
	total: number,
	hidden: number,
	faultsOnly: boolean,
	mode: string,
	awake: { armed: boolean; holding: boolean } = { armed: true, holding: false },
) {
	// `a awake on` read as a claim that awake WAS on, when it meant "press this to
	// turn it on" — the exact opposite of the truth. Every other hint here names an
	// action, so this one does too, and it carries the state colour because the
	// footer is where you are looking when you reach for the key.
	const dot = awake.holding ? C.fillOk : awake.armed ? C.screenEdit : C.fillWarn
	const glyph = awake.holding ? '●' : awake.armed ? '◐' : '○'
	const verb = awake.armed ? 'allow sleep' : 'keep awake'
	const awakeHint = `${fg(C.faint)}a ${fg(dot)}${glyph} ${verb}${R}`

	// `?` comes FIRST, in gold. The line is clipped from the right, so anything at
	// the tail is what a narrow terminal loses — and the hint for "how do I find
	// out what any of this means" is the last thing that should disappear.
	const bits = ['↑↓ move', '⏎ jump to tab', `f ${faultsOnly ? 'all' : 'faults'}`, `tab ${mode}`]
	const tailBits = ['r redraw', 'q quit']
	const line =
		` ${bold}${fg(C.gold)}? help${R}${fg(C.faint)}  ·  ${bits.join('  ·  ')}  ·  ${R}${awakeHint}${fg(C.faint)}  ·  ${tailBits.join('  ·  ')}${R}`
	const tail = hidden ? `  ${fg(C.faint)}+${hidden} not seated${R}` : ''
	return clip(`${line}${tail}`, total)
}

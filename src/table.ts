/**
 * The table under the town.
 *
 * Column order follows k9s: identity, then health, then the one free-text column,
 * then numbers, with age last. The flex column sits immediately left of the
 * numerics on purpose — a variable-width column with fixed columns on both sides
 * transmits its ragged edge in both directions, which is what makes a terminal
 * table look "all over the place".
 */
import { C, LOOK, R, ago, bg, bold, clip, fg, gauge, levelGlyph, padL, padR, tierOf, tokens, width } from './theme.ts'
import { VERSION } from './version.ts'
import { cut, needsAttention, order, type Session } from './data.ts'

export type Row = { s: Session; line: string }

const GUTTER = 2
const W_TAB = 4
const W_PROJ = 13
const W_STATE = 2 + Math.max(...Object.values(LOOK).map((l) => l.label.length))
const W_CTX = 12
const W_IDLE = 4
const W_LVL = 2

export function tableWidths(total: number) {
	// drop the project column on narrow terminals rather than starving the flex one
	const showProj = total >= 84
	const fixed = GUTTER + W_TAB + W_LVL + (showProj ? W_PROJ : 0) + W_STATE + W_CTX + W_IDLE
	const gaps = showProj ? 7 : 6
	return { showProj, flex: Math.max(12, total - fixed - gaps) }
}

export function header(total: number) {
	const { showProj, flex } = tableWidths(total)
	const cells = [
		' '.repeat(GUTTER),
		padL('TAB', W_TAB),
		padL('LV', W_LVL),
		showProj ? padR('PROJECT', W_PROJ) : '',
		padR('STATUS', W_STATE),
		padR('DOING NOW', flex),
		padR('CONTEXT', W_CTX),
		padL('IDLE', W_IDLE),
	].filter((c) => c !== '')
	return `${fg(C.faint)}${cells.join(' ')}${R}`
}

export function rows(list: Session[], total: number, selected?: string): Row[] {
	const { showProj, flex } = tableWidths(total)
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
			showProj ? `${fg(C.muted)}${padR(cut(s.proj, W_PROJ), W_PROJ)}${R}` : '',
			`${fg(look.color)}${padR(`${look.glyph} ${look.label}`, W_STATE)}${R}`,
			`${fg(s.state === 'parked' ? C.muted : C.label)}${padR(cut(s.doing || '—', flex), flex)}${R}`,
			padR(ctx, W_CTX),
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
	if (holding) return `${fg(C.fillOk)}●${fg(C.label)} awake ${bold}ON${R}${fg(C.fillOk)} · holding${R}`
	if (armed) return `${fg(C.screenEdit)}◐${fg(C.label)} awake ${bold}ON${R}${fg(C.screenEdit)} · idle${R}`
	return `${fg(C.fillWarn)}○${fg(C.label)} awake ${bold}OFF${R}${fg(C.fillWarn)} · may sleep${R}`
}

export function summary(list: Session[], total: number, awake: { armed: boolean; holding: boolean }) {
	const counts: Record<string, number> = {}
	for (const s of list) counts[s.state] = (counts[s.state] ?? 0) + 1
	const pills = (['error', 'needs', 'working', 'shell', 'review', 'done', 'parked'] as const)
		.filter((k) => counts[k])
		.map((k) => `${fg(LOOK[k].color)}${LOOK[k].glyph}${fg(C.label)} ${counts[k]} ${LOOK[k].label}${R}`)
	const hold = `  ${awakeBadge(awake)}`
	const left = `${bold}${fg(C.gold)} GUILDHALL ${R}${fg(C.faint)}v${VERSION}${R}  ${fg(C.faint)}${list.length} sessions${R}  ${pills.join('  ')}${hold}`
	return clip(left, total)
}

export function footer(total: number, hidden: number, faultsOnly: boolean, mode: string, awakeArmed = true) {
	const bits = [
		'↑↓ move',
		'⏎ jump to tab',
		`f ${faultsOnly ? 'all' : 'faults'}`,
		`tab ${mode}`,
		// what the key DOES, not what the state is — the header already says the state
		`a awake ${awakeArmed ? 'off' : 'on'}`,
		'r redraw',
		'q quit',
	]
	const tail = hidden ? `  ${fg(C.faint)}+${hidden} not seated${R}` : ''
	return clip(`${fg(C.faint)} ${bits.join('  ·  ')}${R}${tail}`, total)
}

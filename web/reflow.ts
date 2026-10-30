/**
 * Undo the terminal's line breaks where they were only the pane running out of width,
 * so a narrow session's prose can fill a wide browser. Pure: render_grid in, logical
 * lines out. No DOM.
 *
 * Why it has to be done this way: Claude Code (an Ink TUI) word-wraps its own text at the
 * pane's width and writes every break as a real newline, so the terminal has no
 * soft-wrap to undo and no viewer can reflow it — tmux, ttyd and the asciinema player
 * all either resize the source or pad the view. A 47-column pane in a 1,950px panel
 * left two thirds of it empty, and drawing the 47 columns bigger was tried three times
 * and rejected each time (grid.ts, MISTAKES.md).
 *
 * A row is joined to the next only when the terminal could not have fitted the next
 * row's first word on it (greedy word wrap, the rule Ink's wrap-ansi uses), the next row
 * sits at the paragraph's continuation indent, and neither row is something whose
 * meaning is in its columns. Measured on 13 real screens, 47 to 100 columns, against the
 * sessions' own transcripts: 134 joins checked, none wrong, under 1 cpu-ms a screen.
 */

type Style = { id: number; foreground?: string; foreground_source?: string; background?: string; background_source?: string; inverse?: boolean }
type Span = { row: number; column: number; style_id: number; text: string }
type Grid = { rows: number; columns: number; styles: Style[]; row_spans: Span[]; terminal_background?: string; terminal_foreground?: string }

/** One output line: `rows` is every terminal row it came from. A `fixed` line is one row
 *  drawn exactly as the terminal has it. `hang` is the column continuation rows started
 *  at, for a hanging indent; `indent` is where the first row's text starts. */
export type Line = { rows: number[]; fixed: boolean; indent: number; hang: number; runs: Span[] }

const PLACEHOLDER = '\u{10EEEE}'
const BOX = /[─-▟]/
/** A marker that starts an item; its continuation rows hang under the text after it.
 *  "※ recap: " hangs at 2, not under the text after the label: measured. The spinner's
 *  "✻ Cogitated for 44m · done · 1 shell still running" wraps the same way. */
const MARKER = /^(⏺ |⎿  |※ |❯ |✦ |[✻✶✳✢✽] |[-*•] |\d+[.)] |[a-z][.)] )/
/** Anything that starts a new thing rather than continuing a sentence. */
const STARTS_NEW = /^(⏺|⎿|✻|✶|✳|✢|·|※|❯|✦|✔|✘|⚠|[-*•] |\d+[.)] |\[|\|)/
/** A line-numbered code/diff row from a Read or Edit result: "   258  code", "  937 -- x". */
const GUTTER = /^\s{2,}\d+ [ +-]/
const ELLIPSIS = /^\s{3,}(\.\.\.|… \d+ more lines?)/
/** Ink sometimes wraps one cell short of the edge; with no slack three real joins were
 *  missed in the measurement. */
const SLACK = 1

const width = (s: string) => [...s].length

type Row = { r: number; spans: Span[]; text: string; indent: number; end: number; blank: boolean }

export function reflow(g: Grid): Line[] {
	const byId = new Map(g.styles.map((s) => [s.id, s]))
	const per: Span[][] = Array.from({ length: g.rows }, () => [])
	for (const sp of g.row_spans) per[sp.row]?.push(sp)
	const rows: Row[] = per.map((raw, r) => {
		raw.sort((a, b) => a.column - b.column)
		// Gaps between spans are cells too: cmux leaves default-styled blanks out, so the
		// space between two words can be a gap rather than a character. Made explicit, or
		// a joined line loses its spaces ("onthe Mac" — caught on the first printout).
		const spans: Span[] = []
		let text = ''
		let col = 0
		for (const sp of raw) {
			if (sp.column > col) {
				spans.push({ row: r, column: col, style_id: 0, text: ' '.repeat(sp.column - col) })
				text += ' '.repeat(sp.column - col)
			}
			spans.push(sp)
			text += sp.text
			col = sp.column + width(sp.text)
		}
		const t = text.trimEnd()
		return { r, spans, text: t, indent: width(t) - width(t.trimStart()), end: width(t), blank: t.trim() === '' }
	})

	// Everything from the input box's top rule down is the input box and status bar.
	const rules = rows.filter((x) => /^\s*─{20,}\s*$/.test(x.text)).map((x) => x.r)
	const fixedFrom = rules.length >= 2 ? rules.at(-2)! : rules.length ? rules.at(-1)! : g.rows

	const nonDefault = (st: Style | undefined, which: 'background' | 'foreground') => {
		if (!st) return false
		const src = st[`${which}_source`]
		if (src !== undefined) return src !== 'default'
		const v = st[which]
		return !!v && v !== (which === 'background' ? g.terminal_background : g.terminal_foreground)
	}
	const coloured = (row: Row) => row.spans.some((sp) => sp.text.trim() && (byId.get(sp.style_id)?.inverse || nonDefault(byId.get(sp.style_id), 'background')))
	// Syntax highlighting: two or more HUES on one row. A code block's keywords, strings
	// and numbers are each their own color (blue, red, yellow, green); prose has at most
	// one accent, plus grays for secondary text and sometimes an explicit white. Measured:
	// on a real 47-column code block joining merged three statements onto one line, and a
	// first version that counted grays and white as colors stopped prose joining on six
	// of twelve other screens.
	const hue = (c: string | undefined) => {
		const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c ?? '')
		if (!m || c!.toUpperCase() === (g.terminal_foreground ?? '').toUpperCase()) return null
		const [r, gr, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16))
		return Math.max(r!, gr!, b!) - Math.min(r!, gr!, b!) < 24 ? null : c!.toUpperCase()
	}
	const highlighted = (row: Row) => {
		const seen = new Set<string>()
		for (const sp of row.spans) {
			const st = byId.get(sp.style_id)
			const h = sp.text.trim() && nonDefault(st, 'foreground') ? hue(st!.foreground) : null
			if (h) seen.add(h)
		}
		return seen.size >= 2
	}

	// Code: a gutter row starts a code view and the deeper-indented rows after it belong to
	// it; and within a block — the run of rows between blank lines — everything from its
	// first highlighted row to its last. Not the whole block: a one-line colored hint
	// ("✔ Update installed") sitting under a recap with no blank row between made the
	// recap code too, measured. The known gap: plain-white code lines AFTER a block's last
	// highlighted row are not covered, so one that reached the edge would join the next.
	// A real block is highlighted throughout and none was seen; Exact is the way out.
	const code = new Array<boolean>(g.rows).fill(false)
	let codeIndent = -1
	for (const row of rows) {
		if (GUTTER.test(row.text) || ELLIPSIS.test(row.text)) {
			code[row.r] = true
			codeIndent = row.indent
			continue
		}
		if (codeIndent >= 0 && !row.blank && row.indent > codeIndent) code[row.r] = true
		else if (!row.blank) codeIndent = -1
	}
	// Only above the input box: the status bar is left alone anyway, and a paragraph
	// that runs straight into it with no blank row would otherwise share its colors.
	for (let i = 0; i < fixedFrom; ) {
		if (rows[i]!.blank) {
			i++
			continue
		}
		let j = i
		while (j < fixedFrom && !rows[j]!.blank) j++
		const lit = rows.slice(i, j).filter(highlighted).map((x) => x.r)
		if (lit.length) for (let k = lit[0]!; k <= lit.at(-1)!; k++) code[k] = true
		i = j
	}

	const fixed = (row: Row) =>
		row.r >= fixedFrom ||
		row.blank ||
		BOX.test(row.text) ||
		row.text.includes(PLACEHOLDER) ||
		(row.indent >= g.columns / 3 && row.end >= g.columns - 3) ||
		coloured(row) ||
		code[row.r]!

	const out: Line[] = []
	let cur: Line | null = null
	let prev: Row | null = null
	for (const row of rows) {
		if (fixed(row)) {
			cur = null
			prev = null
			out.push({ rows: [row.r], fixed: true, indent: row.indent, hang: 0, runs: row.spans })
			continue
		}
		const body = row.text.slice(row.indent)
		if (cur && prev && joins(prev, row, cur.hang, body)) {
			cur.rows.push(row.r)
			// the row's own trailing blanks are layout, not text
			for (let k = cur.runs.length - 1; k >= 0; k--) {
				const t = cur.runs[k]!.text.trimEnd()
				cur.runs[k] = { ...cur.runs[k]!, text: t }
				if (t) break
			}
			// a word split mid-way (one token too long for the row) joins with no space
			const hard = prev.end >= g.columns - SLACK && !/\s/.test(prev.text.slice(cur.hang))
			const lead = row.spans.map((sp) => ({ ...sp }))
			// drop the continuation indent; mark the join with a space unless the word was split
			for (const sp of lead) {
				const t = sp.text.trimStart()
				sp.column += width(sp.text) - width(t)
				sp.text = t
				if (t) break
			}
			if (!hard) cur.runs.push({ row: row.r, column: row.indent - 1, style_id: lead[0]?.style_id ?? 0, text: ' ' })
			cur.runs.push(...lead.filter((s) => s.text !== ''))
			prev = row
			continue
		}
		const m = body.match(MARKER)
		cur = { rows: [row.r], fixed: false, indent: row.indent, hang: row.indent + (m ? width(m[0]) : 0), runs: row.spans.map((sp) => ({ ...sp })) }
		out.push(cur)
		prev = row
	}
	return out

	function joins(a: Row, b: Row, hang: number, body: string) {
		if (b.indent !== hang) return false
		if (STARTS_NEW.test(body)) return false
		// Split on a plain space only: Claude Code keeps "port 3000" together with a
		// no-break space, and so did the wrap that is being undone.
		const word = width(body.split(' ')[0] ?? '')
		// Greedy wrap: the next word would not have fitted on this row.
		return a.end + 1 + word > g.columns - SLACK
	}
}

/**
 * The shape of a reply, so it can be coloured instead of read.
 *
 * An assistant message arrives as one string and was drawn as one flat colour, which
 * makes a summary, a heading and a paragraph indistinguishable until you have read all
 * three. Reported as wanting "sections with color for context — my question could be a
 * color, the TL;DR could".
 *
 * These replies are written in a consistent shape — a bolded heading, bullets, fenced
 * code, a closing TL;DR — so that shape is worth recognising. This is NOT a markdown
 * renderer and must not become one: it finds the few structures that carry meaning
 * here and leaves everything else as prose. Anything it does not recognise stays a
 * paragraph, which is the safe direction to be wrong in.
 *
 * Its own file because `transcript.ts` was at 425 of this repository's 500 lines, and
 * free of the DOM so the rules can be tested — the same reason `links.ts` returns data
 * rather than nodes.
 */

/** A run of text inside a block. */
export type Inline = { text: string; strong?: true; code?: true }

export type Align = 'left' | 'right' | 'center'

export type Block =
	| { kind: 'tldr' | 'heading' | 'para' | 'quote'; runs: Inline[] }
	| { kind: 'bullet'; items: Inline[][] }
	| { kind: 'code'; text: string }
	| { kind: 'table'; head: Inline[][]; rows: Inline[][][]; align: Align[] }

/** `**bold**` and `` `code` ``, which are the only two that appear mid-sentence. */
export function inlines(text: string): Inline[] {
	const out: Inline[] = []
	// One pass over both, so `**a `b` c**` cannot be split by one rule and orphaned by
	// the other. Whichever opens first wins the run.
	const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
	let last = 0
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m.index > last) out.push({ text: text.slice(last, m.index) })
		if (m[1] !== undefined) out.push({ text: m[1], strong: true })
		else out.push({ text: m[2]!, code: true })
		last = m.index + m[0].length
	}
	if (last < text.length) out.push({ text: text.slice(last) })
	return out.length ? out : [{ text }]
}

/** A line that is nothing but bold, which is how a heading is written here. */
const BOLD_LINE = /^\s*\*\*(.+?)\*\*[:.]?\s*$/
const HASH = /^\s*#{1,6}\s+(.*)$/
/** `TL;DR`, `TLDR`, bolded or not, with or without the dash that usually follows. */
const TLDR = /^\s*\*{0,2}TL;?DR\*{0,2}\s*[—:-]*\s*/i
const BULLET = /^\s*[-*•]\s+(.*)$/
/**
 * The `|---|:--:|---:|` line under a table's header.
 *
 * A table is recognised by THIS line and nothing else. A pipe on its own means very
 * little — "run it | head -3", "a || b", a column of output — and treating any line
 * with a pipe as a table would wreck ordinary prose. The separator is unambiguous, and
 * requiring it is what makes the detection safe.
 */
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const HAS_PIPE = /\|/

/** Cells of one row, with the outer pipes dropped. */
function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((c) => c.trim())
}

/** `:---`, `---:` and `:---:` are left, right and centre. */
function aligns(rule: string): Align[] {
	return cells(rule).map((c) => {
		const left = c.startsWith(':')
		const right = c.endsWith(':')
		return right && left ? 'center' : right ? 'right' : 'left'
	})
}
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*```/

/**
 * Split a reply into blocks.
 *
 * Order matters: a fence swallows everything until it closes, so a bullet or a heading
 * inside a code sample is left alone rather than being styled as prose.
 */
export function blocks(text: string): Block[] {
	const out: Block[] = []
	const lines = text.split('\n')
	let para: string[] = []
	let bullets: Inline[][] = []

	const flushPara = () => {
		if (!para.length) return
		const joined = para.join('\n').trim()
		para = []
		if (!joined) return
		// A paragraph that opens with TL;DR is the summary, however it was written.
		if (TLDR.test(joined)) out.push({ kind: 'tldr', runs: inlines(joined.replace(TLDR, '')) })
		else out.push({ kind: 'para', runs: inlines(joined) })
	}
	const flushBullets = () => {
		if (!bullets.length) return
		out.push({ kind: 'bullet', items: bullets })
		bullets = []
	}
	const flush = () => {
		flushPara()
		flushBullets()
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		if (FENCE.test(line)) {
			flush()
			const body: string[] = []
			i++
			for (; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!)
			out.push({ kind: 'code', text: body.join('\n') })
			continue
		}
		if (!line.trim()) {
			flush()
			continue
		}
		const hash = HASH.exec(line)
		const bold = BOLD_LINE.exec(line)
		if (hash || bold) {
			flush()
			out.push({ kind: 'heading', runs: inlines((hash?.[1] ?? bold?.[1] ?? '').trim()) })
			continue
		}
		// A table, if the NEXT line is a separator. Checked before quotes and bullets
		// because a cell may legitimately start with a dash or a chevron.
		const next = lines[i + 1]
		if (HAS_PIPE.test(line) && next !== undefined && RULE.test(next) && HAS_PIPE.test(next)) {
			flush()
			const head = cells(line).map(inlines)
			const align = aligns(next)
			const rows: Inline[][][] = []
			i += 2
			for (; i < lines.length && HAS_PIPE.test(lines[i]!) && lines[i]!.trim(); i++) {
				const row = cells(lines[i]!)
				// Ragged rows are normal in hand-written tables. Pad or trim to the header
				// so the columns cannot slip, which is the one thing a table must not do.
				while (row.length < head.length) row.push('')
				rows.push(row.slice(0, head.length).map(inlines))
			}
			i--
			out.push({ kind: 'table', head, rows, align })
			continue
		}
		const quote = QUOTE.exec(line)
		if (quote) {
			flush()
			out.push({ kind: 'quote', runs: inlines(quote[1] ?? '') })
			continue
		}
		const bullet = BULLET.exec(line)
		if (bullet) {
			flushPara()
			bullets.push(inlines(bullet[1] ?? ''))
			continue
		}
		flushBullets()
		para.push(line)
	}
	flush()
	return out
}

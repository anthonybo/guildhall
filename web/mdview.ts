/**
 * Drawing a reply's shape, so it can be found rather than read.
 *
 * `md.ts` decides what the blocks ARE; this decides what they look like, and the split
 * is the same one `links.ts` and `grid.ts` keep — rules that can be tested without a
 * browser on one side, DOM on the other.
 *
 * The colours are assigned so that no two things you are scanning for share one, and so
 * that content never borrows a colour the TOOL palette already means:
 *
 *   gold        you — your own messages, the landmarks
 *   cyan        a heading, the structure of a reply
 *   light green a TL;DR, the conclusion
 *   white       ordinary prose
 *   grey        quotes and bullet markers, which are punctuation rather than content
 *
 * Cyan is `TINT.read` and appears on tool rows too, which is a deliberate reuse rather
 * than a collision: a tool row is a caret, a name and parentheses inside an indented
 * run, and a heading is a bold line in the body. They are never adjacent and never
 * confusable, and inventing a sixth hue would have meant two vocabularies to learn.
 */
import { TINT } from '../src/screens.ts'
import { rgb } from './dom.ts'
import { linkParts } from './links.ts'
import { type Align, type Block, type Inline, blocks } from './md.ts'

/** Inline runs into nodes, with links found inside the plain ones. */
function runs(list: Inline[]): DocumentFragment {
	const frag = document.createDocumentFragment()
	for (const r of list) {
		if (r.code) {
			const code = document.createElement('code')
			// A chip, not a block: this is a flag or a filename mid-sentence.
			code.className = 'rounded-sm bg-bg/70 px-1 text-[0.72rem] text-newer'
			code.textContent = r.text
			frag.append(code)
			continue
		}
		const host = r.strong ? document.createElement('strong') : frag
		if (r.strong) (host as HTMLElement).className = 'font-bold text-label'
		// Links are found in prose only. A URL inside `code` is a literal, and
		// linkifying it would make a filename tappable.
		for (const part of linkParts(r.text)) {
			if (!part.href) {
				host.append(document.createTextNode(part.text))
				continue
			}
			const a = document.createElement('a')
			a.href = part.href
			a.textContent = part.text
			a.target = '_blank'
			a.rel = 'noopener noreferrer'
			a.className = 'text-newer underline decoration-dotted underline-offset-2'
			host.append(a)
		}
		if (r.strong) frag.append(host as HTMLElement)
	}
	return frag
}

function one(b: Block): HTMLElement {
	const el = document.createElement('div')
	if (b.kind === 'code') {
		el.className = 'mt-2 overflow-x-auto rounded border border-line bg-bg/70 px-2 py-1.5 text-[0.72rem] whitespace-pre text-muted'
		// Code does not wrap — it scrolls. Reflowing a command or a diff is how a line
		// you meant to copy becomes two lines that are wrong.
		el.textContent = b.text
		return el
	}
	if (b.kind === 'bullet') {
		el.className = 'mt-2'
		for (const item of b.items) {
			const row = document.createElement('div')
			row.className = 'flex gap-2 whitespace-pre-wrap break-words text-label'
			const dot = document.createElement('span')
			dot.className = 'shrink-0 text-muted'
			dot.textContent = '•'
			const body = document.createElement('span')
			body.className = 'min-w-0 flex-1'
			body.append(runs(item))
			row.append(dot, body)
			el.append(row)
		}
		return el
	}
	if (b.kind === 'heading') {
		el.className = 'mt-4 font-bold whitespace-pre-wrap break-words'
		el.style.color = rgb(TINT.read)
		el.append(runs(b.runs))
		return el
	}
	if (b.kind === 'tldr') {
		// The conclusion, and the thing most often scrolled for. It gets a rule, a
		// label and its own colour, because "where does this end up" is a different
		// question from "what happened" and should not have to be read for.
		el.className = 'mt-4 rounded-sm border-l-2 border-newer bg-bg/40 px-2 py-1.5 whitespace-pre-wrap break-words text-newer'
		const tag = document.createElement('span')
		tag.className = 'mr-2 text-[0.66rem] font-bold tracking-wide text-newer/80'
		tag.textContent = 'TL;DR'
		el.append(tag, runs(b.runs))
		return el
	}
	if (b.kind === 'table') {
		// A table is the one block that must NOT reflow: its meaning is the alignment of
		// a cell under its heading, and wrapping columns to fit a phone destroys exactly
		// that. So it scrolls sideways inside its own box — the page never scrolls, and
		// the comparison survives.
		el.className = 'mt-3 -mx-1 overflow-x-auto overscroll-x-contain'
		const table = document.createElement('table')
		table.className = 'w-max border-collapse text-[0.72rem]'
		const cell = (kind: 'th' | 'td', runsIn: Inline[], align: Align) => {
			const c = document.createElement(kind)
			c.className =
				kind === 'th'
					? 'border-b border-line px-2 py-1 text-left font-bold whitespace-nowrap'
					: 'border-b border-line/50 px-2 py-1 align-top text-label'
			if (align !== 'left') c.style.textAlign = align
			if (kind === 'th') c.style.color = rgb(TINT.read)
			c.append(runs(runsIn))
			return c
		}
		const thead = document.createElement('thead')
		const hr = document.createElement('tr')
		for (const [i, h] of b.head.entries()) hr.append(cell('th', h, b.align[i] ?? 'left'))
		thead.append(hr)
		const tbody = document.createElement('tbody')
		for (const row of b.rows) {
			const tr = document.createElement('tr')
			for (const [i, c] of row.entries()) tr.append(cell('td', c, b.align[i] ?? 'left'))
			tbody.append(tr)
		}
		table.append(thead, tbody)
		el.append(table)
		return el
	}
	if (b.kind === 'quote') {
		el.className = 'mt-2 border-l-2 border-line pl-2 whitespace-pre-wrap break-words text-muted italic'
		el.append(runs(b.runs))
		return el
	}
	el.className = 'mt-2 whitespace-pre-wrap break-words text-label'
	el.append(runs(b.runs))
	return el
}

/** A reply, drawn as its blocks. */
export function renderMarkdown(text: string): DocumentFragment {
	const frag = document.createDocumentFragment()
	for (const b of blocks(text)) frag.append(one(b))
	return frag
}

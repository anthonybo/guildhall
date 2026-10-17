/** How a stretch of tool work is drawn in the history: one folded line per run, each
 *  step opening onto its result or its change. Moved out of transcript.ts when it
 *  passed the 500-line rule. */
import { tap } from './dom.ts'
import { type Entry, toolName, toolTint, withLinks } from './transcripttools.ts'

/** One tool call, with its result folded underneath until asked for. */
export function step(call: Entry, result?: Entry): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'mt-1'
	const line = document.createElement('button')
	line.type = 'button'
	// A whole-width target. These sit in a list of similar lines on a phone, and a
	// small one is the difference between opening what you meant and the one below it.
	// `items-center`, not `items-start`. A 44px target around one line of 12px text
	// leaves ~24px of slack, and top-aligning the label pushed all of it BELOW the
	// text — so an opened result appeared to float, detached from the call it belongs
	// to. Centring splits the slack and the result sits against its line.
	line.className = 'flex w-full min-h-11 cursor-pointer items-center gap-2 rounded px-1 text-left'
	// Tinted by what the tool DOES, so a run can be scanned by colour instead of read.
	// A failure overrides it: something that went wrong is not first a "read" or an
	// "edit", it is a failure, and it should look like one.
	line.style.color = result?.error ? 'var(--color-hot)' : toolTint(call.tool)
	const caret = document.createElement('span')
	caret.className = 'shrink-0 text-muted'
	caret.textContent = result || call.before || call.after ? '▸' : '·'
	const label = document.createElement('span')
	label.className = 'min-w-0 flex-1 break-words'
	label.textContent = `${toolName(call.tool ?? 'tool')}${call.text ? `(${call.text})` : ''}`
	line.append(caret, label)

	const out = document.createElement('div')
	// Given its own ground and a heavier rule, so it reads as belonging to the line
	// above rather than as the next item in the list.
	out.className = 'mt-0.5 hidden rounded-sm border-l-2 bg-bg/60 px-2 py-1.5 text-[0.72rem] text-muted'
	// The rule carries the call's colour, so an opened output is tied to the line it
	// came from even when several are open at once.
	out.style.borderLeftColor = result?.error ? 'var(--color-hot)' : toolTint(call.tool)

	/**
	 * The change, where there was one.
	 *
	 * Opening an edit used to show its RECEIPT — "the file has been updated" — because
	 * that is what the tool returns. The code is in what was sent, not in what came
	 * back. Removed above added, red then green, each scrolling rather than wrapping:
	 * reflowed code is code you cannot trust to read.
	 */
	const chunk = (text: string, mark: string, colour: string) => {
		const box = document.createElement('div')
		// `whitespace-pre` belongs on the TEXT, not on the box. On the container it also
		// preserves the whitespace between child elements, which shows up as blank bands
		// above and below the code the moment anything appends a stray text node.
		box.className = 'mt-1 overflow-x-auto rounded-sm border-l-2 bg-bg/70 px-2 py-1 text-[0.7rem]'
		box.style.borderLeftColor = colour
		box.style.color = colour
		const tag = document.createElement('div')
		tag.className = 'text-[0.62rem] tracking-wide opacity-70'
		tag.textContent = mark
		const body = document.createElement('div')
		body.className = 'whitespace-pre text-label'
		body.textContent = text
		box.append(tag, body)
		return box
	}
	if (call.before) out.append(chunk(call.before, 'removed', 'var(--color-hot)'))
	if (call.after) out.append(chunk(call.after, call.before ? 'added' : 'written', 'var(--color-ok)'))
	if (result) {
		const said = document.createElement('div')
		said.className = 'mt-1 whitespace-pre-wrap break-words'
		said.append(withLinks(result.text || (result.error ? 'failed, with no output' : '')))
		out.append(said)
	}

	// Expandable when there is anything to show — the change counts, not just a result.
	if (result || call.before || call.after) {
		tap(line, () => {
			const open = out.classList.toggle('hidden')
			caret.textContent = open ? '▸' : '▾'
			line.setAttribute('aria-expanded', String(!open))
		})
		line.setAttribute('aria-expanded', 'false')
	} else {
		line.disabled = true
		line.className += ' cursor-default'
	}
	wrap.append(line, out)
	return wrap
}

/**
 * A run of tool work between two pieces of prose, as one line that opens.
 *
 * The summary has to be worth reading on its own, or it is just a door with nothing
 * written on it: it says how many steps ran and how many failed, so a run you do not
 * need can be skipped without opening it, and a run that went wrong announces itself.
 */
export function run(steps: { call: Entry; result?: Entry }[], open: boolean): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'mt-3'
	const failed = steps.filter((s) => s.result?.error).length
	const inner = document.createElement('div')
	inner.className = 'mt-1 border-l border-line pl-2'
	for (const s of steps) inner.append(step(s.call, s.result))

	const toggle = document.createElement('button')
	toggle.type = 'button'
	toggle.className =
		'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded border border-line/70 px-2 text-left text-[0.72rem] text-muted hover:border-gold hover:text-gold'
	const caret = document.createElement('span')
	// One dot per class of work in the run. A folded run is the common case, so it has
	// to say something without being opened: four blue dots is a stretch of editing,
	// orange is commands, and a red one is a failure — legible before the words are.
	const dots = document.createElement('span')
	dots.className = 'flex shrink-0 items-center gap-0.5'
	for (const k of [...new Set(steps.map((s) => (s.result?.error ? 'error' : toolTint(s.call.tool))))]) {
		const d = document.createElement('span')
		d.textContent = '\u25cf'
		d.style.color = k === 'error' ? 'var(--color-hot)' : k
		dots.append(d)
	}
	const words = document.createElement('span')
	words.className = 'min-w-0 flex-1 truncate'
	const names = [...new Set(steps.map((s) => toolName(s.call.tool ?? 'tool')))]
	const summary = `${steps.length} step${steps.length === 1 ? '' : 's'} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
	words.textContent = failed ? `${summary} · ${failed} failed` : summary
	if (failed) words.className = 'text-hot'
	toggle.append(caret, dots, words)

	const set = (open: boolean) => {
		inner.classList.toggle('hidden', !open)
		caret.textContent = open ? '▾' : '▸'
		toggle.setAttribute('aria-expanded', String(open))
	}
	set(open)
	tap(toggle, () => set(inner.classList.contains('hidden')))
	wrap.append(toggle, inner)
	return wrap
}

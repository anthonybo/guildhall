/** Small pieces the history view draws with: links in output, and how a tool is named
 *  and colored. Moved out of transcript.ts when it passed the 500-line rule. */
import { rgb } from './dom.ts'
import { linkParts } from './links.ts'
// The room's own tool palette, not a second one invented here. `TINT` is what paints a
// workstation screen by what the session is doing — "so the whole room is readable at a
// glance" — and `KIND` is the map from a tool's name to that class. Reusing both means
// a phone and the office agree about what blue means, and there is one place to change
// it. `screens.ts` is already in this bundle via list.ts, so it costs nothing.
import { TINT } from '../src/screens.ts'
import { KIND } from '../src/data/describe.ts'

/** One thing in the conversation, as the server's history page sends it. */
export type Entry = {
	at: string
	role: 'user' | 'assistant'
	kind: 'text' | 'thinking' | 'tool' | 'result' | 'image'
	text: string
	/** On an image: where to fetch it from — see historyimage.ts. */
	image?: string
	/** On your messages: where its line starts in the file, for the "You" list. */
	line?: number
	/** On your messages: sent while Claude was working. */
	queued?: true
	tool?: string
	id?: string
	for?: string
	error?: true
	/** The change an edit made: what was removed, and what replaced it. */
	before?: string
	after?: string
}

/** Terminal output is never innerHTML. Links are built as real nodes. */
export function withLinks(text: string): DocumentFragment {
	const frag = document.createDocumentFragment()
	for (const part of linkParts(text)) {
		if (!part.href) {
			frag.append(document.createTextNode(part.text))
			continue
		}
		const a = document.createElement('a')
		a.href = part.href
		a.textContent = part.text
		a.target = '_blank'
		// noopener because the opened page must not get a handle on this one, and
		// noreferrer because a session's output can contain private URLs.
		a.rel = 'noopener noreferrer'
		a.className = 'text-newer underline decoration-dotted underline-offset-2'
		frag.append(a)
	}
	return frag
}

/**
 * A tool's name, short enough for a phone.
 *
 * An MCP tool is named `mcp__claude-in-chrome__javascript_tool`, which is 38 characters
 * of mostly plumbing and wraps a 375px screen on its own. The server and the underscores
 * are what get dropped; the verb is what anybody is reading for.
 */
export const toolName = (raw: string) => raw.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '').replace(/_/g, ' ')

/**
 * The colour for a tool, by what class of work it is.
 *
 * Blue edits, cyan reads, orange runs, violet searches, green agents — the same five a
 * desk's monitor is tinted with in the room. A tool nobody has classified stays grey
 * rather than being guessed into a colour: a wrong colour is worse than no colour here,
 * because the whole point is that the colour can be trusted at a glance.
 */
export function toolTint(raw?: string): string {
	const kind = raw ? KIND[raw.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')] : undefined
	return kind ? rgb(TINT[kind]) : 'var(--color-muted)'
}

/**
 * Turning a tool call into words.
 *
 * Two registers, because the two places text appears have very different budgets.
 * `shortText` is a label floating over a character's head — a few words, matching
 * the vocabulary pixel-agents uses in its overlay (Reading / Editing / Writing /
 * Running / Searching). `doingText` fills the widest column in the table and can
 * afford the actual filename or command.
 */
import path from 'node:path'
import type { Digest, Session, State } from './types.ts'

const bn = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '?')

/** Collapse whitespace and ellipsize. Counts code points, so emoji survive. */
export const cut = (s: string, n: number) => {
	const t = (s ?? '').replace(/\s+/g, ' ').trim()
	return [...t].length > n ? [...t].slice(0, Math.max(0, n - 1)).join('') + '…' : t
}

/** Strip markdown and take the opening sentence — where a session left off. */
export function firstSentence(t?: string) {
	if (!t) return ''
	const s = t
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`#>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	const m = s.match(/^(.{8,140}?[.!?])(\s|$)/)
	return m ? m[1] : s
}

/** Directory hops and env setup are never what a session is "doing". */
function cleanCmd(c: unknown) {
	if (typeof c !== 'string') return null
	const s = c
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^cd\s+[^&;]+(&&|;)\s*/, '')
	if (/^(cd|export|source|\.)\s/.test(s) || s === 'cd') return null
	return s
}

/** Broad class of a tool, used to tint the workstation screen. */
export const KIND: Record<string, Session['toolKind']> = {
	Edit: 'edit',
	Write: 'edit',
	NotebookEdit: 'edit',
	Read: 'read',
	Bash: 'run',
	Grep: 'search',
	Glob: 'search',
	WebSearch: 'search',
	WebFetch: 'read',
	Task: 'agent',
	Agent: 'agent',
	Workflow: 'agent',
}

const SHORT: Record<string, (i: any) => string> = {
	Edit: (i) => `Editing ${bn(i.file_path)}`,
	Write: (i) => `Writing ${bn(i.file_path)}`,
	Read: (i) => `Reading ${bn(i.file_path)}`,
	NotebookEdit: (i) => `Editing ${bn(i.notebook_path)}`,
	Bash: (i) => {
		const c = cleanCmd(i.command) ?? ''
		// just the program and its first argument — "Running npm test"
		const words = c.split(' ').filter(Boolean).slice(0, 2).join(' ')
		return words ? `Running ${cut(words, 18)}` : 'Running a command'
	},
	Grep: () => 'Searching',
	Glob: () => 'Looking for files',
	Task: () => 'Running an agent',
	Agent: () => 'Running an agent',
	Workflow: () => 'Running a workflow',
	WebSearch: () => 'Searching the web',
	WebFetch: () => 'Fetching a page',
	TodoWrite: () => 'Planning',
	TaskCreate: () => 'Planning',
	ExitPlanMode: () => 'Presenting a plan',
	AskUserQuestion: () => 'Asking you something',
}

export function shortText(d: Digest, state: State, waitingFor?: string) {
	if (state === 'needs') return waitingFor === 'permission prompt' ? 'Needs approval' : 'Answer needed'
	if (state !== 'working' && state !== 'shell') return ''
	if (!d.tool) return 'Thinking'
	if (d.tool.startsWith('mcp__')) return cut(d.tool.split('__').slice(-1)[0], 20)
	return SHORT[d.tool]?.(d.toolInput ?? {}) ?? cut(d.tool, 20)
}

const SAY: Record<string, (i: any) => string | null> = {
	Edit: (i) => `editing ${bn(i.file_path)}`,
	Write: (i) => `writing ${bn(i.file_path)}`,
	Read: (i) => `reading ${bn(i.file_path)}`,
	NotebookEdit: (i) => `editing ${bn(i.notebook_path)}`,
	Bash: (i) => {
		const c = cleanCmd(i.command)
		return c ? `$ ${cut(c, 40)}` : null
	},
	Grep: (i) => `grep "${cut(String(i.pattern ?? ''), 22)}"`,
	Glob: (i) => `finding ${cut(String(i.pattern ?? ''), 22)}`,
	Task: () => 'sent out an agent',
	Agent: () => 'sent out an agent',
	Workflow: () => 'running a workflow',
	WebSearch: (i) => `searching "${cut(String(i.query ?? ''), 22)}"`,
	WebFetch: () => 'reading the web',
	TodoWrite: () => 'updating the plan',
	TaskCreate: () => 'updating the plan',
	ExitPlanMode: () => 'showing you a plan',
	AskUserQuestion: () => 'asking you something',
}

export function doingText(d: Digest, state: State, waitingFor?: string) {
	// repeating the status here wastes the widest column; show the question itself
	if (state === 'needs') return waitingFor ?? (d.asked ? firstSentence(d.text) || 'asked you something' : 'needs you')
	if (state === 'working' || state === 'shell') {
		if (!d.tool) return 'thinking…'
		if (d.tool.startsWith('mcp__')) return cut(d.tool.split('__').slice(1).join(' '), 28)
		const f = SAY[d.tool]
		return (f ? f(d.toolInput ?? {}) : cut(d.tool, 24)) || 'thinking…'
	}
	return firstSentence(d.text)
}

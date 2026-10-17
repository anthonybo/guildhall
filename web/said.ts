/** Which "user" messages in a transcript you actually typed, and how to show them. Pure: no DOM. */

/**
 * A "user" message that is not one you typed, as a one-line notice — or null.
 *
 * Claude Code writes several things into the conversation as if you had said them.
 * Counted over the 40 most recent transcripts here: 314 background-task
 * notifications, 64 "continued from an earlier conversation" summaries, 40
 * interruptions, and shell or slash-command output — against about 2,000 messages
 * actually typed. Drawn as yours they buried yours, which are the landmarks.
 */
export function inserted(text: string): string | null {
	const t = text.trimStart()
	const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(t)?.[1]?.trim()
	const short = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s)
	if (t.startsWith('<task-notification>')) return `⚙ background task — ${short(tag('summary') ?? tag('status') ?? 'finished')}`
	if (t.startsWith('This session is being continued')) return '⚙ earlier conversation summarized here'
	if (t.startsWith('[Request interrupted')) return '⚙ interrupted'
	if (t.startsWith('Caveat:')) return '⚙ note from Claude Code'
	for (const out of ['local-command-stdout', 'local-command-stderr', 'bash-stdout', 'bash-stderr']) {
		if (t.startsWith(`<${out}>`)) {
			const body = tag(out) ?? ''
			return body ? `⚙ output — ${short(body.replace(/\s+/g, ' '))}` : '⚙ output (empty)'
		}
	}
	return null
}

/** A command you typed, the way you typed it, instead of the tags it is stored in. */
export function typedForm(text: string): string {
	const t = text.trimStart()
	const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(t)?.[1]?.trim()
	const cmd = tag('command-name')
	if (cmd) return [cmd.startsWith('/') ? cmd : `/${cmd}`, tag('command-args')].filter(Boolean).join(' ')
	const sh = tag('bash-input')
	if (sh) return `! ${sh}`
	return text
}

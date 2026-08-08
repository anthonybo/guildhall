/**
 * The help overlay.
 *
 * Everything on screen is a glyph or a colour standing in for a sentence, which
 * is only legible once somebody has told you the sentence. This is that telling.
 *
 * It answers the questions actually asked of this app rather than restating the
 * key bindings: what "awake" promises (and does not), why a session can read
 * `working` when nothing is on screen, and what a level counts.
 */
import { C, LOOK, R, bold, clip, fg, tierOf, width } from './theme.ts'
import type { State } from './data.ts'
import { available } from './update.ts'

const PAD = 2

type Line = { text: string; kind?: 'title' | 'head' | 'dim' }

/** Colour a leading glyph, so the legend shows the mark you actually see. */
function stateLine(state: State, meaning: string) {
	const look = LOOK[state]
	return `${fg(look.color)}${look.glyph} ${look.label.padEnd(10)}${R}${fg(C.muted)}${meaning}${R}`
}

export type ShareInfo = {
	on: boolean
	port: number
	token: string
	lan: string[]
	vpn: string[]
	/** digits typed so far while changing the code, or null when not changing it */
	pin?: string | null
	/** what happened last time it was changed */
	pinNote?: string
}

/** The passcode line: what it is now, or what is being typed instead. */
function passcodeLines(share: ShareInfo): string[] {
	if (share.pin !== null && share.pin !== undefined) {
		const typed = '●'.repeat(share.pin.length) + '○'.repeat(4 - share.pin.length)
		return [
			`${fg(C.label)}new passcode  ${bold}${fg(C.gold)}${typed}${R}`,
			`${fg(C.faint)}type four digits · ⌫ to fix · esc to leave it alone${R}`,
		]
	}
	return [
		`${fg(C.muted)}and enter the passcode  ${bold}${fg(C.gold)}${share.token}${R}`,
		`${fg(C.faint)}p to change it${R}${share.pinNote ? `${fg(C.muted)} · ${share.pinNote}${R}` : ''}`,
	]
}

/**
 * The address to type into the other machine.
 *
 * This has to be somewhere on screen or the feature is unusable: the passcode
 * lives in a file, the port is a setting, and expecting anyone to assemble a URL
 * out of three places they cannot see is how a working feature goes unused.
 */
/**
 * The control token, or how to turn control on.
 *
 * Shown here and nowhere else. The token is read off the machine that holds it,
 * which is the same trust boundary as sitting at it — never sent over the
 * network, because a credential that can run commands must not be obtainable by
 * anything that can merely reach the page.
 */
function controlLines(control?: { on: boolean; token: string }): (string | Line)[] {
	if (!control?.on) {
		return [`${fg(C.fillWarn)}○ control off${R}${fg(C.muted)} — no browser can type into any session.${R}`]
	}
	return [
		`${fg(C.screenAgent)}◉ control on${R}${fg(C.muted)} — token for the browser, from this machine only:${R}`,
		`${fg(C.gold)}${control.token}${R}`,
	]
}

function shareLines(share?: ShareInfo): (string | Line)[] {
	if (!share?.on) {
		return [
			`${fg(C.muted)}${bold}s${R}${fg(C.muted)} starts a small read-only web server so your other machines${R}`,
			`${fg(C.muted)}and your phone can see this. It is ${bold}off by default${R}${fg(C.muted)} and the choice${R}`,
			`${fg(C.muted)}is remembered. Turn it on and this panel shows the address.${R}`,
		]
	}
	// address and code stay separate on purpose: a code in a URL ends up in browser
	// history, in a shared link, and in any log the request passes through
	const urls = [...share.vpn, ...share.lan].map((a) => `http://${a}:${share.port}`)
	return [
		`${fg(C.screenAgent)}◉ sharing on port ${share.port}${R}${fg(C.muted)} — open this on the other machine:${R}`,
		...(urls.length
			? urls.slice(0, 3).map((u) => `${fg(C.gold)}${u}${R}`)
			: [`${fg(C.fillWarn)}no network address found — is wifi off?${R}`]),
		...passcodeLines(share),
		`${fg(C.muted)}Asked once per device, then remembered. Five wrong tries and${R}`,
		`${fg(C.muted)}that device waits, doubling each time — which is what makes${R}`,
		`${fg(C.muted)}four digits safe. Changing it signs every device out.${R}`,
	]
}

function body(share?: ShareInfo, control?: { on: boolean; token: string }): (string | Line)[] {
	const tier = (n: number) => `${fg(tierOf(n).color)}${tierOf(n).name}${R}`
	return [
		{ text: 'guildhall', kind: 'title' },
		{ text: 'Every live Claude Code session as a room you can glance at.', kind: 'dim' },
		'',
		{ text: 'STATUS — whose turn it is', kind: 'head' },
		stateLine('working', 'generating right now; leave it alone'),
		stateLine('shell', 'a command it started is still running'),
		stateLine('needs', 'blocked on you — a permission prompt or a question'),
		stateLine('review', 'finished, and you have not looked at the tab yet'),
		stateLine('done', 'finished recently'),
		stateLine('parked', 'idle for a while; nothing is waiting'),
		stateLine('error', 'the last turn failed'),
		`${fg(C.muted)}Derived from the registry and the transcript together, not copied${R}`,
		`${fg(C.muted)}from Claude Code's own flag — that one says ${bold}busy${R}${fg(C.muted)} forever if a${R}`,
		`${fg(C.muted)}session dies mid-turn, and ${bold}idle${R}${fg(C.muted)} when it asked you a question.${R}`,
		'',
		{ text: 'KEEPING THE MACHINE AWAKE', kind: 'head' },
		`${fg(C.fillOk)}● holding awake${R}       ${fg(C.muted)}something is working; sleep is blocked${R}`,
		`${fg(C.screenEdit)}◐ awake when working${R}  ${fg(C.muted)}enabled, nothing running, free to sleep${R}`,
		`${fg(C.fillWarn)}○ sleeps normally${R}     ${fg(C.muted)}switched off${R}`,
		`${fg(C.muted)}It is conditional. Enabled means "do not sleep ${bold}while something${R}`,
		`${fg(C.muted)}${bold}is working${R}${fg(C.muted)}", not "never sleep". Closing the lid still sleeps it.${R}`,
		`${fg(C.muted)}Sessions waiting on ${bold}you${R}${fg(C.muted)} do not count, or it would never sleep.${R}`,
		`${fg(C.muted)}The screen is held on too, because on battery it otherwise${R}`,
		`${fg(C.muted)}blanks after two minutes and locks — which looks like the${R}`,
		`${fg(C.muted)}machine ignoring this. Set ${bold}awakeDisplay: false${R}${fg(C.muted)} in the config${R}`,
		`${fg(C.muted)}file to let the screen sleep on its own and save the battery.${R}`,
		'',
		{ text: 'LEVEL — work done, not time spent', kind: 'head' },
		`${fg(C.muted)}25 x commits  +  3 x file edits  +  15 x subagents  +  minutes worked${R}`,
		`${fg(C.muted)}Minutes come from turn durations, so a session left open all${R}`,
		`${fg(C.muted)}night earns nothing. A day of hard work is about 11, a month 37,${R}`,
		`${fg(C.muted)}a year 85.  ${tier(3)} → ${tier(8)} → ${tier(15)} → ${tier(27)} → ${tier(50)}${R}`,
		'',
		{ text: 'THE ROOM', kind: 'head' },
		`${fg(C.muted)}Working sessions sit at their desk with a lit screen; the tint${R}`,
		`${fg(C.muted)}says what kind of tool is running. Everyone else walks around,${R}`,
		`${fg(C.muted)}talks, or goes to the kitchen. A ${bold}?${R}${fg(C.muted)} beside a desk means that${R}`,
		`${fg(C.muted)}session is waiting on an answer. A project's colour is the same${R}`,
		`${fg(C.muted)}on its carpet, its nameplate and its row in the table.${R}`,
		'',
		{ text: 'SHARING — off unless you turn it on', kind: 'head' },
		...shareLines(share),
		`${fg(C.muted)}It answers on your local network and on any VPN interface, never${R}`,
		`${fg(C.muted)}on the public internet.${R}`,
		`${fg(C.fillWarn)}Anyone who reaches it can read session titles, the last thing${R}`,
		`${fg(C.fillWarn)}each said, filenames being edited and commands that were run.${R}`,
		`${fg(C.muted)}Sharing alone changes nothing: with control off there is no${R}`,
		`${fg(C.muted)}endpoint that writes, on this machine or in any session.${R}`,
		'',
		{ text: 'CONTROL — typing into a session from elsewhere', kind: 'head' },
		...controlLines(control),
		`${fg(C.muted)}Opens a session's real terminal in the browser and lets you type${R}`,
		`${fg(C.muted)}into it — the same one on screen here, not a second copy.${R}`,
		`${fg(C.fillWarn)}This is the one thing here that can change your machine. Whoever${R}`,
		`${fg(C.fillWarn)}holds the token can send text to Claude Code in every repo you${R}`,
		`${fg(C.fillWarn)}have open, which reaches editing files and running commands.${R}`,
		`${fg(C.muted)}So it is separate from the passcode, off unless you turn it on,${R}`,
		`${fg(C.muted)}and refused from anywhere but this machine or your tailnet — a${R}`,
		`${fg(C.muted)}shared secret on a plain LAN is not a boundary. Permission${R}`,
		`${fg(C.muted)}prompts are never answerable remotely; those stay yours. Every${R}`,
		`${fg(C.muted)}send is printed above the footer, so nothing happens unseen.${R}`,
		`${fg(C.muted)}Set ${bold}"control": true${R}${fg(C.muted)} in the config file to enable it.${R}`,
		'',
		{ text: 'KEYS', kind: 'head' },
		key('↑ ↓', 'move the selection'),
		key('→ ←', 'open a row for detail, or close it'),
		key('⏎', "jump to that session's cmux tab"),
		key('f', 'show only what needs you'),
		key('l', 'all labels, or only the ones that need you'),
		key('v', 'project names beside the desk, or under it'),
		key('a', 'keep the machine awake, or let it sleep'),
		key('s', 'share to your network, or stop sharing'),
		key('p', 'set a new passcode (while this is open)'),
		key('tab', 'room / split / table'),
		key('r', 'force a redraw'),
		key('?', 'close this'),
		key('q', 'quit'),
		'',
		{ text: updateLine() || 'Read-only. It never starts, stops or moves a session.', kind: 'dim' },
	]
}

const updateLine = () => {
	const v = available()
	return v ? `A newer version is out: v${v}. Pull and run npm start.` : ''
}

const key = (k: string, meaning: string) => `${fg(C.gold)}${k.padEnd(5)}${R}${fg(C.muted)}${meaning}${R}`

/**
 * Render the panel as full-width lines, centred in the given box.
 *
 * Returned as complete screen rows rather than a floating window: the room is
 * drawn with half blocks and images, and a partial overlay would leave sprites
 * showing through the gaps. The caller suppresses the image layer entirely while
 * this is open, since kitty images always draw above text.
 */
export function panel(cols: number, rows: number, share?: ShareInfo, control?: { on: boolean; token: string }): string[] {
	const items = body(share, control)
	const plain = (l: string | Line) => (typeof l === 'string' ? l : l.text)
	const inner = Math.max(...items.map((l) => width(stripLine(plain(l))))) + PAD * 2
	const boxW = Math.min(cols - 2, Math.max(46, inner))
	const left = Math.max(0, Math.floor((cols - boxW) / 2))
	const pad = ' '.repeat(left)

	const out: string[] = []
	const edge = `${fg(C.rule)}${'─'.repeat(boxW)}${R}`
	out.push(pad + edge)
	for (const item of items) {
		const line = typeof item === 'string' ? item : format(item)
		out.push(pad + ' '.repeat(PAD) + line)
	}
	out.push(pad + edge)

	// centre vertically, so it reads as a panel rather than a wall of text
	const top = Math.max(0, Math.floor((rows - out.length) / 2))
	const filled = [...Array.from({ length: top }, () => ''), ...out]
	while (filled.length < rows) filled.push('')
	return filled.slice(0, rows).map((l) => clip(l, cols))
}

function format(l: Line) {
	if (l.kind === 'title') return `${bold}${fg(C.gold)}${l.text}${R}`
	if (l.kind === 'head') return `${bold}${fg(C.label)}${l.text}${R}`
	if (l.kind === 'dim') return `${fg(C.faint)}${l.text}${R}`
	return l.text
}

const stripLine = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

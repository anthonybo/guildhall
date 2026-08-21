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
import { C, LOOK, R, bold, clip, fg, tierOf, underline, width } from './theme.ts'
// The same colour the desk mug and the table column use, so "codex: shown" here is
// visibly the same teal as the mark it turns on.
import { harnessColor } from './screens.ts'
import type { State } from './data.ts'
import { available } from './update.ts'

const PAD = 2

/**
 * What clicking a line does.
 *
 * `copy` carries its own payload rather than a row number, because the thing
 * being copied is an address that only exists in the line that renders it.
 */
export type Act =
	| { kind: 'port' }
	| { kind: 'passcode' }
	| { kind: 'control' }
	| { kind: 'copy'; text: string }
	| { kind: 'sharing' }
	| { kind: 'awake' }
	| { kind: 'labels' }
	| { kind: 'codex' }
	/** open or close one of the explanatory sections */
	| { kind: 'section'; id: string }

/**
 * Mark a value as something you can act on.
 *
 * Underline and nothing else. The panel had six changeable values in it and no
 * way to tell them from the prose — "I would have no idea the port is clickable"
 * — and the fix has to be a convention rather than a word beside each one, or the
 * hint costs more room than the setting. Underline is the one attribute already
 * understood as "this does something" and is not used anywhere else here.
 */
const hot = (s: string) => `${underline}${s}${R}`

/**
 * Every collapsible section, in the order they appear.
 *
 * Exported so `h` can open all of them without main.ts keeping its own list that
 * would quietly fall out of step with the headings below.
 */
export const SECTION_IDS = ['status', 'awake', 'level', 'room', 'sharing', 'control', 'keys'] as const

/** A clickable line, as a screen row index into what `panel()` returned. */
export type Hit = { row: number; act: Act }

type Line = { text: string; kind?: 'title' | 'head' | 'dim'; act?: Act }

/** Live values the settings block shows that are not about sharing. */
export type Env = { awakeArmed: boolean; awakeHolding: boolean; labels: string; codex: boolean }

/**
 * Hide the prose under any closed heading.
 *
 * Done as a pass over the finished list rather than by restructuring the sections
 * into nested arrays: the panel is ninety lines of explanation with six settings
 * buried in it, and the shape that fixes that is a short list of headings, not a
 * different way of writing the same wall. A heading with no section id — SETTINGS —
 * is never collapsible, and any heading at all ends the previous section, so a
 * closed one cannot swallow what follows it.
 */
function collapse(items: (string | Line)[], open: Set<string>): (string | Line)[] {
	const out: (string | Line)[] = []
	let skipping = false
	for (const item of items) {
		if (typeof item !== 'string' && item.kind === 'head') {
			const id = item.act?.kind === 'section' ? item.act.id : null
			skipping = id ? !open.has(id) : false
			out.push(id ? { ...item, text: `${open.has(id) ? '▾' : '▸'} ${item.text}` } : item)
			continue
		}
		if (!skipping) out.push(item)
	}
	return out
}

/** One settings row: what it is, what it is set to, and the key that changes it. */
function setting(label: string, value: string, hint: string, act: Act): Line {
	return { text: `${fg(C.label)}${label.padEnd(9)}${R}${value}${hint ? `${fg(C.faint)}   ${hint}${R}` : ''}`, act }
}

/**
 * Everything you can change, in one block at the top.
 *
 * These were spread through the prose, each explained where it appeared, which
 * read fine as a document and badly as a control panel: there was no single place
 * that answered "what can I change here". Values are underlined because that is
 * the only cue that separates them from the sentences around them.
 */
function settingsBlock(share?: ShareInfo, control?: ControlInfo, env?: Env): (string | Line)[] {
	const rows: (string | Line)[] = [{ text: 'SETTINGS', kind: 'head' }, `${fg(C.faint)}underlined values can be clicked, or use the key beside them${R}`]
	// Mid-entry, the row being edited becomes the field. Same rule as before: the
	// value you are replacing and the one you are typing belong in one place.
	if (share?.portEntry !== null && share?.portEntry !== undefined) {
		rows.push(setting('port', `${bold}${fg(C.gold)}${share.portEntry || '…'}${R}`, '1024-65535 · ⏎ move · esc cancel', { kind: 'port' }))
		rows.push(`${fg(C.muted)}Every device has to be told the new address.${R}`)
		if (share.portNote) rows.push(`${fg(C.fillWarn)}${share.portNote}${R}`)
		return rows
	}
	if (share?.pin !== null && share?.pin !== undefined) {
		const typed = '●'.repeat(share.pin.length) + '○'.repeat(4 - share.pin.length)
		rows.push(setting('passcode', `${bold}${fg(C.gold)}${typed}${R}`, 'four digits · ⌫ fix · esc cancel', { kind: 'passcode' }))
		return rows
	}
	if (control?.typing !== null && control?.typing !== undefined) {
		// never echoed; the dots are enough to see it registering
		rows.push(setting('control', `${bold}${fg(C.gold)}${'●'.repeat(Math.min(control.typing.length, 40)) || '…'}${R}`, `${control.typing.length} chars · ⏎ save · esc cancel`, { kind: 'control' }))
		if (control.note) rows.push(`${fg(C.fillWarn)}${control.note}${R}`)
		return rows
	}
	rows.push(
		// "off by default" belongs on the row, not only in the prose behind a closed
		// heading: it is the answer to "did I leave this on?", which is asked while
		// looking at the setting.
		setting('sharing', share?.on ? `${fg(C.screenAgent)}${hot('on')}${R}` : `${fg(C.fillWarn)}${hot('off')}${R}`, share?.on ? 's' : 's · off by default', { kind: 'sharing' }),
	)
	if (share?.on) {
		rows.push(setting('port', `${fg(C.gold)}${hot(String(share.port))}${R}`, 'o', { kind: 'port' }))
		const urls = [...share.vpn, ...share.lan].map((a) => `http://${a}:${share.port}`)
		for (const u of urls.slice(0, 3)) rows.push(setting('address', `${fg(C.gold)}${hot(u)}${R}`, 'y copies it', { kind: 'copy', text: u }))
		if (!urls.length) rows.push(`${fg(C.fillWarn)}no network address found — is wifi off?${R}`)
		// the code stays out of the URL: a code in a link ends up in history and logs
		rows.push(setting('passcode', `${fg(C.gold)}${hot(share.token)}${R}`, 'p', { kind: 'passcode' }))
		if (share.pinNote) rows.push(`${fg(C.faint)}${share.pinNote}${R}`)
		if (share.portNote) rows.push(`${fg(C.faint)}${share.portNote}${R}`)
	}
	// Visible whether sharing is on or off, and collapsed or not. The case that
	// matters most is somebody DECIDING whether to enable it, which is when sharing
	// is still off — and serve.test.ts checks the panel with no sharing state at all
	// for exactly that reason. A warning behind a closed heading is not a warning.
	rows.push(`${fg(C.fillWarn)}anyone who reaches it can read session titles, filenames being${R}`)
	rows.push(`${fg(C.fillWarn)}edited and commands run — never on the public internet. See SHARING.${R}`)
	rows.push(
		setting(
			'control',
			control?.on ? (control.isSet ? `${fg(C.screenAgent)}${hot('on, password set')}${R}` : `${fg(C.fillWarn)}${hot('on, no password yet')}${R}`) : `${fg(C.fillWarn)}${hot('off')}${R}`,
			'c',
			{ kind: 'control' },
		),
	)
	if (control?.note) rows.push(`${fg(C.faint)}${control.note}${R}`)
	// Same rule for control, which is the one setting here that can change the
	// machine. The detail is in its section; the fact is not optional reading.
	if (control?.on) rows.push(`${fg(C.fillWarn)}whoever holds the password can type into every session you have${R}`, `${fg(C.fillWarn)}open, which reaches editing files and running commands. See CONTROL.${R}`)
	if (env) {
		rows.push(setting('awake', env.awakeHolding ? `${fg(C.fillOk)}${hot('holding awake')}${R}` : env.awakeArmed ? `${fg(C.screenEdit)}${hot('awake when working')}${R}` : `${fg(C.fillWarn)}${hot('sleeps normally')}${R}`, 'a', { kind: 'awake' }))
		rows.push(setting('labels', `${fg(C.muted)}${hot(env.labels)}${R}`, 'v', { kind: 'labels' }))
		// Named for the harness rather than for the setting ("codex: on"), because the
		// question being answered is "why don't I see my Codex sessions" — and the
		// answer has to be findable by the word the person is looking for.
		rows.push(
			setting(
				'codex',
				env.codex ? `${fg(harnessColor('codex'))}${hot('shown')}${R}` : `${fg(C.muted)}${hot('hidden')}${R}`,
				env.codex ? 'x' : 'x · Claude only',
				{ kind: 'codex' },
			),
		)
	}
	return rows
}

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
	/** digits typed so far while changing the port, or null when not changing it */
	portEntry?: string | null
	/** what happened last time the port was changed */
	portNote?: string
	/** digits typed so far while changing the code, or null when not changing it */
	pin?: string | null
	/** what happened last time it was changed */
	pinNote?: string
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
export type ControlInfo = {
	on: boolean
	/** whether a passphrase has been chosen at all */
	isSet: boolean
	/** characters typed so far while setting one, or null when not setting it */
	typing: string | null
	/** what happened last time it was set */
	note: string
}



function body(share?: ShareInfo, control?: ControlInfo, env?: Env): (string | Line)[] {
	const tier = (n: number) => `${fg(tierOf(n).color)}${tierOf(n).name}${R}`
	return [
		{ text: 'guildhall', kind: 'title' },
		{ text: 'Every live Claude Code session as a room you can glance at.', kind: 'dim' },
		'',
		...settingsBlock(share, control, env),
		'',
		{ text: 'HELP', kind: 'head' },
		`${fg(C.faint)}click a heading to open it · h opens or closes them all${R}`,
		{ text: 'STATUS — whose turn it is', kind: 'head', act: { kind: 'section', id: 'status' } },
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
		{ text: 'AWAKE — what it does and does not promise', kind: 'head', act: { kind: 'section', id: 'awake' } },
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
		{ text: 'LEVEL — work done, not time spent', kind: 'head', act: { kind: 'section', id: 'level' } },
		`${fg(C.muted)}25 x commits  +  3 x file edits  +  15 x subagents  +  minutes worked${R}`,
		`${fg(C.muted)}Minutes come from turn durations, so a session left open all${R}`,
		`${fg(C.muted)}night earns nothing. A day of hard work is about 11, a month 37,${R}`,
		`${fg(C.muted)}a year 85.  ${tier(3)} → ${tier(8)} → ${tier(15)} → ${tier(27)} → ${tier(50)}${R}`,
		'',
		{ text: 'THE ROOM — what you are looking at', kind: 'head', act: { kind: 'section', id: 'room' } },
		`${fg(C.muted)}Working sessions sit at their desk with a lit screen; the tint${R}`,
		`${fg(C.muted)}says what kind of tool is running. Everyone else walks around,${R}`,
		`${fg(C.muted)}talks, or goes to the kitchen. A ${bold}?${R}${fg(C.muted)} beside a desk means that${R}`,
		`${fg(C.muted)}session is waiting on an answer. A project's colour is the same${R}`,
		`${fg(C.muted)}on its carpet, its nameplate and its row in the table.${R}`,
		'',
		{ text: 'SHARING — what it exposes', kind: 'head', act: { kind: 'section', id: 'sharing' } },
		`${fg(C.muted)}A small read-only web server, so your other computers and your${R}`,
		`${fg(C.muted)}phone can see this. Turn it on with ${bold}s${R}${fg(C.muted)}; off by default, and the${R}`,
		`${fg(C.muted)}choice is remembered. The address and code are in SETTINGS.${R}`,
		`${fg(C.muted)}The code is asked once per device, then remembered. Five wrong${R}`,
		`${fg(C.muted)}tries and that device waits, doubling each time — which is what${R}`,
		`${fg(C.muted)}makes four digits safe. Changing it signs every device out.${R}`,
		`${fg(C.muted)}It answers on your local network and on any VPN interface, never${R}`,
		`${fg(C.muted)}on the public internet.${R}`,
		`${fg(C.fillWarn)}Anyone who reaches it can read session titles, the last thing${R}`,
		`${fg(C.fillWarn)}each said, filenames being edited and commands that were run.${R}`,
		`${fg(C.muted)}Sharing alone changes nothing: with control off there is no${R}`,
		`${fg(C.muted)}endpoint that writes, on this machine or in any session.${R}`,
		'',
		{ text: 'CONTROL — what it allows, and the risk', kind: 'head', act: { kind: 'section', id: 'control' } },
		`${fg(C.muted)}Opens a session's real terminal in the browser and lets you type${R}`,
		`${fg(C.muted)}into it — the same one on screen here, not a second copy.${R}`,
		`${fg(C.fillWarn)}This is the one thing here that can change your machine. Whoever${R}`,
		`${fg(C.fillWarn)}holds the token can send text to Claude Code in every repo you${R}`,
		`${fg(C.fillWarn)}have open, which reaches editing files and running commands.${R}`,
		`${fg(C.muted)}You choose the password and type it HERE, never in the browser —${R}`,
		`${fg(C.muted)}this machine is the trust boundary. It is stored scrypted, so the${R}`,
		`${fg(C.muted)}file holds a hash and nothing anyone can type. Eight characters${R}`,
		`${fg(C.muted)}minimum, and five wrong tries makes that device wait.${R}`,
		`${fg(C.muted)}It is separate from the passcode, off unless you turn it on,${R}`,
		`${fg(C.muted)}and refused from anywhere but this machine or your tailnet — a${R}`,
		`${fg(C.muted)}shared secret on a plain LAN is not a boundary. Permission${R}`,
		`${fg(C.muted)}prompts are never answerable remotely; those stay yours. Every${R}`,
		`${fg(C.muted)}send is printed above the footer, so nothing happens unseen.${R}`,
		`${fg(C.muted)}Set ${bold}"control": true${R}${fg(C.muted)} in the config file to enable it.${R}`,
		'',
		{ text: 'KEYS — everything else', kind: 'head', act: { kind: 'section', id: 'keys' } },
		key('↑ ↓', 'move the selection'),
		key('→ ←', 'open a row for detail, or close it'),
		key('⏎', "jump to that session's cmux tab"),
		key('f', 'show only what needs you'),
		key('l', 'all labels, or only the ones that need you'),
		key('v', 'project names beside the desk, or under it'),
		key('a', 'keep the machine awake, or let it sleep'),
		key('x', 'show Codex sessions too, or only Claude Code'),
		key('s', 'share to your network, or stop sharing'),
		key('tab', 'room / split / table'),
		key('r', 'force a redraw'),
		key('h', 'open or close every explanation here'),
		key('y', 'copy the sharing address to the clipboard'),
		key('o', 'change the port'),
		key('c', 'set the control password'),
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
/**
 * How many lines of the help are off the bottom at this size.
 *
 * The panel used to build every line, centre the block, and then `slice(0, rows)`
 * — which silently threw away everything past the last row. It needs 41 rows to
 * fit, so on any shorter terminal the address and passcode section simply did not
 * exist, with nothing on screen to say so. Reported from a second machine as not
 * being able to reach the port section.
 */
export function overflow(cols: number, rows: number, share?: ShareInfo, control?: ControlInfo, env?: Env, open?: Set<string>): number {
	return Math.max(0, lines(cols, share, control, env, open).length - rows)
}

/** The panel's lines before centring or scrolling, which is what decides both. */
function lines(cols: number, share?: ShareInfo, control?: ControlInfo, env?: Env, open: Set<string> = new Set()): { text: string; act?: Act }[] {
	const items = collapse(body(share, control, env), open)
	const plain = (l: string | Line) => (typeof l === 'string' ? l : l.text)
	const inner = Math.max(...items.map((l) => width(stripLine(plain(l))))) + PAD * 2
	const boxW = Math.min(cols - 2, Math.max(46, inner))
	const left = Math.max(0, Math.floor((cols - boxW) / 2))
	const pad = ' '.repeat(left)
	const edge = `${fg(C.rule)}${'─'.repeat(boxW)}${R}`
	const out: { text: string; act?: Act }[] = [{ text: pad + edge }]
	for (const item of items) {
		const text = pad + ' '.repeat(PAD) + (typeof item === 'string' ? item : format(item))
		out.push(typeof item === 'string' ? { text } : { text, act: item.act })
	}
	out.push({ text: pad + edge })
	return out
}

/**
 * The panel and its clickable rows, from one layout pass.
 *
 * Both come from here rather than from two functions that each work out where a
 * line ended up. Scrolling and vertical centring both move every row, so a hit map
 * computed separately would agree with the picture only until somebody changed one
 * of them — and the failure would be clicking a line and getting the action of a
 * different one, which is worse than no clicking at all.
 */
export function view(cols: number, rows: number, share?: ShareInfo, control?: ControlInfo, scroll = 0, env?: Env, open?: Set<string>): { rows: string[]; hits: Hit[] } {
	const out = lines(cols, share, control, env, open)
	const done = (list: { text: string; act?: Act }[], offset: number) => ({
		rows: list.map((l) => clip(l.text, cols)),
		hits: list.flatMap((l, i) => (l.act ? [{ row: i + offset, act: l.act }] : [])),
	})

	// Taller than the window: scroll it instead of throwing the bottom away, and
	// say so on the last row — a panel that silently ends is indistinguishable from
	// a panel that has nothing more to show.
	if (out.length > rows) {
		const max = out.length - rows + 1 // +1 for the row the hint occupies
		const at = Math.max(0, Math.min(scroll, max))
		const slice = out.slice(at, at + rows - 1)
		const more = at < max ? `${at > 0 ? '↑' : ' '} ${max - at} more line${max - at === 1 ? '' : 's'} — ↑↓ or space to scroll` : '↑ top with ↑'
		const shown = done(slice, 0)
		shown.rows.push(clip(`${fg(C.faint)}  ${more}${R}`, cols))
		return shown
	}

	// centre vertically, so it reads as a panel rather than a wall of text
	const top = Math.max(0, Math.floor((rows - out.length) / 2))
	const shown = done(out, top)
	const filled = [...Array.from({ length: top }, () => ''), ...shown.rows]
	while (filled.length < rows) filled.push('')
	return { rows: filled.slice(0, rows).map((l) => clip(l, cols)), hits: shown.hits.filter((h) => h.row < rows) }
}

export function panel(cols: number, rows: number, share?: ShareInfo, control?: ControlInfo, scroll = 0, env?: Env, open?: Set<string>): string[] {
	return view(cols, rows, share, control, scroll, env, open).rows
}

function format(l: Line) {
	if (l.kind === 'title') return `${bold}${fg(C.gold)}${l.text}${R}`
	if (l.kind === 'head') return `${bold}${fg(C.label)}${l.text}${R}`
	if (l.kind === 'dim') return `${fg(C.faint)}${l.text}${R}`
	return l.text
}

const stripLine = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * Settings that outlive a run.
 *
 * Only things somebody would be annoyed to set twice belong here. Sharing is the
 * whole reason it exists: a network listener is not something to turn on by
 * accident or to leave on because a flag was easier to remember than to remove,
 * so the choice is explicit, persisted, and visible on screen while it is on.
 *
 * Sharing defaults to OFF. Most people watching their own sessions on their own
 * machine never want a server, and the cost of it being on unnoticed is that what
 * you are working on becomes readable by whatever else is on the network.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT, okPort } from './port.ts'
import { writePrivate } from './privatefile.ts'

export type Config = {
	/** serve the room over HTTP. Off unless deliberately turned on. */
	serve: boolean
	port: number
	/** 0.0.0.0 answers on the LAN and on any VPN interface; 127.0.0.1 is local
	 *  only, which is what you want when reaching it through a tunnel. */
	host: string
	/** how a project's name sits by its desks: down the side, or along the aisle */
	labels: 'vertical' | 'horizontal'
	/** read Codex sessions as well as Claude Code ones. Off by default: see
	 *  docs/codex.md for why a second harness is additive and switchable. */
	codex: boolean
	/** hold the display awake too, not just the machine. Off keeps the screen's own
	 *  sleep timer, which on battery is usually two minutes and usually locks. */
	awakeDisplay: boolean
	/**
	 * Let a browser read a session's terminal and type into it.
	 *
	 * Its own switch, independent of `serve`, because it is a different kind of
	 * thing: sharing makes the room readable, this makes the machine writable.
	 * Anyone who holds the control token can send text to Claude Code sessions in
	 * every repository here, which reaches editing files and running commands.
	 * Off unless deliberately turned on, and refused from anywhere but loopback
	 * or a tailnet however it is configured.
	 */
	control: boolean
}

// Vertical needs the graphics protocol, since the plate is a rotated image; on a
// terminal without it the room falls back to horizontal on its own.
/**
 * The defaults, and the ONLY place they are declared.
 *
 * `host` was `0.0.0.0` — every interface. Combined with the headless service being
 * installed at login, that meant setting up the menu bar app quietly turned the
 * machine into a server answering on the LAN and on the tailnet, for data the user
 * had not chosen to share. `serve: false` said the opposite and was right; the host
 * default undid it the moment anything switched serving on.
 *
 * Loopback is the honest default: a browser on this machine can reach it, nothing
 * else can, and sharing is a deliberate change to `the network` in the menu bar
 * settings or this file.
 */
const DEFAULTS: Config = { serve: false, port: DEFAULT_PORT, host: '127.0.0.1', labels: 'vertical', awakeDisplay: true, control: false, codex: false }

/**
 * A port this program will accept, in one place.
 *
 * There were three rules: this file took 1-65535, the menu bar refused anything
 * below 1024, and the installer had its own fallback — so a port set in one surface
 * could be rejected by the next. Below 1024 needs root on macOS, so the menu bar
 * was the correct one and it is now the only one.
 */
// Re-exported, not redefined: port policy — the range, the default, and how a free
// one is found — lives in port.ts so the three surfaces that ask cannot disagree.
export { DEFAULT_PORT, PORT_MAX, PORT_MIN, okPort } from './port.ts'

/** Resolved per call so tests can redirect it; see the note in auth.ts. */
const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const file = () => path.join(dir(), 'config.json')

export function load(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Config>
		return {
			serve: typeof raw.serve === 'boolean' ? raw.serve : DEFAULTS.serve,
			port: okPort(raw.port) ? raw.port : DEFAULTS.port,
			host: typeof raw.host === 'string' && raw.host ? raw.host : DEFAULTS.host,
			labels: raw.labels === 'horizontal' ? 'horizontal' : DEFAULTS.labels,
			awakeDisplay: typeof raw.awakeDisplay === 'boolean' ? raw.awakeDisplay : DEFAULTS.awakeDisplay,
			control: raw.control === true,
			// Off unless asked for. An upgrade must not start showing sessions from a
			// second harness, and a regression in reading them must be switchable off by
			// somebody who is not reading a stack trace.
			codex: raw.codex === true,
		}
	} catch {
		return { ...DEFAULTS }
	}
}

export function save(cfg: Config) {
	try {
		writePrivate(file(), JSON.stringify(cfg, null, '\t') + '\n')
		return true
	} catch {
		return false
	}
}

export const configPath = () => file()

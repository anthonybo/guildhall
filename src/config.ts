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

export type Config = {
	/** serve the room over HTTP. Off unless deliberately turned on. */
	serve: boolean
	port: number
	/** 0.0.0.0 answers on the LAN and on any VPN interface; 127.0.0.1 is local
	 *  only, which is what you want when reaching it through a tunnel. */
	host: string
	/** how a project's name sits by its desks: down the side, or along the aisle */
	labels: 'vertical' | 'horizontal'
}

// Horizontal until the vertical plate is drawn as an image rather than as text.
// A terminal cell is about twice as tall as it is wide, so one glyph per row
// spaces a six-letter name over twelve letter-widths — unreadable, and not
// something a different font can fix.
const DEFAULTS: Config = { serve: false, port: 4318, host: '0.0.0.0', labels: 'horizontal' }

/** Resolved per call so tests can redirect it; see the note in auth.ts. */
const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const file = () => path.join(dir(), 'config.json')

export function load(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Config>
		return {
			serve: typeof raw.serve === 'boolean' ? raw.serve : DEFAULTS.serve,
			port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : DEFAULTS.port,
			host: typeof raw.host === 'string' && raw.host ? raw.host : DEFAULTS.host,
			labels: raw.labels === 'horizontal' ? 'horizontal' : DEFAULTS.labels,
		}
	} catch {
		return { ...DEFAULTS }
	}
}

export function save(cfg: Config) {
	try {
		fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
		fs.writeFileSync(file(), JSON.stringify(cfg, null, '\t') + '\n', { mode: 0o600 })
		return true
	} catch {
		return false
	}
}

export const configPath = () => file()

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
}

const DEFAULTS: Config = { serve: false, port: 4318, host: '0.0.0.0' }

const DIR = path.join(os.homedir(), '.config', 'guildhall')
const FILE = path.join(DIR, 'config.json')

export function load(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Config>
		return {
			serve: typeof raw.serve === 'boolean' ? raw.serve : DEFAULTS.serve,
			port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : DEFAULTS.port,
			host: typeof raw.host === 'string' && raw.host ? raw.host : DEFAULTS.host,
		}
	} catch {
		return { ...DEFAULTS }
	}
}

export function save(cfg: Config) {
	try {
		fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
		fs.writeFileSync(FILE, JSON.stringify(cfg, null, '\t') + '\n', { mode: 0o600 })
		return true
	} catch {
		return false
	}
}

export const configPath = () => FILE

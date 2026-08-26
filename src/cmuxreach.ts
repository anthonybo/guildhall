/**
 * Can THIS process drive cmux, and if not, what would fix it?
 *
 * A real failure, and one guildhall had no way to see. cmux's socket runs in
 * `access_mode: cmuxOnly`, meaning it accepts control connections only from processes
 * started inside cmux — those inherit `CMUX_SOCKET_CAPABILITY` from their pane. The
 * launchd service inherits nothing of the sort, because launchd starts jobs with almost
 * no environment.
 *
 * So the installed service — the DEFAULT way to serve the browser view — can read
 * sessions perfectly (that comes from files) and cannot type into a single one. The phone
 * showed cmux's own words, "only processes started inside cmux can connect", under a
 * panel that said control was on. Reported as "access denied — only processes".
 *
 * Worse, it was invisible until somebody read it off a phone screen. Nothing in guildhall
 * knew the difference between "control is off" and "control is on and structurally
 * impossible from this process".
 *
 * There are two ways out and guildhall supports both:
 *
 *  - Run the server from inside a cmux pane, so it inherits the capability. That is what
 *    a dev watcher started in a terminal does, which is why control worked there.
 *  - Give cmux a socket password. `cmux --help` under "Socket Auth": `--password` takes
 *    precedence, then `CMUX_SOCKET_PASSWORD`, then the password saved in Settings. Set
 *    one in cmux, put it in `~/.config/guildhall/cmux-password`, and the service can
 *    connect like anything else holding that secret.
 *
 * The password goes to the child as an ENVIRONMENT VARIABLE, never as `--password`.
 * Anything in argv is readable by every process on this machine through `ps`, which is
 * the same rule the control password and the passcode already follow.
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CMUX } from './data/cmux-bin.ts'

/** Resolved per call so tests can redirect it, as auth.ts and config.ts do. */
const dir = () => process.env.GUILDHALL_CONFIG_DIR || path.join(os.homedir(), '.config', 'guildhall')
const passFile = () => path.join(dir(), 'cmux-password')

/**
 * The cmux socket password, if one has been stored.
 *
 * Read fresh rather than cached: it is a credential, and holding it in memory for the
 * life of a long-running server buys nothing when the read is a few microseconds.
 */
export function socketPassword(): string | null {
	try {
		const raw = fs.readFileSync(passFile(), 'utf8').trim()
		return raw.length ? raw : null
	} catch {
		return null
	}
}

/**
 * The environment a cmux child should run with.
 *
 * The password is added only when one is stored AND the process does not already have a
 * capability — a pane-started process is already authorized, and passing a password it
 * does not need is one more place for a secret to appear.
 */
export function cmuxEnv(): NodeJS.ProcessEnv {
	if (process.env.CMUX_SOCKET_CAPABILITY) return process.env
	const pass = socketPassword()
	if (!pass) return process.env
	return { ...process.env, CMUX_SOCKET_PASSWORD: pass }
}

export type Reach = { ok: true } | { ok: false; why: string; fix: string }

/**
 * Whether control can work from here, decided without touching a live session.
 *
 * `cmux capabilities` answers from local state and needs no socket, so this is safe to
 * call on a request path and cannot type into anything. It is the only cmux call that
 * reports `access_mode`, which is the fact that decides the whole question.
 *
 * Deliberately NOT a probe that sends something. The one thing this must never do is
 * verify its own reachability by acting: `cmux send` with an empty or unmatched target
 * falls back to whatever surface is FOCUSED, which this repo has already typed into a
 * live session twice while investigating.
 */
export function reach(): Reach {
	// Started inside cmux: it holds a capability and needs nothing else.
	if (process.env.CMUX_SOCKET_CAPABILITY) return { ok: true }
	// A stored password authorizes any local process, whatever started it.
	if (socketPassword()) return { ok: true }
	let mode = ''
	try {
		const out = execFileSync(CMUX, ['capabilities'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
		mode = String((JSON.parse(out) as { access_mode?: string }).access_mode ?? '')
	} catch {
		return {
			ok: false,
			why: 'cmux could not be asked whether this process may control it',
			fix: 'Is cmux running, and is the `cmux` command on this machine?',
		}
	}
	if (mode === 'cmuxOnly') {
		return {
			ok: false,
			// Said from the reader's side: what is broken, not what the flag is called.
			why: 'this server was not started inside cmux, and cmux is set to accept control only from processes that were',
			// The password is listed second on purpose. Measured from a launchd child with
			// no password configured in cmux: supplying CMUX_SOCKET_PASSWORD was refused
			// with the SAME "only processes started inside cmux" error, so it is not a
			// demonstrated way out of this mode. Changing the mode is.
			fix: 'Either run the server from a cmux pane, or set automation.socketControlMode to "allowAll" in ~/.config/cmux/cmux.json and run `cmux reload-config`. A socket password saved in ~/.config/guildhall/cmux-password is read too, but was not enough on its own here.',
		}
	}
	// Any other mode: cmux is not restricting to its own children, so let it decide.
	return { ok: true }
}

/**
 * Run a cmux command with whatever authorization this process has.
 *
 * Here rather than in control.ts so there is one place that decides how cmux is
 * authorized. control.ts spawns cmux from several call sites and each one adding its own
 * env is the shape of bug this codebase keeps finding — see the note on `Desk` in
 * screens.ts for the version of it that shipped.
 */
export function runCmux(args: string[], timeout: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	return new Promise((resolve) => {
		execFile(CMUX, args, { timeout, maxBuffer: 4 << 20, windowsHide: true, env: cmuxEnv() }, (err, stdout, stderr) => {
			if (err) return resolve({ ok: false, error: (stderr || err.message || 'failed').trim().slice(0, 200) })
			resolve({ ok: true, text: stdout })
		})
	})
}

/**
 * Hold the machine awake while a session is genuinely working.
 *
 * A long build or test run is exactly when you walk away, and exactly when a
 * sleeping laptop costs you the run. So the room's own notion of "someone is at
 * their desk" drives a power assertion: it goes up when the first session starts
 * working and comes down when the last one stops.
 *
 * Only real sleep is blocked (-i idle, -m disk, -s system on AC). Display sleep is
 * deliberately left alone — the screen going dark does not interrupt a build, and
 * keeping it lit all night is not what was asked for. The separate business of
 * looking non-idle to the screensaver needs posted HID events and Accessibility
 * permission, which lives in `awake`, not here.
 *
 * `-w <pid>` makes caffeinate exit on its own if this process dies without
 * running any cleanup, so an assertion can never outlive the app.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import type { Session } from './data.ts'

/** States that count as work in progress. `shell` is a command still running. */
const BUSY = new Set(['working', 'shell'])

/** Whether anything in the room justifies holding the machine awake. */
export const shouldHold = (sessions: Session[]) => sessions.some((s) => BUSY.has(s.state))

/** The sessions responsible, so the reason can be shown rather than guessed at. */
export const holders = (sessions: Session[]) => sessions.filter((s) => BUSY.has(s.state)).map((s) => s.proj)

let assertion: ChildProcess | null = null
let armed = true

/** `--no-awake` at launch, or the `a` key at runtime. Turning it off releases any
 *  assertion at once rather than waiting for the next poll. */
export function configure(on: boolean) {
	armed = on
	if (!on) release()
}

/** Armed to hold when someone works — distinct from holding right now. */
export const isArmed = () => armed
export const isHolding = () => assertion !== null

function release() {
	if (!assertion) return
	assertion.kill('SIGTERM')
	assertion = null
}

/**
 * Bring the assertion in line with what the room is doing. Safe to call every
 * poll: it only acts on a change, so a working session does not respawn
 * caffeinate every two seconds.
 */
export function sync(sessions: Session[]) {
	const want = armed && shouldHold(sessions)
	if (want === isHolding()) return false
	if (!want) {
		release()
		return true
	}
	if (process.platform !== 'darwin') return false
	try {
		assertion = spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' })
		assertion.on('error', () => (assertion = null))
		assertion.on('exit', () => (assertion = null))
	} catch {
		assertion = null
	}
	return isHolding()
}

// Backstop for exits that skip the normal teardown.
process.on('exit', release)

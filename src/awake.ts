/**
 * Hold the machine awake while a session is genuinely working.
 *
 * A long build or test run is exactly when you walk away, and exactly when a
 * sleeping laptop costs you the run. So the room's own notion of "someone is at
 * their desk" drives a power assertion: it goes up when the first session starts
 * working and comes down when the last one stops.
 *
 * Sleep is blocked with -i (idle), -m (disk) and -s (system, which the kernel
 * honours only on AC). -d holds the display as well, and that one is a setting.
 *
 * Leaving the display out was the original choice, on the reasoning that a dark
 * screen does not interrupt a build. That reasoning was wrong about what people
 * actually see: `displaysleep` is commonly two minutes on battery and the screen
 * lock is commonly immediate, so the machine stayed up exactly as promised while
 * the display blanked and locked — which reads as the machine ignoring "awake".
 * It holds the display by default now, and `awakeDisplay: false` restores the
 * old behaviour for anyone who would rather have the battery.
 *
 * Looking non-idle to the screensaver is a different problem again: only a posted
 * HID event resets HIDIdleTime, which needs Accessibility permission and lives in
 * `awake`, not here. Holding the display is enough to stop the lock, because the
 * lock is triggered by the display sleeping rather than by the idle timer.
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
let holdDisplay = true
/**
 * Hold the machine awake whether or not anyone is working.
 *
 * `armed` is conditional by design — it means "hold it WHEN a session is working" — so the
 * assertion drops the moment the last turn ends. That is right for a build you walked away
 * from and wrong for a machine you want reachable: a session that is merely waiting for
 * you keeps nothing awake, so the laptop sleeps and the browser view goes with it.
 *
 * Separate from `armed` rather than a third value of it, because they answer different
 * questions and the footer has to be able to say which is true. Forcing it on does not
 * disarm the conditional hold; it only makes the condition irrelevant.
 */
let always = false

/** `--no-awake` at launch, or the `a` key at runtime. Turning it off releases any
 *  assertion at once rather than waiting for the next poll. */
export function configure(on: boolean, display = holdDisplay, force = always) {
	const flagsChanged = display !== holdDisplay
	armed = on
	holdDisplay = display
	always = force
	// A live assertion has its flags baked into the running caffeinate, so changing
	// them has to drop it; the next sync raises a fresh one with the new set.
	//
	// `!on` alone is not the release condition any more: with `always` set, disarming
	// changes nothing about whether the machine should be held, and dropping the
	// assertion there would let it sleep against the one setting that says never.
	if ((!on && !always) || flagsChanged) release()
}

/** Whether the display is held awake too, not just the machine. */
export const holdsDisplay = () => holdDisplay

/** Armed to hold when someone works — distinct from holding right now. */
export const isArmed = () => armed
export const isHolding = () => assertion !== null
/** Holding regardless of what the room is doing. */
export const isAlways = () => always

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
/**
 * The decision, separated from the act of making it.
 *
 * `sync()` spawns a process and returns early off darwin, so a test of it asserts either a
 * real `caffeinate` or nothing at all — and a test written against the flags instead
 * passed with the force removed from the condition entirely. This is the line the feature
 * changed, so this is the line that gets asserted.
 */
export const wants = (sessions: Session[]) => always || (armed && shouldHold(sessions))

export function sync(sessions: Session[]) {
	const want = wants(sessions)
	if (want === isHolding()) return false
	if (!want) {
		release()
		return true
	}
	if (process.platform !== 'darwin') return false
	try {
		assertion = spawn('caffeinate', [holdDisplay ? '-dims' : '-ims', '-w', String(process.pid)], { stdio: 'ignore' })
		assertion.on('error', () => (assertion = null))
		assertion.on('exit', () => (assertion = null))
	} catch {
		assertion = null
	}
	return isHolding()
}

// Backstop for exits that skip the normal teardown.
process.on('exit', release)

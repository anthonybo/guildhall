/**
 * How this run was started: the mode flags, where sessions come from, and the settings
 * as loaded and then overridden for this run from the command line.
 */
import { collect as collectReal } from '../data.ts'
import { demoSessions } from '../demo.ts'
import { supportsImages } from '../kitty.ts'
import * as awake from '../awake.ts'
import * as cfgStore from '../config.ts'

export const ONCE = process.argv.includes('--once')
export const BENCH = process.argv.includes('--bench')
/**
 * Headless: hold sleep off for working sessions and draw nothing.
 *
 * The room only protects the machine while it is on screen, which is the wrong
 * shape for the job — a build runs longest exactly when nobody is watching a
 * dashboard. This mode is what you leave running (or hand to a LaunchAgent).
 */
export const GUARD = process.argv.includes('--guard')
/**
 * Serve the browser view and nothing else — no canvas, no images, no keys.
 *
 * The web server used to exist only alongside the room, which tied it to a
 * terminal. That is fine at the desk and wrong everywhere else: away from the
 * machine, every change to the server needed somebody physically there to quit
 * the app and start it again. Headless, it is a service that can be restarted by
 * anything, including a watcher, and the room stays a thing you open when you
 * happen to want to look at it.
 */
export const HEADLESS = process.argv.includes('--headless')
/** A fictional office, for documentation and for looking at this with nothing
 *  running. Never touches the real registry. */
export const DEMO = process.argv.includes('--demo')
// `cfg.codex` is read here rather than at each call site: this wrapper is already
// the one place that decides where sessions come from.
export const collect = () => (DEMO ? demoSessions() : collectReal(cfg.codex))
/**
 * Sharing is off unless it was turned on deliberately, and the choice persists.
 * `--serve` / `--no-serve` override the stored setting for one run.
 */
export const cfg = cfgStore.load()
if (process.argv.includes('--serve')) cfg.serve = true
if (process.argv.includes('--no-serve')) cfg.serve = false
// `--codex` / `--no-codex`, for one run, like `--serve`.
//
// The containment story for the second harness was "turn it off" — and the only way to
// do that was to hand-edit config.json, which is not a recovery a person carries out
// while something looks broken. Every other switch has a flag or a key; this one had
// neither, and was not in --help either.
if (process.argv.includes('--codex')) cfg.codex = true
if (process.argv.includes('--no-codex')) cfg.codex = false
/** Was it given on the command line? Then the file must not take it back — see
 *  `adoptDiskSettings`, whose whole job is letting the file win. */
export const CODEX_PINNED = process.argv.includes('--codex') || process.argv.includes('--no-codex')
const portArg = process.argv.indexOf('--port')
if (portArg > 0) cfg.port = Number(process.argv[portArg + 1]) || cfg.port
/** Given on the command line, so the file must not take it back mid-run. */
export const PORT_PINNED = portArg > 0

/**
 * `--bench` deliberately does NOT disable images.
 *
 * It used to, which made the benchmark measure a renderer nobody runs: with images
 * off the frame takes the half-block path and never calls `drawPlates`,
 * `drawMonitors`, `drawProps` or `drawImages` at all — and `drawPlates` was 77.6%
 * of the real frame. So the one number anybody consulted before changing the
 * renderer was blind to the most expensive thing in it, and stayed blind while a
 * per-frame call that could be cached sat there for months.
 *
 * A benchmark that measures a path production does not take is worse than no
 * benchmark, because it is trusted.
 */
export const IMAGES = supportsImages() && !ONCE && !GUARD
// observing should not change the machine's behaviour unless asked, but holding
// sleep off while a build runs is the common case, so it is on unless refused
// --once and --bench never hold anything; --demo arms it purely so the
// documentation image shows the state you actually run in, and the demo never
// reaches sync() to spawn anything
// `--no-awake` pins off for the whole run, outranking the file — it is the flag
// somebody reaches for precisely because something looks wrong.
/**
 * `--no-awake` pins the mode off for the whole run, outranking the file.
 *
 * Same rule `--no-codex` already follows: a one-run flag is what somebody reaches for
 * precisely because something looks wrong, and a poll two seconds later that quietly
 * restored the file's value would undo it.
 */
export const AWAKE_PINNED = process.argv.includes('--no-awake') || BENCH || (ONCE && !DEMO)
if (AWAKE_PINNED) cfg.awakeMode = 'off'
awake.configure(cfg.awakeMode !== 'off', cfg.awakeDisplay, cfg.awakeMode === 'always')

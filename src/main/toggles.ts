/**
 * The switches the help panel and the global keys share: sharing, the sleep hold,
 * label direction and Codex. Each flips a setting, persists it and makes it take effect.
 */
import * as awake from '../awake.ts'
import * as cfgStore from '../config.ts'
import { cfg, collect } from './run.ts'
import { syncServe } from './serving.ts'
import { resetPrev } from './screen.ts'
import { layout, sessions, setSessions } from './state.ts'

/**
 * The three toggles, extracted so the help panel and the global keys run the same
 * code. Two copies of "flip this and persist it" is how one of them ends up not
 * saving, or not taking effect until the next poll.
 */
export function toggleShare() {
	// Persisted, because a network listener you have to remember to re-enable is one
	// you will eventually leave on with a flag instead.
	cfg.serve = !cfg.serve
	syncServe()
	cfgStore.save(cfg)
}
/**
 * `a` cycles three states, not two: hold when working -> hold always -> off.
 *
 * A separate key was the alternative and is worse. These are three points on one
 * question — how hard to hold the machine awake — and splitting them across two keys
 * means the footer has to explain two switches whose combinations include one that means
 * nothing ("off, but always"). Cycling keeps it one control with one glyph.
 *
 * "Always" is persisted; "armed" is not, because armed is the default every run starts
 * from and forcing the machine never to sleep is a decision that should survive a restart
 * rather than being silently forgotten.
 */
/** The one place a mode becomes the two flags `awake` holds, so the key, the config file
 *  and the menu bar cannot disagree about what a mode means. */
export function applyAwake(mode: cfgStore.Config['awakeMode']) {
	awake.configure(mode !== 'off', cfg.awakeDisplay, mode === 'always')
}

export function toggleAwake() {
	// Off drops any assertion immediately rather than waiting for the next poll — the
	// point of reaching for this is usually "let it sleep now".
	const next = cfg.awakeMode === 'off' ? 'working' : cfg.awakeMode === 'working' ? 'always' : 'off'
	cfg.awakeMode = next
	cfgStore.save(cfg)
	applyAwake(next)
	awake.sync(sessions)
}
export function toggleLabels() {
	// the room re-reads this every frame, so nothing needs re-planning
	cfg.labels = cfg.labels === 'vertical' ? 'horizontal' : 'vertical'
	cfgStore.save(cfg)
	resetPrev()
}

export function toggleCodex() {
	cfg.codex = !cfg.codex
	cfgStore.save(cfg)
	// Re-collect NOW rather than waiting up to two seconds for the next poll. Every
	// other toggle here shows its effect on the keystroke, and a switch whose whole
	// visible result is "desks appear" is the one where a delay reads as it not
	// having worked.
	// The same four steps the two-second poll runs, because desks are appearing or
	// disappearing — a redraw alone would paint new sessions into the old floor plan.
	setSessions(collect())
	awake.sync(sessions)
	layout()
	resetPrev()
}

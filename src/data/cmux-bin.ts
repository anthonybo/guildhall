/**
 * Where the cmux binary is, if this machine has one.
 *
 * Its own file because two callers need it now — main.ts to jump to a tab, and
 * control.ts to read and drive one — and a copy in each would be a copy that
 * eventually disagrees about which binary is being run.
 *
 * Everything cmux offers is optional. Without it the room still shows every
 * session; it just has no tab to jump to and nothing to type into.
 */
import os from 'node:os'
import { existsSync } from 'node:fs'

export const CMUX = (() => {
	const override = process.env.GUILDHALL_CMUX
	if (override) return override
	const candidates = ['/Applications/cmux.app/Contents/Resources/bin/cmux', `${os.homedir()}/Applications/cmux.app/Contents/Resources/bin/cmux`]
	for (const c of candidates) if (existsSync(c)) return c
	return 'cmux' // fall back to PATH; callers already swallow a missing binary
})()

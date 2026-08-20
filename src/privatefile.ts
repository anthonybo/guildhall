import fs from 'node:fs'
import path from 'node:path'

/**
 * Write a file only its owner can read, and mean it.
 *
 * Every credential this program stores went through `writeFileSync(f, data, {
 * mode: 0o600 })`, which is not what it looks like: **`mode` applies only when the
 * file is CREATED.** Write to a file that already exists and its permissions are
 * left exactly as they were. Measured — a file chmodded to 644, written with
 * `{ mode: 0o600 }`, is still 644 afterwards.
 *
 * So the option protected the case that was already safe (node creating the file
 * itself) and did nothing in the cases that are not: a restore from a backup, a
 * dotfiles repo syncing the directory in, or somebody running
 * `echo 1234 > ~/.config/guildhall/passcode`. After any of those the passcode and
 * the scrypt hash of the control password stay world-readable forever, because
 * nothing ever chmods them.
 *
 * `Config.swift` had already found and fixed this on the Swift side, with a comment
 * saying it "fails in exactly the recovery cases" — and the node side, which is the
 * primary writer of all of these files, was not fixed.
 *
 * The temp-and-rename is what makes the mode guaranteed rather than hopeful: the
 * temp file is new, so `mode` genuinely applies to it, and `rename` carries that
 * mode onto the target whatever the old file had. It also makes the write atomic,
 * which the old in-place writes were not — a crash mid-write left an unparseable
 * config, or a truncated `session.key` that signs every device out.
 */
export function writePrivate(file: string, data: string | Buffer) {
	const dir = path.dirname(file)
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	// `mode` on mkdirSync has the same limitation, so tighten an existing directory
	// too. Not fatal if it fails: the file's own mode is what protects the secret,
	// and a directory we cannot chmod is still one we are about to write into.
	try {
		fs.chmodSync(dir, 0o700)
	} catch {
		// a directory owned by someone else, or a filesystem without modes
	}
	// The pid keeps two processes from colliding on the same temp name — the throttle
	// file is written on every failed attempt, and a room and a headless server can
	// both be running.
	const tmp = `${file}.tmp-${process.pid}`
	try {
		fs.writeFileSync(tmp, data, { mode: 0o600 })
		fs.renameSync(tmp, file)
	} catch (e) {
		try {
			fs.unlinkSync(tmp)
		} catch {
			// already gone, or never created
		}
		throw e
	}
}

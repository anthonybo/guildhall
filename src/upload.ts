/**
 * Images from the browser, saved where a session can read them.
 *
 * A phone has no way to put a picture into a terminal. What a session CAN do is read
 * a file by its path: a path typed into the prompt is opened with the Read tool, and
 * Claude sees the image. So the browser uploads the picture, this saves it, and the
 * path goes into the message like any other text. Measured on a scratch session: a
 * typed path to a PNG was read and described correctly.
 *
 * Stored OUTSIDE every project, so a picture can never end up in somebody's commit.
 * The cost, measured: a session in `default` permission mode asks once before reading
 * from this directory ("allow reading from …/uploads during this session"), which
 * the phone's ⏎ key answers. In `auto` mode it read without asking.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

/** The browser shrinks a photo before sending it (see web/terminal.ts), so a real
 *  upload is a few hundred KB. This only has to stop someone filling the disk. */
export const MAX_UPLOAD = 10 * 1024 * 1024

/** A week: long enough to scroll back to a conversation, short enough that the
 *  folder never becomes somewhere photos accumulate. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

export const uploadDir = () =>
	process.env.GUILDHALL_UPLOAD_DIR || path.join(os.homedir(), 'Library', 'Caches', 'guildhall', 'uploads')

/**
 * What the bytes ARE, from their first few — never from the content-type header,
 * which the sender chooses. Only formats the Read tool understands; anything else is
 * refused rather than saved as a file a session would choke on.
 */
export function kindOf(b: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
	if (b.length < 12) return null
	if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png'
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
	if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif'
	if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp'
	return null
}

/** The body as bytes, or null once it passes `cap` (the connection is cut there). */
export function readBytes(req: http.IncomingMessage, cap = MAX_UPLOAD): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const parts: Buffer[] = []
		let size = 0
		req.on('data', (c: Buffer) => {
			size += c.length
			if (size > cap) {
				resolve(null)
				req.destroy()
			} else parts.push(c)
		})
		req.on('end', () => resolve(Buffer.concat(parts)))
		req.on('error', () => resolve(null))
	})
}

/** Save an image and return its absolute path, or say why not. */
export function saveUpload(bytes: Buffer, now = Date.now()): { ok: true; path: string } | { ok: false; error: string } {
	const kind = kindOf(bytes)
	if (!kind) return { ok: false, error: 'that is not a PNG, JPEG, GIF or WebP image' }
	const dir = uploadDir()
	try {
		// 0700 / 0600: these are whatever was on somebody's phone screen.
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
		prune(dir, now)
		// Random, not a counter or a timestamp: a name nobody can guess, and two
		// uploads in the same millisecond cannot collide.
		const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.${kind}`)
		fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
		return { ok: true, path: file }
	} catch (e) {
		return { ok: false, error: `could not save the image: ${(e as Error).message}` }
	}
}

/** Drop uploads older than KEEP_MS. Runs on each upload, so nothing has to schedule it. */
function prune(dir: string, now: number) {
	for (const name of fs.readdirSync(dir)) {
		const f = path.join(dir, name)
		try {
			if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.unlinkSync(f)
		} catch {
			// gone already, or not ours to remove — either way not worth failing an upload
		}
	}
}

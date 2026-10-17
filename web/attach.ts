/**
 * Putting a picture into a message from a phone.
 *
 * A terminal has no paste for images, but a session reads any file whose path is in
 * the message. So the picture is uploaded, the server saves it (src/upload.ts), and
 * its path is written into the box where the caret is — the message is then typed
 * around it and sent like any other.
 */

/** Long edge, in pixels. Claude scales anything bigger down itself, so sending more
 *  only costs upload time over a phone connection: a 12MP photo is 4032px and
 *  several MB, and this brings it to a few hundred KB. */
const MAX_SIDE = 2000

/** Under this, and already small enough, a file is sent as it is. A screenshot of
 *  text is sharper as the original PNG than re-encoded as a JPEG. */
const KEEP_BYTES = 1_500_000

/**
 * Shrink to what a session needs, as a JPEG — or the original if it is already fine.
 *
 * Decoding through the browser also turns an iPhone's HEIC into something the Read
 * tool understands, which is the other reason not to send the file untouched. If the
 * browser cannot decode it either, the original goes and the server says whether it
 * is an image it accepts.
 */
export async function shrink(file: Blob): Promise<Blob> {
	const plain = /^image\/(png|jpeg|gif|webp)$/.test(file.type)
	let img: ImageBitmap
	try {
		img = await createImageBitmap(file)
	} catch {
		return file
	}
	const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
	if (plain && scale === 1 && file.size <= KEEP_BYTES) {
		img.close()
		return file
	}
	const canvas = document.createElement('canvas')
	canvas.width = Math.round(img.width * scale)
	canvas.height = Math.round(img.height * scale)
	const ctx = canvas.getContext('2d')
	if (!ctx) return file
	// White under it: a transparent PNG flattened onto JPEG's black is unreadable.
	ctx.fillStyle = '#fff'
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
	img.close()
	return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.85))
}

/** Put `path` into the box at the caret, with a space either side where needed. */
export function insertPath(input: HTMLInputElement, path: string) {
	const at = input.selectionStart ?? input.value.length
	const end = input.selectionEnd ?? at
	const before = input.value.slice(0, at)
	const after = input.value.slice(end)
	const lead = before && !/\s$/.test(before) ? ' ' : ''
	const tail = after && /^\s/.test(after) ? '' : ' '
	input.value = before + lead + path + tail + after
	const caret = (before + lead + path + tail).length
	input.setSelectionRange(caret, caret)
}

const CLIP =
	'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/></svg>'

type Upload =(body: Blob) => Promise<{ path?: string; error?: string }>

/**
 * The button, and `take` for pictures arriving any other way (paste, drop).
 *
 * A `<label>` around a file input rather than a button that calls `.click()` on one.
 * Every control in this panel acts on `pointerdown` (see `tap` in dom.ts), and a
 * phone only opens the photo picker from a gesture it counts as a real activation —
 * a touch's pointerdown is not one. The label is the browser's own path from a tap
 * to the picker, so there is nothing of ours in it to get wrong.
 */
export function attacher(upload: Upload, input: HTMLInputElement, said: (msg: string) => void, changed: () => void) {
	const label = document.createElement('label')
	label.title = 'Attach an image'
	label.setAttribute('aria-label', 'Attach an image')
	const idle = () => {
		// Drawn, not an emoji: an emoji brings its own colors and ignores the muted text
		// color every other control in this row takes.
		label.innerHTML = CLIP
		label.append(picker)
		label.className =
			'flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded border border-muted/50 bg-transparent text-[16px] text-muted'
	}
	const picker = document.createElement('input')
	picker.type = 'file'
	picker.accept = 'image/*'
	picker.multiple = true
	picker.hidden = true
	let busy = false

	async function take(files: Iterable<File>) {
		const images = [...files].filter((f) => f.type.startsWith('image/') || f.type === '')
		if (!images.length || busy) return
		busy = true
		label.textContent = '…'
		label.append(picker)
		let added = 0
		let failed = ''
		try {
			for (const f of images) {
				const r = await upload(await shrink(f))
				if (r.path) {
					insertPath(input, r.path)
					added++
				} else failed = r.error ?? 'the upload failed'
			}
		} finally {
			busy = false
			idle()
		}
		if (added) changed()
		const done = added ? `${added === 1 ? 'image' : `${added} images`} attached — finish your message and send` : ''
		said([done, failed].filter(Boolean).join('; '))
	}

	picker.addEventListener('change', () => {
		const files = [...(picker.files ?? [])]
		// Cleared, so choosing the same picture twice in a row still fires `change`.
		picker.value = ''
		void take(files)
	})
	idle()
	return { label, take }
}

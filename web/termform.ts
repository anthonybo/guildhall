/** The bottom of the terminal panel: the message box, the send, and the four answer keys. */
import { attacher } from './attach.ts'
import { tap } from './dom.ts'
import { slashMenu } from './slashmenu.ts'
import { refresh, sendKey } from './termpoll.ts'
import { api, draftOf, keepDraft, newKey, term } from './termstate.ts'
import { settle } from './viewport.ts'

/** Everything below the screen `pre`, built for the session open now. */
export function messageForm(pre: HTMLElement) {
	const form = document.createElement('form')
	form.className = 'flex gap-2 border-t border-line p-2'
	const input = document.createElement('input')
	input.id = 'ask'
	input.autocomplete = 'off'
	input.placeholder = 'Type into this session…'
	input.value = term.openId ? draftOf(term.openId) : ''
	// The phone keyboard's return key says "send" and submits, instead of "return"
	// and doing nothing anybody can see.
	input.enterKeyHint = 'send'
	// Submit on Enter explicitly rather than relying on the form's implicit
	// submission. That relies on the browser finding the submit button, and it was
	// reported not working on a phone; a handler that calls requestSubmit() cannot be
	// defeated by whatever the implicit rules are doing.
	input.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
		e.preventDefault()
		form.requestSubmit()
	})
	// Re-measure around the keyboard appearing, not only when visualViewport says so.
	// Focus and blur are the two signals guaranteed to arrive; `settle` then watches
	// until the animation each one starts has actually finished, which fixed sample
	// points could not — see viewport.ts.
	for (const ev of ['focus', 'blur'] as const) input.addEventListener(ev, settle)
	// 16px, and not a pixel less. THIS is the zooming.
	//
	// iOS Safari zooms the whole page whenever you focus an input whose font-size is
	// under 16px — an accessibility behaviour, not a bug, and it cannot be turned off
	// in any way worth having. The page inherits 15px from `body`, so every tap on
	// this box zoomed the terminal in and left you to pinch back out afterwards.
	//
	// The alternatives are worse. `maximum-scale=1` is ignored by iOS on purpose, and
	// `touch-action: pan-y` does suppress it but takes pinch-zoom with it, which on a
	// view whose whole problem is small text is the wrong thing to remove.
	// `min-w-0`, or Send goes off the edge.
	//
	// An input has an intrinsic width — about 20 characters — and `min-width: auto`
	// means `flex-1` cannot shrink it below that. With four controls in this row it
	// measured 220.5px however narrow the panel got, overflowing by 20.6px at 390 and
	// 91px at 320, pushing Send past the edge. Exactly what clipped Close when the
	// transcript button joined the bar; the rule is the same one and it has to be
	// applied to inputs too, which is where it is least obvious.
	input.className = 'min-h-11 w-0 min-w-0 flex-1 rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label'
	const send = document.createElement('button')
	send.type = 'submit'
	send.textContent = 'Send'
	send.className = 'min-h-11 shrink-0 cursor-pointer rounded border border-gold bg-gold px-4 text-[15px] font-bold text-bg'
	// Send acts on the PRESS, like every other control in this panel.
	//
	// It was the last one still relying on a plain click, and it is the worst place
	// to leave that: a click is only delivered if press and release land on the same
	// element, and pressing Send is the exact moment the keyboard begins to dismiss
	// and the panel resizes under the finger. The button moves between the two
	// halves of the tap and the click is discarded — silently, and indistinguishably
	// from a send that failed on the network.
	//
	// That is the shape of "I pressed send and nothing happened", and it is the one
	// cause of it that had never been ruled out, because every local test drove the
	// server directly and never went near a finger.
	//
	// `requestSubmit` rather than letting the form handle it, since cancelling the
	// press to suppress the synthesised click also suppresses implicit submission.
	tap(send, () => form.requestSubmit())
	/**
	 * Clear the box — on the FAR side of it from Send.
	 *
	 * A long message is tedious to clear on a phone: select-all in a text field means
	 * a long press and a popup, and backspace means holding it. So there is a button.
	 *
	 * Two things about where it is. It sits at the LEFT end of the row, the maximum
	 * distance the row allows from Send, because those two are the pair you least want
	 * to confuse — asked for as "clearly shown and not easy to fat finger". And it is
	 * only present when there is something to clear, so it cannot be hit by accident
	 * while reaching for anything else.
	 *
	 * A mis-tap costs one tap, not the message: clearing keeps the text and the button
	 * becomes Undo until you type again. Destructive-with-undo beats a confirmation
	 * step here, because a confirm would be in the way every single time to guard
	 * against the rare case.
	 */
	let cleared: string | null = null
	const wipe = document.createElement('button')
	wipe.type = 'button'
	const labelWipe = () => {
		const undo = cleared !== null
		wipe.textContent = undo ? '↺' : '✕'
		wipe.title = undo ? 'Put back what was cleared' : 'Clear the message'
		wipe.setAttribute('aria-label', undo ? 'Undo clearing the message' : 'Clear the message')
		// Gold while it is an undo, so the way back is the thing that stands out.
		// `border-muted/50`, not `border-line`. `line` is #302c40 against a #221f2e panel
		// and is the same near-invisible hairline the tables were reported for — and a
		// control that has to be CLEARLY shown is the last place to spend it.
		wipe.className = `min-h-11 min-w-11 shrink-0 cursor-pointer rounded border bg-transparent text-[15px] ${
			undo ? 'border-gold text-gold' : 'border-muted/50 text-muted'
		}`
		// Nothing to clear and nothing to put back: not on screen at all.
		wipe.hidden = !undo && !input.value
	}
	tap(wipe, () => {
		if (cleared !== null) {
			input.value = cleared
			cleared = null
		} else {
			if (!input.value) return
			cleared = input.value
			input.value = ''
			// A cleared box is a new message. The idempotency key must not carry over,
			// or the next send would be answered with the previous one's result.
			term.msgKey = null
		}
		keepDraft(term.openId, input.value)
		labelWipe()
		input.focus()
	})
	const { menu, slashBtn, openMenu, closeMenu } = slashMenu(input)
	// Typing is the end of the undo: the text being replaced is no longer the text
	// that was cleared, and offering to put the old one back would destroy the new one.
	input.addEventListener('input', () => {
		if (input.value) cleared = null
		keepDraft(term.openId, input.value)
		labelWipe()
		// Type-ahead, but only while the line IS a command being written. Once there is
		// a space the argument has started and a list of commands is in the way.
		const typing = /^\/[^\s]*$/.test(input.value)
		if (typing) void openMenu()
		else if (!menu.hidden) closeMenu()
	})
	labelWipe()

	const note = document.createElement('p')
	note.id = 'sendnote'
	note.hidden = true
	note.className = 'm-0 shrink-0 border-t border-gold/40 bg-gold/10 px-3 py-2 text-[0.78rem]/[1.4] text-gold'
	const attach = attacher(
		(body) => api('/api/upload', { method: 'POST', body, headers: { 'content-type': body.type || 'application/octet-stream' } }) as Promise<{ path?: string; error?: string }>,
		input,
		(say) => {
			note.textContent = say
			note.hidden = !say
		},
		() => {
			cleared = null
			term.msgKey = null
			keepDraft(term.openId, input.value)
			labelWipe()
		},
	)
	// A picture pasted into the box (a desktop browser) or dropped on the row goes the
	// same way as one picked on a phone. Text pastes are left alone.
	input.addEventListener('paste', (e) => {
		const files = [...(e.clipboardData?.files ?? [])]
		if (!files.some((f) => f.type.startsWith('image/'))) return
		e.preventDefault()
		void attach.take(files)
	})
	form.addEventListener('dragover', (e) => e.preventDefault())
	form.addEventListener('drop', (e) => {
		const files = [...(e.dataTransfer?.files ?? [])]
		if (!files.length) return
		e.preventDefault()
		void attach.take(files)
	})
	form.append(wipe, slashBtn, attach.label, input, send)

	/**
	 * The four keys a prompt needs.
	 *
	 * Claude Code asks its questions as a list you arrow through, and until now
	 * there was no way to answer one from a phone — which made the browser view
	 * decorative at the exact moment a session was blocked on you. Always visible
	 * rather than shown only when a prompt is detected: guessing whether the screen
	 * is a prompt would be wrong sometimes, and a control that appears and vanishes
	 * is worse than one that is simply there.
	 *
	 * `tap`, so a press registers before anything can move under the finger — a
	 * repaint lands every two seconds and would otherwise eat the click.
	 */
	const keys = document.createElement('div')
	keys.id = 'promptkeys'
	keys.hidden = !term.keypad
	keys.className = 'flex shrink-0 items-center gap-2 border-t border-line px-2 py-2'
	const hint = document.createElement('span')
	hint.className = 'mr-auto text-[0.72rem] text-faint'
	hint.textContent = 'answer a prompt'
	keys.append(hint)
	for (const [label, key, title] of [
		['▲', 'up', 'Move up the list'],
		['▼', 'down', 'Move down the list'],
		['⏎', 'enter', 'Choose the highlighted option'],
		['esc', 'escape', 'Cancel the prompt'],
	] as const) {
		const b = document.createElement('button')
		b.type = 'button'
		b.title = title
		b.textContent = label
		b.className = 'min-h-11 min-w-11 cursor-pointer rounded border border-line bg-transparent px-3 text-[0.9rem] text-label active:border-gold active:text-gold'
		// ⏎ means "submit what I have typed" when there IS something typed.
		//
		// Two different Enters live in this panel and they were indistinguishable. A
		// failed send hands your text BACK to the box above — and then pressing ⏎ sent a
		// bare Enter to the session's prompt, which is empty, so nothing happened while
		// the message sat in plain sight. Reported as "I did have input in the box to
		// submit, that is why I tried the enter function".
		//
		// A person pressing enter with a half-typed message means send it. Only when the
		// box is empty is a bare Enter the answer, and that is exactly when it is wanted
		// — confirming a highlighted option.
		tap(b, () => {
			if (key === 'enter' && input.value.trim()) return void form.requestSubmit()
			sendKey(key, pre)
		})
		keys.append(b)
	}
	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		const text = input.value
		if (!text.trim() || term.sending || !term.openId) return
		const sentTo = term.openId
		let failed: string | null = null
		/**
		 * One key per composed message, reused on every retry.
		 *
		 * The oldest bug here is "I have to send everything twice", and the cause is not
		 * in the send: a lost REPLY is indistinguishable from a lost REQUEST, so a send
		 * that arrived and failed to say so came back as an error, the text was handed
		 * back to the box, and pressing Send again delivered it a second time. Typically
		 * the first message after the machine has slept, because that is the request
		 * that discovers the connection went stale.
		 *
		 * The key is generated once for the text in the box and kept until the server
		 * confirms, so a second attempt is recognised as the same message and typed
		 * nowhere. See src/once.ts.
		 */
		if (!term.msgKey) term.msgKey = newKey()
		const key = term.msgKey
		input.value = ''
		// Say it is working, rather than going quiet.
		//
		// This used to only set `disabled`, which on a phone is indistinguishable from
		// a button that did not register the tap — and the report was exactly that:
		// "I clicked the send button and it did nothing". The word is the difference
		// between waiting and being ignored.
		term.sending = true
		send.disabled = true
		send.textContent = 'Sending…'
		// `finally`, so a throw can never leave the button disabled forever. Combined
		// with the deadline in api(), the worst case is now an error you can read
		// rather than a control that has quietly stopped working.
		let r: Awaited<ReturnType<typeof api>>
		try {
			// `key` may be null if this browser has no usable randomness. The server
			// treats an absent key as an ordinary send, which is exactly the behaviour
			// before this existed — degraded, never broken.
			// 35 seconds, not the usual 20: a long message to a Codex pane is pressed until it
			// submits, which measured up to 21.4s for 2,900 characters (see settled in ask.ts).
			r = await api('/api/send', { method: 'POST', body: JSON.stringify({ id: sentTo, text, ...(key ? { key } : {}) }) }, 35_000)
		} finally {
			term.sending = false
			send.disabled = false
			send.textContent = 'Send'
		}
		if (r.error) {
			// The text comes back so nothing typed is lost — but a network failure is NOT
			// evidence the message did not arrive, and saying "failed" was what invited
			// the second send. The key above makes pressing Send again safe, so the
			// wording can be honest about not knowing rather than guessing wrong.
			const unknown = r.status === 0
			failed = unknown ? `${r.error} — it may still have gone through; sending again is safe, it will not arrive twice` : r.error
			// Only if the box is still empty: whatever was typed while this was in the
			// air is newer than what it would overwrite.
			if (!input.value) input.value = text
		} else {
			// Confirmed. The next message is a new message and gets its own key.
			term.msgKey = null
			// Sent, not cleared: there is nothing to put back, and the button goes away.
			cleared = null
			if (draftOf(sentTo) === text) keepDraft(sentTo, '')
		}
		labelWipe()
		// A send that worked but will sit for a while says so, ONCE, above the screen.
		//
		// Shown as a banner rather than folded into the terminal text, because the
		// terminal text is about to be overwritten by the next poll and this has to
		// outlive that. The whole failure was a send that looked like nothing happened;
		// the answer is not a better send, it is telling you what happened to it.
		//
		// A failure goes here too. It used to be written into the screen, and the
		// refresh() just below repaints the screen — so the reason a send failed was
		// gone before it could be read, and a refused long paste just looked stuck.
		const say = failed ?? r.note ?? ''
		note.textContent = say
		note.hidden = !say
		refresh()
		// NOT re-focused. This reply can arrive many seconds after the tap, by which
		// time the keyboard has usually been dismissed — and focusing an input raises
		// it again, from a timer, with no gesture behind it. That is what broke the
		// view: the keyboard came back up unasked, moved the viewport under a panel
		// that had already finished measuring, and left the terminal sitting halfway
		// down the screen. Whoever still has the box focused keeps it; nobody has it
		// forced back on them.
	})
	return { form, input, note, menu, keys }
}

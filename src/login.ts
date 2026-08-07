/**
 * The passcode screen.
 *
 * Not a login form. guildhall's whole visual language is that a lit screen means
 * somebody is working, so the four digits are drawn as four office windows and
 * each one lights as you type — the app's own signal doing the job progress dots
 * usually do. Arriving here is arriving at a dark office after hours.
 *
 * There is no submit button and no visible field: four digits do not need a form,
 * and a form is exactly what would make this look like every other login. A hidden
 * numeric input holds focus so a phone raises its number pad, the first window
 * carries a caret so it is obvious where typing goes, and tapping anywhere
 * refocuses.
 *
 * Self-contained by necessity — this is served before anyone is authenticated, so
 * it cannot reference the app's stylesheet or script. It never contains the code:
 * what is typed is posted, and the server decides.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type LoginState = {
	/** shown after a wrong code, with how many tries remain */
	wrong?: boolean
	triesLeft?: number
	/** seconds this address must wait, when it has run out of tries */
	waitSeconds?: number
}

export function loginPage(state: LoginState = {}) {
	const locked = (state.waitSeconds ?? 0) > 0
	const message = locked
		? `Too many tries. Wait ${state.waitSeconds} second${state.waitSeconds === 1 ? '' : 's'}.`
		: state.wrong
			? `That code is not right. ${state.triesLeft} ${state.triesLeft === 1 ? 'try' : 'tries'} left.`
			: ''

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#191722">
<meta name="robots" content="noindex, nofollow">
<title>guildhall</title>
<style>
  :root {
    --night: #191722;
    --panel: #221f2e;
    --line: #302c40;
    --gold: #ffd65c;
    --work: #78e2c8;   /* the colour a working session's screen glows */
    --hot: #ff5f5f;
    --muted: #8a8a8a;
    --faint: #6e7681;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 2rem 1.25rem calc(2rem + env(safe-area-inset-bottom));
    background: var(--night);
    color: #d0d0d0;
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
  }

  main { width: 100%; max-width: 24rem; text-align: center; }

  .mark {
    color: var(--gold);
    font-weight: 700;
    font-size: 1.05rem;
    letter-spacing: 0.34em;      /* matches the wordmark in the app's header */
    text-indent: 0.34em;         /* letter-spacing pads the right; recentre */
    margin: 0;
  }
  .sub { color: var(--muted); margin: 0.5rem 0 0; font-size: 0.9rem; }

  /* ── the signature: four windows, one per digit ── */
  .windows {
    display: flex;
    justify-content: center;
    gap: 0.7rem;
    margin: 2.25rem 0 0;
  }
  .win {
    position: relative;
    width: 3.4rem;
    height: 4.1rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 3px;
    display: grid;
    place-items: center;
    font-size: 1.6rem;
    font-variant-numeric: tabular-nums;
    color: transparent;          /* the digit is never shown, only that it landed */
    transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  /* the sill: a window has one, a text box does not */
  .win::after {
    content: '';
    position: absolute;
    left: 12%;
    right: 12%;
    bottom: 0.5rem;
    height: 2px;
    background: var(--line);
    transition: background 140ms ease;
  }
  .win.lit {
    background: #3a3220;
    border-color: var(--gold);
    box-shadow: 0 0 0 1px rgba(255, 214, 92, 0.25), 0 0 18px -6px rgba(255, 214, 92, 0.7);
  }
  .win.lit::after { background: var(--gold); }

  /* the caret marks where typing goes, since there is no visible field */
  .win.next::before {
    content: '';
    position: absolute;
    width: 2px;
    height: 1.5rem;
    background: var(--gold);
    animation: blink 1.1s steps(2, start) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* success: the floor lights up left to right, in the working colour */
  .win.ok {
    background: #1e3a35;
    border-color: var(--work);
    box-shadow: 0 0 0 1px rgba(120, 226, 200, 0.3), 0 0 22px -6px rgba(120, 226, 200, 0.8);
  }
  .win.ok::after { background: var(--work); }

  form.wrong .windows { animation: shake 320ms ease; }
  @keyframes shake {
    25% { transform: translateX(-6px); }
    50% { transform: translateX(5px); }
    75% { transform: translateX(-3px); }
  }

  /* the real input: offscreen but focusable, so phones raise a number pad */
  #code {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 1px;
    height: 1px;
  }
  /* keyboard focus has to be visible even though the field is not */
  #code:focus-visible ~ .windows .win.next { outline: 2px solid var(--work); outline-offset: 3px; }

  .msg {
    min-height: 1.4rem;
    margin: 1.4rem 0 0;
    font-size: 0.86rem;
    color: var(--hot);
  }
  .hint { margin: 0; font-size: 0.86rem; color: var(--faint); }

  .foot {
    margin: 2.5rem 0 0;
    color: var(--faint);
    font-size: 0.76rem;
    letter-spacing: 0.04em;
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<main>
  <form id="form" method="POST" action="/auth" class="${state.wrong ? 'wrong' : ''}" autocomplete="off">
    <h1 class="mark">GUILDHALL</h1>
    <p class="sub">The office is locked.</p>

    <!-- autocomplete off, and the opt-outs the common password managers respect:
         an invisible field they decide to decorate puts a dropdown over the
         windows, and one of them blocks the page from being read at all -->
    <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*"
           maxlength="4" autocomplete="off" autocapitalize="off" autocorrect="off"
           spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore
           aria-label="Four-digit passcode"
           ${locked ? 'disabled' : 'autofocus'}>

    <div class="windows" id="windows" aria-hidden="true">
      <div class="win"></div><div class="win"></div><div class="win"></div><div class="win"></div>
    </div>

    <p class="msg" role="status" aria-live="polite">${esc(message)}</p>
    <p class="hint">${locked ? 'The lights come back on when the wait is over.' : 'Enter the four-digit passcode.'}</p>
  </form>
  <p class="foot">read-only · your local network</p>
</main>

<script>
(() => {
  const input = document.getElementById('code')
  const form = document.getElementById('form')
  const wins = [...document.querySelectorAll('.win')]
  if (!input || input.disabled) return

  const paint = () => {
    const n = input.value.length
    wins.forEach((w, i) => {
      w.classList.toggle('lit', i < n)
      w.classList.toggle('next', i === n)
    })
  }

  input.addEventListener('input', () => {
    // digits only, however they arrived — paste, autofill, or a stray keystroke
    input.value = input.value.replace(/\\D/g, '').slice(0, 4)
    paint()
    if (input.value.length === 4) {
      // light the floor left to right before handing over, so a correct code
      // feels like the room coming on rather than a page navigating
      wins.forEach((w, i) => setTimeout(() => { w.classList.remove('lit'); w.classList.add('ok') }, i * 70))
      setTimeout(() => form.submit(), 340)
    }
  })

  // there is no visible field, so anywhere on the page means "type here"
  const focus = () => input.focus({ preventScroll: true })
  document.addEventListener('click', focus)
  document.addEventListener('touchend', focus, { passive: true })
  window.addEventListener('pageshow', focus)
  focus()
  paint()
})()
</script>
</body>
</html>`
}

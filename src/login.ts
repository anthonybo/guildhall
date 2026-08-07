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
    gap: 0.55rem;
    margin: 2.25rem 0 0;
  }
  /* Each slot is a workstation, drawn the way the room draws one: a monitor on a
     stand, sitting on a desk. Typing a digit switches that screen on — the app's
     own signal for "somebody is working here". */
  .win {
    position: relative;
    width: 3.9rem;
    height: 4.6rem;
  }
  /* the screen, in its bezel */
  .win .screen {
    position: absolute;
    inset: 0 0 1.15rem 0;
    background: #14131c;
    border: 2px solid #3a3648;
    border-radius: 2px;
    transition: background 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  /* two lines of "code", dark until the screen comes on */
  .win .screen::before,
  .win .screen::after {
    content: '';
    position: absolute;
    left: 15%;
    height: 3px;
    background: #23212e;
    transition: background 160ms ease;
  }
  .win .screen::before { top: 26%; width: 55%; }
  .win .screen::after  { top: 46%; width: 38%; }
  /* the stand, and the desk it stands on */
  .win .stand {
    position: absolute;
    left: 50%;
    bottom: 0.85rem;
    width: 0.55rem;
    height: 0.32rem;
    margin-left: -0.25rem;
    background: #3a3648;
  }
  .win .desk {
    position: absolute;
    left: -1px;
    right: -1px;
    bottom: 0.35rem;
    height: 0.5rem;
    background: #6d5136;
    border-radius: 1px;
    box-shadow: 0 2px 0 #523d29;
  }

  .win.lit .screen {
    background: #2a2416;
    border-color: var(--gold);
    box-shadow: 0 0 22px -6px rgba(255, 214, 92, 0.75);
  }
  .win.lit .screen::before { background: var(--gold); }
  .win.lit .screen::after  { background: #b99a3f; }

  /* the caret marks where typing goes, since there is no visible field */
  .win.next .screen::before {
    background: var(--gold);
    animation: blink 1.1s steps(2, start) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* success: the floor lights up left to right, in the working colour */
  .win.ok .screen {
    background: #16302c;
    border-color: var(--work);
    box-shadow: 0 0 26px -6px rgba(120, 226, 200, 0.85);
  }
  .win.ok .screen::before,
  .win.ok .screen::after { background: var(--work); }

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
  #code:focus-visible ~ .windows .win.next .screen { outline: 2px solid var(--work); outline-offset: 3px; }

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
    <p class="sub">The office is closed.</p>

    <!-- autocomplete off, and the opt-outs the common password managers respect:
         an invisible field they decide to decorate puts a dropdown over the
         windows, and one of them blocks the page from being read at all -->
    <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*"
           maxlength="4" autocomplete="off" autocapitalize="off" autocorrect="off"
           spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore
           aria-label="Four-digit passcode"
           ${locked ? 'disabled' : 'autofocus'}>

    <div class="windows" id="windows" aria-hidden="true">
      <div class="win"><i class="screen"></i><i class="stand"></i><i class="desk"></i></div>
      <div class="win"><i class="screen"></i><i class="stand"></i><i class="desk"></i></div>
      <div class="win"><i class="screen"></i><i class="stand"></i><i class="desk"></i></div>
      <div class="win"><i class="screen"></i><i class="stand"></i><i class="desk"></i></div>
    </div>

    <p class="msg" role="status" aria-live="polite" data-wait="${state.waitSeconds ?? 0}">${esc(message)}</p>
    <p class="hint" id="hint">${locked ? 'The lights come back on when the wait is over.' : 'Enter the four-digit passcode.'}</p>
  </form>
  <p class="foot">read-only · your local network</p>
</main>

<script>
(() => {
  const input = document.getElementById('code')
  const form = document.getElementById('form')
  const msg = document.querySelector('.msg')
  const hint = document.getElementById('hint')
  const wins = [...document.querySelectorAll('.win')]

  // The wait was rendered once as a fixed number, so it never ticked and the
  // field stayed disabled after the lock had expired — the page said "wait 15
  // seconds" forever and there was no way in but a manual reload. Count it down
  // here and open up when it reaches zero.
  let left = Number(msg?.dataset.wait || 0)
  if (left > 0) {
    const tick = () => {
      left -= 1
      if (left > 0) {
        msg.textContent = 'Too many tries. Wait ' + left + ' second' + (left === 1 ? '' : 's') + '.'
        return
      }
      clearInterval(timer)
      msg.textContent = ''
      if (hint) hint.textContent = 'Enter the four-digit passcode.'
      input.disabled = false
      input.focus({ preventScroll: true })
      start()
    }
    msg.textContent = 'Too many tries. Wait ' + left + ' second' + (left === 1 ? '' : 's') + '.'
    var timer = setInterval(tick, 1000)
    return
  }
  if (!input) return
  start()

  function start() {

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
  }
})()
</script>
</body>
</html>`
}

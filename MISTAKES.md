# Mistakes

Things that were tried here and did not work, so nobody tries them again.

**Read this before changing anything in an area listed below, and add to it after
any fix that turned out to be wrong.** It exists because one bug — "I have to send
every message twice" — took five attempts across two days, and three of those
attempts were plausible, confidently explained, and useless. The cost was not the
code; it was rediscovering the same dead ends.

An entry belongs here when a fix was *shipped or seriously attempted* and did not
solve the problem. Not for bugs found and fixed cleanly — those live in the commit
message. This file is only for the dead ends.

---

## Sending a message needs two tries

**Status: not solved.** A verify-and-retry now papers over it; the cause is still
unknown.

The symptom: a message sent from the browser does not reach the session, so it
gets typed again. Intermittent — "all the time but not every time".

### Tried and did not fix it

| # | Change | Why it seemed right | What actually happened |
|---|---|---|---|
| 1 | `terminal.input` with `text + \r` in ONE call, replacing `send` then `send-key Enter` | The two-call version had a ~150ms gap where the Enter could be lost | Real bug, real fix — `send` also mangles `\n` — but the symptom continued |
| 2 | Refuse sends to folded rows (409) | tidepool's tab belonged to a parked terminal whose conversation had moved to a background job | Correct diagnosis, wrong remedy: it removed the only route to the session. Reverted in v0.5.2 |
| 3 | Warn instead of refusing on folded rows | Same cause, non-blocking | Right for that case, but the failure kept happening on ordinary rows with no folding |

### Measured, so do not re-measure

- **26 trials against a real scratch session**: atomic `text\r` vs text-then-120ms-then-`\r`,
  idle and busy. **All 26 submitted.** The send path is not the flaky part.
- The comparable project (`onikan27/claude-code-monitor`) uses AppleScript clipboard
  paste plus a hardcoded `delay 0.1` before Enter. It steals window focus, is
  macOS-only, needs accessibility permissions, and cannot target Ghostty by TTY.
  **Do not copy it** — the socket approach is better, and their delay is a
  workaround for a problem their method creates.

### Observed live, not yet explained

- When it happened during this session, the input box was **empty** — the text had
  not arrived at all, rather than arriving and failing to submit. That rules out a
  lost Enter and points at the request never landing.
- A session sitting on a **modal** (onboarding, a dialog, a settings picker) has no
  input box, and text sent to it vanishes silently. Confirmed in a scratch session.
  This is a genuine cause of a lost send and is worth checking before anything else.

### Where to look next

The browser and the network, which every local trial skipped: the 20-second
`AbortSignal.timeout` in `web/terminal.ts`, and the `sending` guard that can
swallow a tap. The distinguishing observation is whether a failed send later shows
up in the session **twice** (client lied about a success) or **not at all** (the
request never arrived).

---

## Measuring the wrong thing

Four times, a number was produced, believed, and reported — and it answered a
different question than the one being asked. The number was real every time.

| Claimed | Actually measured | How it was caught |
|---|---|---|
| "cmux returns errors with exit 0" | `$?` after a pipe: the exit code of `head` | A test written for it passed with the fix removed |
| "the running server has stale code" | The build ARTIFACT's mtime, not the source's — a rebuild of unchanged source makes it look newer | Reading what the running bundle contained |
| "the GIF is fixed" | The GIF file, not the GIF as the browser scales it — an 800px image displayed at 620 CSS px on a 2× screen | Being told three times it looked identical |
| "the nameplates are blurry because of the encoder" | Dithering and scaling, when the plate was being drawn with a 4×6 font in a 16px-wide box | Reading `pick()` in nameplate.ts, which had the answer all along |

**The rule that would have caught all four:** measure the thing the person is
looking at, at the last step of the chain, not the artifact one layer upstream of
it.

---

## Verifying against a screen

- **A submitted message echoes into the scrollback with the same `❯` the prompt
  uses.** Searching the whole screen for the text therefore reports every success
  as a stuck message. A test harness built this way reported 3 of 4 failures that
  were all fine. Read the input box only — the line between the last two
  horizontal rules. `inputBox()` in `control.ts` does this and is tested.

---

## Driving cmux by hand

**Twice, test text was typed into a live Claude session.**

- `cmux send --workspace ""` does not refuse. An empty or unmatched target falls
  back to whatever surface is FOCUSED. The variable was empty because the grep was
  case-sensitive and cmux prints UUIDs in caps.
- `terminal.input` accepts `workspaceId` (camelCase), ignores it, and falls back the
  same way.

`control.ts` validates the UUID before every call for exactly this reason. Anything
driving the CLI directly must do the same, and testing belongs in a scratch
workspace (`cmux workspace create --focus false`), never a real session.

---

## Presentation and discoverability

- **Do not conclude a README is why a project has no stars** without checking
  traffic first. guildhall had **0 views and 0 referrers in 14 days** and was seven
  days old — nobody had ever seen it. A README converts visitors; it cannot create
  them. `gh api repos/OWNER/REPO/traffic/views` answers this in one call.
- **An appended notice stops GitHub identifying a LICENSE.** The MIT text plus a
  sprite attribution after a rule matched nothing, and the repository reported
  `NOASSERTION` — i.e. unlicensed — despite `license: MIT` in the manifest. Keep
  LICENSE pure and put attribution in NOTICE.

---

## Tooling that hides its own fixes

- **A preview server must send `no-store` on IMAGES, not just the page.** Without a
  cache header the browser caches heuristically, and since filenames never change,
  regenerating an image and reloading shows the old one. Two correct fixes to a GIF
  looked like they had done nothing because of this.
- **Tailwind v4 scans the whole project**, not only the paths in `@source`. A word
  in a code comment became a CSS rule in the shipped bundle. `@import 'tailwindcss'
  source(none)` makes the `@source` lines authoritative.

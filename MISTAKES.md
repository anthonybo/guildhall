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
| 2 | Refuse sends to folded rows (409) | a session's tab belonged to a parked terminal whose conversation had moved to a background job | Correct diagnosis, wrong remedy: it removed the only route to the session. Reverted in v0.5.2 |
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

### Found in the browser, where nobody had looked

Every trial above tested the SERVER. The send path was measured 26 times and is
not flaky, and that measurement kept the search on the wrong side of the network.

**Send was the only control still acting on `click`.** A click is delivered only
if the press and the release land on the same element, so anything that moves the
button between them makes the browser discard the tap — correctly, and silently.
Pressing Send is precisely when the keyboard starts to dismiss and the panel
resizes. The button moves out from under the finger mid-tap and no request is ever
made, which matches the one live observation nothing else explained: **the input
box was empty**, so the text had not arrived at all.

The same defect had already been found and fixed twice in this panel — Close
opening pressroom, and the keypad toggle that would not close — and both times the
fix was applied to the button in front of us instead of to every button. `tap()`
existed, and Send was not using it. It is now.

Do not call this solved until it has survived a few days of real use.

### Still open if it recurs

The 20-second `AbortSignal.timeout` in `web/terminal.ts`, and the `sending` guard.
The distinguishing observation is whether a failed send later shows up in the
session **twice** (client lied about a success) or **not at all** (the request
never arrived).

---

## Starting a session from the browser

**Status: built, but the last link is missing.** The spawn works; the new session
cannot be typed into from the phone, which was the point.

### Tried and did not work

| # | Approach | Why it seemed right | What actually happened |
|---|---|---|---|
| 1 | Offer only directories with `hasTrustDialogAccepted` in `~/.claude.json` | Claude Code records its trust decisions there, so the flag should say which directories skip the modal | The flag disagrees with reality **in both directions**: `a project` says `false` and runs fine, `guildhall` is absent from the file entirely and runs fine, `another project` says `false` and does prompt. The list it produced excluded every project actually in use |
| 2 | Detect the trust modal 3.5s after spawning and report it | Better to detect than predict | `claude` takes **25-30 seconds** to draw its first screen. A probe at 3.5s reads a blank terminal and reports success — measured, it passed a session that was sitting on the trust prompt |
| 3 | `cmux workspace create --command claude` | One call makes the tab and starts the agent, and it does | cmux records **no agent information** for a workspace made this way. `terminal.agent` is null, `terminal.resumeBinding` is null, the `terminal` object is empty — checked at 30s, 60s and 90s. Creating it with no `--command` does not auto-start an agent either |
| 4 | Match the orphan session to a tab by their shared DIRECTORY | cmux records `currentDirectory` per workspace, so both sides know it | Ambiguous, and dangerously so. Seven sessions here have `~/projects` as their cwd. The browser picked the lowest `stale` — the most recently active — and opened **an unrelated session's terminal, mid-conversation**, one keystroke from receiving a message meant for a new session |
| 5 | Remember the workspace UUID at spawn time and claim it when the row appears | Exact — no inference at all | Correct but in-memory, and the dev watcher restarts the server on every source edit, so the claim was usually gone before the session registered 25-30s later. Bookkeeping that outlives nothing |

**What actually worked: `ttyName`.** Every cmux panel records it, every Claude
process has a tty, and a tty belongs to exactly one terminal. Nothing to infer,
nothing to remember, and it fixes sessions cmux never tagged as agents — including
ones already running. Measured: **13 of 13** live processes matched to a tab.

It should have been the first thing tried. Three attempts were spent on keys that
were *nearly* unique — a directory, a name, a remembered id — when an exactly
unique one was sitting in the same file.

### Why #3 is the blocker

`cmuxMap()` matches a Claude session to a cmux tab through `terminal.agent.sessionId`
or `terminal.resumeBinding.checkpointId`. Neither is ever written for a
CLI-created workspace, so the row arrives with no `tab` and no `workspace` — and
without a workspace there is no terminal panel and nothing to type into.

Confirmed end to end: spawning into `~/projects` produced a real session that
registered with Claude Code (`state=done`, idle at its prompt) and stayed
`tab=undefined ws=none` across three minutes of polling.

### The remaining option, not yet taken

guildhall created the workspace, so it knows the UUID and the directory. It could
remember that pairing and attach it to the first new session appearing in that
directory. That works, but it is a departure worth deciding deliberately: every
other mapping here is read from something Claude Code or cmux already wrote, and
this one would be guildhall's own bookkeeping. Contained to sessions guildhall
started, and it should degrade to "no tab" rather than guess wrong.

---

## A menu bar app that felt slow

**Status: solved, after four wrong fixes.** None of the four was wrong about
being a real inefficiency; all four were measured against the wrong process.

The symptom: clicking the status item took about two seconds to open the panel,
and switching to its settings page three to five.

### The cause

**launchd was running the app at QoS `utility`.** `contrib/dev.guildhall.bar.plist`
had no `ProcessType`, and `launchd.plist(5)` says an unspecified job gets "light
resource limits … throttling its CPU usage and I/O bandwidth", while "interactive
jobs run with the same resource limitations as apps, that is to say, none".

Measured with `proc_pid_rusage(RUSAGE_INFO_V4)`, which breaks CPU time down by QoS
class, on the same binary:

| started by | user_interactive | utility |
|---|---|---|
| the LaunchAgent, no `ProcessType` | 0.0 ms | **4735.8 ms** |
| LaunchServices (`open -a`) | 1482.4 ms | 8.9 ms |
| the LaunchAgent, `ProcessType=Interactive` | — | **9.8 ms** |
| the LaunchAgent, `ProcessType=Standard` | 0.0 ms | 385.5 ms — still clamped |

`Standard` is documented as equivalent to unspecified, so it is a wasted attempt.
A cold open costs about **250 ms of CPU either way**; clamped that is 528 ms of
wall clock, unclamped 360 ms. The settings switch costs 115-140 ms of CPU and took
**1474 ms clamped against 127 ms unclamped** on an idle machine. `sample` during a
slow open put the main thread in `__CFRunLoopRun` for 4234 of 4374 samples — parked,
not working — and `pageins` was 0 throughout, so it was scheduling, not I/O.

**launchd caches the job definition.** Editing the plist does nothing until
`launchctl bootout` and `bootstrap`.

### Why four fixes in a row appeared to do nothing

`swift/build.sh --install` prints `open -a GuildhallBar`, and an app launched that
way goes through LaunchServices, which does **not** clamp it. So every test after
every rebuild ran on the fast path, while the slow app was the one launchd starts
at login. The fixes were being validated against a process that never had the
problem.

That is the whole lesson, and it is the same one as the entries below: the numbers
were real and they described a different process than the one the person was
clicking.

### Tried, all real improvements, none of them the cause

| # | Change | Why it looked right |
|---|---|---|
| 1 | `launchctl` off the main actor, then cached for 30s | it genuinely was a synchronous subprocess on the main actor, ~30 spawns a minute |
| 2 | Removed `NSApplication.shared.activate(ignoringOtherApps:)` | deprecated, advisory under macOS 14+ cooperative activation, and the reports began in the round it was added |
| 3 | Truncated strings before `Text` | rows really were handing `Text` a 2,577-character transcript excerpt; `lineLimit(1)` limits drawing, not measurement |
| 4 | `.fixedSize` on the scroll content, fixed panel height | the documented fix for `MenuBarExtra(.window)` + `ScrollView` mis-layout — reverted afterwards, since a fixed height leaves an empty panel |

### Measured, so do not re-measure

- **`MenuBarExtra(.window)` is not slow.** A minimal one — `Text("hi")` and a
  button, LSUIElement, ad-hoc signed — opens in **89 ms cold, 26 ms warm**. Do not
  rewrite onto `NSStatusItem` + `NSPanel` for speed. (Serious menu bar apps do use
  that shape, for control over the button and for a persistent hosting view; that
  is a different argument from this one.)
- **The panel's own content costs about 260 ms of CPU on the first open** and 33-58 ms
  warm: ~117 ms for ten rows, ~108 ms for the ScrollView and group headers, and
  roughly nothing for the quota block and the controls. One-time per process.
- `@StateObject` on the `App` struct is **not** recreated per open — stamped once
  per process.
- The polling Task does not starve the main actor: 2.2 ms/s idle.
- **A 250 ms heartbeat cannot tell "blocked" from "descheduled".** `MAIN BLOCKED
  ~1042ms` was not 1042 ms of main-thread work; it was the app not being scheduled.
  The clamped process produced those lines, the unclamped one produced none under
  the same load.

### Still worth doing, not the symptom

After the panel has been opened once, `Panel.body` and the whole session list are
re-evaluated on **every poll while it is closed** — 24 renders per 120 s, about
184 ms of CPU per 120 s that nobody sees.

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
| "the menu bar app is slow because of X" — four times | A process started with `open -a`, which LaunchServices does not CPU-clamp, while the slow one was the LaunchAgent's | QoS accounting per process, which showed 4735 ms of `utility` in one and 8.9 ms in the other |
| "the terminal is not smaller, the type is smaller because the grid is wide" | The FONT SIZE, twice, while the report was about the PANEL being narrow — two different numbers, and only one of them was the complaint | Being told a third time, then measuring panel width: 659px beside a neighbor at 1400px |

**The rule that would have caught all five:** measure the thing the person is
looking at, at the last step of the chain, not the artifact one layer upstream of
it. When a report is repeated after an explanation, the explanation is answering a
different question than the one being asked — measure before explaining again.

---

## One terminal looking narrower than the others

**Status: fixed on the fourth try.** Three of those tries shipped.

The panes really are different sizes — read from the ptys, most are 193 columns,
one is 79, and the one being reported is **70**. But the report was never about the
column count; it was that the pane did not reach the edge of its window.

| # | Change | What was reported back |
|---|---|---|
| 1 | Type cap 15 → 32, so a narrow grid magnifies | "now zoomed in but still not full width" — the panel was STILL being shrink-wrapped to the text, so bigger type only moved the edge |
| 2 | Removed the shrink-wrap, cap back to 16 | "the right width but all the text is on the far left" — the box filled, the text did not |
| 3 | (the two above, in either order) | Each fixed one of the two things that had to change together |

**What it was:** two independent limits, and fixing either alone leaves the symptom
looking identical. `panel.style.maxWidth` shrank the box to the text, and
`COMFORTABLE` capped how wide the text could grow. Both had to go.

**The rule the cap encoded was wrong, not just mistuned.** "Shrink to fit, never
magnify to fill" — argued in a comment on the grounds that stretching 70 columns is
"not full width so much as zoomed in — the columns to fill it do not exist". True,
and beside the point: a terminal that stops halfway across its own window reads as
a fault in the window. No value of the cap fixes that, which is why three were
tried. Type size now has no ceiling at all.

**Do not re-measure the panes.** `stty -f /dev/ttysNNN size` reads the real
dimensions; `cmux`'s state file does not record them, and cols/rows are absent from
every panel object in it.

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

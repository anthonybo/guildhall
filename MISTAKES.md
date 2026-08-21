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

---

## A privacy check that said clean

Four dollar figures, twelve private project names and a home directory reached
commits in a public repository, and the check written to stop that reported clean
over the material three separate times. Each pass read something real. None read
where the material was.

- **`execFileSync` without `maxBuffer` fails OPEN.** Node's default is 1MiB. Over
  it, the call throws ENOBUFS, and the `try/catch` around it returned `''` — which
  is indistinguishable from a clean diff, so the check printed
  "nothing of yours in the diff" and exited 0. Measured: the same file produced
  three findings in a 261-byte diff and **zero** in a 1.27MB one. The gate was
  therefore guaranteed to go silent at exactly the size of the largest leak it
  existed for (222MB of build output). A check that cannot look must exit nonzero;
  it must never report clean.
- **Scanning the tree and the commit messages is not scanning what a push sends.**
  The content fixes were made as one ordinary commit at the tip, so the tree was
  clean and every message was clean while **23 of 25 commits** still carried the
  originals — and `git push` sends all of them. The gate printed
  "nothing of yours in the tree or the range" over all 23. Reading history means
  `git rev-list --objects <range>` and `cat-file` on each blob; nothing less sees
  it. Verified by reconstructing that exact shape in a throwaway clone — a figure
  in one commit, redacted at the tip — where the old code passed it.
- **A hook that hardcodes its range is a real check over the wrong commits.**
  `pre-push` scanning `origin/main..HEAD` regardless of what is being pushed
  examines nothing on any other branch, and on a first push compares against a ref
  that does not exist. git hands the hook `<local ref> <local sha> <remote ref>
  <remote sha>` on stdin; use it. Same family as reading `$?` after a pipe.
- **`git filter-branch` leaves the old history reachable, twice over.** After a
  rewrite, `refs/original/refs/heads/main` and any manual backup branch still point
  at the originals, and reflogs hold the rest — **252MB** of it here, containing the
  absolute paths the rewrite had just removed. Deleting both refs, then
  `git reflog expire --expire=now --all && git gc --prune=now`, took the repository
  to 1.77MB. Until that runs, the material is still on disk and still pushable.
- **An exemption the common path ignores is not an exemption.** `unless` was
  honored only in `--all` mode, so a pattern that had already reasoned about its own
  false positive still blocked the commit introducing the line — this check's own
  comment naming the `100.64.0.0/10` block was refused by the check it documents.
- **Quieting a check with exemptions scattered through prose is how a check gets
  deleted.** Matching any `<label>.local` flagged an invented hostname in a doc
  comment and three test fixtures, and the first fix was four `allow-personal`
  notes in documentation, one of them a `//` inside a JSDoc block. Match the labels
  the machine actually answers to instead, so an invented name passes.

**Then an adversarial review found nine more, two of them in the fix above.** Every
one was reproduced in a throwaway clone, and the pattern is the same sentence every
time: a real check over the wrong bytes.

- **`--not` is an XOR toggle, not a prefix.** It flips `UNINTERESTING` for all
  FOLLOWING revisions, so emitting `--not --remotes=origin` once per ref makes the
  second occurrence toggle negation back OFF — the trailing `--remotes=` becomes a
  positive tip and the second branch becomes negative, marking the commits being
  pushed uninteresting. Measured here: the correct form enumerates 290 objects, the
  accumulated form **0**. Fires on `push --tags`, `--all`, `--mirror`, or any push
  of two new refs. Emit it once, after every positive tip.
- **git hands `pre-push` the remote NAME as `$1`; using `origin` instead is the
  same bug as hardcoding the range.** Pushing the same history to a second remote —
  a fork, a mirror, or the moment a private repo is first published — excluded what
  the FIRST remote had: 0 objects scanned while the push sent 2027, reported clean,
  leak landed in the receiving repo.
- **`git ls-files` + `readFileSync` is a WORKTREE scan wearing a tree scan's name.**
  Four fail-open paths, all measured: a sparse checkout read 13 of 144 files; a
  tracked file deleted without `git rm` went from 3 findings to 0; a non-ASCII
  filename (which `ls-files` C-quotes without `-z`) gave 0 while byte-identical
  content under a plain name gave 3; a symlink read its target instead of its blob.
  Read `git cat-file` against the index.
- **`writeFileSync(f, data, { mode: 0o600 })` does not chmod an existing file.**
  `mode` applies at CREATION only. Measured: 644 in, 644 out. So it protected the
  one case already safe and did nothing in the recovery cases that matter — a
  restore, a synced dotfiles directory, `echo 1234 > passcode`. Write to a temp file
  and rename; the rename carries the new file's mode and is atomic as a bonus.
- **`if cmd | grep …` branches on GREP.** Third occurrence in this repo. Anything
  that fails without printing the literal "error" reported `swift: builds clean`: a
  linker failure, a missing SDK, `xcode-select` pointed at Command Line Tools, a
  compiler crash. Capture the output, test `$?` separately, then grep the text.
- **Widening a pattern is how a check gets turned off.** Fixing real bypasses
  (a comma-grouped figure, `pid=NNNNN`, `NN% of the weekly limit`) immediately flagged shell `"$1"`
  in four scripts and eleven fixture pids. Match the SHAPE of a real figure, not the
  currency symbol, and treat round values as the placeholders they are. Both
  directions have to be tested — the bypass list AND the must-not-fire list.
- **An exemption sized by LINE LENGTH is the wrong measure.** `allow-personal`
  covering a whole minified line exempts a file; capping the line's length instead
  cried wolf on an ordinary 300-character line of real code while still permitting a
  compact abuse. Cap how many findings one comment may cover.
- **A leading `\b` can never match between two word characters,** so a
  private-name regex with one misses every glued form — `getProjectnameBoard`,
  `MyProjectnameClient` — which is exactly how a project name appears in source. 2
  of 5 forms detected.
- **A realistic example inside the checker becomes a finding on somebody's
  machine.** The comment illustrating the glued-name bug named a project, and
  flagged itself on a clone whose sibling directory had that name.
- **`git merge` runs neither `pre-commit` nor any content check.** It runs
  `pre-merge-commit`, which did not exist. `git am` has the same gap.

**Two rules the diff-only design cannot satisfy.** A pattern check at commit time
only ever sees what is being added, so anything committed before the check existed,
anything arriving by cherry-pick or revert (neither runs `commit-msg`), and
anything a `filter-branch` rewrote are all invisible to it. The scan of history at
push time is not redundancy; it is the only pass that reads them.

---

## Reporting that a service started

`--set-serve on` printed **"serving"** over a service that never bound a port, three
different ways, and the symptom each time was a person turning the switch on and
finding nothing in their browser.

- **`launchctl bootstrap` succeeding says nothing about whether the program runs.**
  It means launchd accepted the job. The process then starts, fails to bind, exits
  1, and launchd retries it forever — measured here as a loop respawning every 60s
  for hours, with `last exit code = 1` and a log full of `serve failed`.
- **Probing the port cannot tell your service from something else on it.** An
  interactive `guildhall` room serves on the same port, so `curl` returning 401
  proved only that *something* answered. My verification of this feature was
  contaminated by exactly that: a room was holding 4318 the whole time, and I
  reported the feature working. Compare the LISTENER'S PID with the pid launchd has
  for the job; nothing weaker is an answer.
- **Checking only the exit code fails the other way.** Node takes **over two
  seconds** from launch to listening, so a two-second check reported failure over a
  service that was about to work. The fix has to wait for the positive condition,
  not the absence of a negative one.
- **A port already in use must be refused BEFORE touching launchd,** and the holder
  named. Bootstrapping into a conflict leaves a job that respawns forever, and the
  message people then see blames the wrong thing — this codebase said
  `port 4318 already served — the daemon has it` when the holder was, more often, a
  room in a terminal.

**And a control that takes seconds needs to say so.** The honest check waits up to
ten seconds, which without a spinner and a disabled switch is indistinguishable from
a dead control. The first version reported instantly and lied; the second was
truthful and looked broken.

## Grepping a Swift binary for string literals cannot tell you what it contains

**Not a way to verify the menu bar app.** After installing a rebuilt
`GuildhallBar.app` I checked whether the new UI had shipped by searching the binary
for its literals. `"Show Codex sessions too"` was found, so the install was fresh —
that part is sound, and a single hit is still a useful freshness check.

But `diamond.fill` came back **0**, which read as "the harness mark is missing".
It is not missing. The control test settles it: `checkmark.circle.fill` (21 bytes,
demonstrably used by the app) is **also 0**, and so is `needs you`. Meanwhile
`Claude Code` (11 bytes) is 1. There is no length rule and no pattern — Swift
literals land in the binary or not depending on inlining and constant merging, so
**absence is not evidence of anything**. Two of those four numbers were real and
answered a different question, which is this file's oldest lesson.

Use it only in the positive direction: one hit on a string that is new in this build
proves the bundle on disk is that build. To check that a control *renders*, render it.

**What does not work for driving the app, so nobody re-derives it:**

- `osascript … click menu bar item 1 of menu bar 2` fails with
  `osascript is not allowed assistive access (-1719)` unless the terminal has been
  granted Accessibility. Not worth requesting for a test.
- `screencapture` succeeds regardless, so it happily produces a screenshot of the
  desktop with the panel closed and nothing says the click failed. It also captures
  whatever else is on screen — delete it.
- The offscreen SwiftUI render is still the answer, with the caveat already recorded:
  `cacheDisplay` draws the control color and drops the text, `displayIgnoringOpacity`
  draws the text and drops the accent color, so both are needed.

**Still not solved:** there is no cheap scripted way to assert that a SwiftUI row
appears in the shipped menu bar panel. The Settings switch added alongside this note
was verified only as "compiles, and the bundle on disk is this build".

## The harness mark was drawn in the browser and never in the terminal

**Not a legibility problem — the mark was absent.** `monitor()` takes five
positional arguments and had three call sites: the terminal's half-block path
(`main.ts:789`), the terminal's kitty-image path (`main.ts:921`), and the compositor
the browser and the docs share (`render.ts:186`). When `agent` was added, only the
compositor got it. The mug held the harness color and no terminal ever drew it.

**How the wrong verification happened, because it is the same mistake twice.** I
rendered the desks through `renderRoom` and looked at the mug: teal for Codex, coral
for Claude, exactly as designed. `renderRoom` is the compositor — the one path that
worked. This file already records `--bench` forcing images off and so measuring a
renderer nobody runs; the note there says a benchmark that measures the wrong path
is worse than none, because it is trusted. Rendering through the wrong one of three
renderers is that, again.

The report — "there is no logo at the desks anywhere" — was correct while every
check I ran said otherwise.

**The second hole in the same bug.** The image path built its cache key by hand from
the same five values and also omitted `agent`. So fixing the draw call alone would
have left two desks differing only by harness hashing to one key, and the second
served the first's cached picture. One bug, two independent places, both from
re-listing the same arguments. `monitorFor()` and `monitorKey()` now take one `Desk`
descriptor, so a new field reaches the picture and the key together or not at all.

**And the mug was not findable even once it drew.** Ten pixels at the edge of the
worktop with a bright level badge immediately beside it. Measured by rendering at a
real terminal's 12x24 cell rather than at 8x, where it had looked obvious. It now
also gets a cable and a bezel tinted toward the harness color — the bezel because
it is the largest thing on a desk, with hue carrying the harness and brightness
still carrying lit-ness so neither fact is lost.

**Worth keeping:** four separate tests each confirmed failing when the thing it
guards was removed. None of them would have caught the original bug, because
nothing covers `main.ts`'s draw path — that gap is still open. What closed it was
routing all three callers through one descriptor, not a test.

### Then the mark was drawn and still could not be seen — three times

**The worktop is the wrong surface, and this file already said so.** After the mark
finally reached the terminal it was reported invisible again: "when an agent is
working that is not visible". Correct. The occupant is one tile wide, sits directly
at the desk and is drawn OVER it, so the mug and the cable beside it are covered
exactly while the session is active — which is when you most want to know whose desk
it is. `office.ts` already records this about the working-light: the desk's front
edge "looked right in the sprite" and only about **24 pixels across five lit desks**
survived to the screen. The same trap, one sprite later.

**The bezel tint was the other failed attempt.** It looked convincing in an isolated
crop of two desks — and those two desks shared one carpet. In a real room every pod
has its own carpet color showing through around the monitor sprite, so each frame
already reads as its project's color and a tint inside that ring is low contrast
against a dark screen. Reverted; it was noise, not signal.

**What works: the level badge.** It sits in the aisle beside the desk, is never
occluded by anybody, and is a light card on a dark floor. Its frame was a fixed gray
carrying no meaning, and the tier color it might be confused with is a strip across
the top rather than the edge. Frame tinted 0.75 toward the harness color, plus a
full-strength 10x1 bar on the blank card row under the number — one sprite pixel of
frame is only about three screen pixels at a real terminal cell, which is too thin to
carry a distinction on its own.

**Measured at the right scale this time.** The mug had been judged at 8x, where it is
obvious. Rendered at a real terminal's 12x24 cell it is ten pixels at the edge of the
worktop with a bright badge immediately beside it. Judge room changes at the cell size
somebody actually runs.

**And do not trust a downscaled crop.** Reading the badge frame off a scaled
screenshot, I called the teal one "dark navy" and nearly went looking for a bug that
was not there. The pixel values were right — `[105,163,173]` — and printing them took
one command. Look at the numbers, not at the picture, when the question is a color.

**Third attempt: the badge frame, also invisible.** Reported as "looks the exact
same". The reasoning was that the badge is isolated and high contrast, which is
true, and it did not matter.

**The actual lesson, which took three tries to reach: COLOR IS A SATURATED CHANNEL
IN THIS ROOM.** There is a carpet hue per project, a tier-colored strip on every
badge, and a tool tint on every lit screen. Eleven multicolored cards on eleven
multicolored rugs, and a twelfth hue has nowhere to land. Every attempt failed for
the same reason and each one was argued on its own merits — findability, isolation,
contrast — without ever asking whether hue was the right dimension at all. The
table's harness column had been working the whole time, three feet down the screen,
because `*` and a diamond differ in SHAPE.

**What works: a Codex desk is a different machine.** A laptop — a narrower lid on a
deck wider than itself — against a monitor's wide bezel on a thin neck. Opposite
silhouettes, in the monitor area, which is the one part of a desk nothing covers
because the occupant reaches the worktop and stops. Both harnesses stay positively
identified: a desktop monitor is a statement, not an absence.

A first version of the laptop kept the lid full width and only lowered it, and read
as "the same desk, slightly lower". If the change is meant to be legible at desk
scale, the OUTLINE has to change, not the contents.

**Not gated on the room being mixed,** unlike the table column. The mark is the kind
of machine on that desk, which is a fact about the desk and not a comparison with
its neighbours — the gated version drew a room of nothing but Codex as a room of
desktop monitors.

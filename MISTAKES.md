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

### Fourth and fifth: a different machine, and then reading the question properly

**A laptop instead of a monitor was legible and still wrong.** Having concluded that
color was the problem and shape was the answer, I drew Codex desks with a laptop —
narrow lid, wide deck — against the monitor's wide bezel on a thin neck. It reads
clearly at desk scale. It also answers a question nobody asked: it says these two
desks have different equipment, not which agent each desk belongs to. The request
was "a logo, a clear indication of what each desk represents", three times, and I
kept substituting cleverness with furniture for the plain thing being asked for.

**What was actually wanted: the logos.** Pixel-art reductions of the two vendor
marks, one per desk, in `src/logos.ts`, with the trademark position stated in
NOTICE. The concern about using them was mine, was raised, and was the user's to
decide — after which continuing to work around it was not caution, it was ignoring
the answer.

**Placement took three attempts, and each one lost signs. Worth not repeating:**

| slot | what happened |
|---|---|
| gap column, seat row | A placed image draws OVER text, so the sign covered the status label. `block()` is the fix for that and only moved the problem — the label then had no free cell and vanished. Two existing tests caught it. |
| gap column, one row below the seat | Labels never go there, so the tests passed. But characters WALK that band: two of eleven signs were behind somebody in the very first frame rendered. Passing tests, visibly broken picture. |
| gap column, monitor row | Inside the pod and blocked, so neither a label nor a wandering character can reach it. The only reliable one. |

The monitor-row slot was already taken by the "needs you" placard, which moved down
into the level badge's place rather than being dropped — what a session is waiting
for is louder than its level, and the level is in the table anyway.

**The general lesson, which cost five attempts.** Every one of them was argued on its
own merits and each was locally reasonable. What none of them did was check the
request: a logo. When a specific thing is asked for three times, the useful question
is not "what would read best here" but "why am I not building the thing that was
asked for".

## The default port was 4318, which is OpenTelemetry's

**Shipped, and it failed for a predictable reason.** 4318 is the OTLP/HTTP port by
convention, so any machine running a trace collector already holds it — and a
developer's machine is the only kind this program runs on. Reported from the settings
panel: `port 4318 is held by jaeger, which is not guildhall. Choose another port.` The panel was right, and had no way to help.

**"Pick something high and obscure" is the wrong fix, and it was the first one.** On
macOS `net.inet.ip.portrange.first` is **32768**, so every port above it can be taken
by an outgoing connection's ephemeral allocation. A listener up there works until the
day it does not, which is worse than a conflict you hit immediately. The 40000-49150
range was searched, a candidate picked, and the whole band then discarded.

**A bind test alone does not tell you a port is free — measured, and surprising.**
Binding `0.0.0.0:4318` **succeeds** on macOS while jaeger holds `127.0.0.1:4318`:
node sets SO_REUSEADDR and BSD permits a wildcard bind alongside a specific-address
one. So the obvious check called the conflicting port free. Serving there would send
every `localhost` request to jaeger while only the LAN address reached guildhall —
broken in a way that looks like it worked. `portFree()` now also binds loopback when
asked about the wildcard. The test that asserts the opposite is what found this.

**How the replacement was chosen,** so it is a method and not a preference: over
1024-9999, exclude everything assigned in `/etc/services`, everything listening on
the machine, every port declared in any local checkout, every well-known dev-tool
default, and everything within four ports of any of those. The largest clear run left
was 4205-4295; 4250 is its midpoint, with about 45 ports of clearance each way. That
run is also the band the randomize button draws from, and every candidate is
bind-tested before being offered.

**The settings panel now has a Random button**, because "Choose another port" with no
way to choose one is an error message that blames the reader.

## The browser client was never type-checked

**How a blank page shipped.** `web/room.ts` builds the compositor's `Scene` as an
object literal and I added a required field (`logos`) to that type without adding it
there. The browser threw `scene.logos is not iterable` on its first
`requestAnimationFrame` and every frame after, so the page showed a working header —
version, session counts, "live" — above an empty room. Data was arriving fine; only
the drawing was dead.

`npm run check:types` passed the whole time. **`tsconfig.json` had
`"include": ["src"]`.** The part of this program that gets used from a phone, away
from the machine, had the least checking of anything in the repository — a missing
required property is precisely what tsc exists to catch, and it was never looking.

**Two near-misses in the same hour, from the same cause.** `tools/check-perf.mjs`
builds the same Scene literal and threw the same error — that one surfaced because the
perf gate runs it. So the gate caught the harness and nothing caught the browser.

**And my own search missed it.** Looking for other Scene literals I ran
`grep -rn 'monitors:.*badges:\|badges:.*plates:' src tools web | grep -v 'room.ts:'` —
the exclusion was meant to skip `src/office/room.ts`, and it filtered out
`web/room.ts`, the one file with the bug. A negative filter on a path fragment is not
a filter on a file.

**Fixed by including `web` and `tools`,** which surfaced 21 real type errors that had
accumulated unseen — timer handles typed as `number` while node's types say `Timeout`,
`LOOK[state]` indexed by a bare `string`, `ImageData` refusing a generically-typed
`Uint8ClampedArray`, and `hidden` now being `boolean | "until-found"`. None were
runtime bugs, which is exactly why they had survived: nothing was asking.

Verified by reintroducing the original mistake and watching tsc name it:
`Property 'logos' is missing in type ... but required in type 'Scene'`.

## Two servers ran for half an hour and nothing said so

**Not a crash — an absence.** The launchd service was serving the configured port and
a `tools/serve.mjs --port 4319` dev watcher was serving another, both bound to every
interface, both reachable over the tailnet. They never collided, because they were on
different ports, so no code path anywhere had reason to notice. It surfaced only when
somebody asked why the old port still worked from their phone, and the answer took an
`lsof` by hand: "I have no indication of that and how would I know".

**Why two is worth reporting, measured rather than assumed:**

- **About 1% of a core each, continuously** — 13.6 cpu-seconds over 24 minutes, and
  13.1 over 17. Doubling that buys nothing.
- Two doors on the tailnet. The passcode guards both, but a door you have forgotten is
  not one you can decide to close.
- **They can be different builds.** `dist/main.mjs` is loaded at process start while
  `web/app.js` is read from disk per request, so an old server serves a current browser
  client — half fresh, half stale, which is genuinely hard to reason about.

**`--port` is why the config change could not dislodge it.** A flag overrides the file
for that run, and the watcher re-passes it on every restart. A bound listener's port
cannot change anyway.

**A registry, because the scan is too expensive — measured before choosing.**
`lsof -nP -iTCP -sTCP:LISTEN` costs **90 cpu-ms** and `ps -axo pid=,command=` **80**.
The whole `collect()` poll budget is 12. Anything that cannot be afforded per tick ends
up behind a TTL nobody measured, which is the shape of the 30-second refresh that once
cost a third of a core here. So each server writes `~/.config/guildhall/servers/<pid>.json`
and removes it on the way out; reading the directory and calling `kill(pid, 0)` is
microseconds, so the answer is recomputed on every draw and can never be stale.

**Stale entries are pruned on read, not merely skipped.** SIGKILL runs no cleanup, so
without that the directory fills with the pid of every server that ever crashed and the
warning names processes that do not exist. A warning that cries wolf gets ignored,
which is this repo's own stated reason for keeping the spelling word list short.

Surfaced in all three places somebody might look: the headless startup log (the only
thing a launchd service can say), the terminal's settings panel, and the menu bar's
Settings page.

### And the stop button's own test was the dangerous part

**A test that verifies a safety check by tripping it has to be harmless when the check
is gone.** `stop()` refuses any pid the registry did not announce. To prove that guard
was load-bearing I removed it and re-ran — and got **no output at all**, not even the
failure it should have reported.

The reason: the test used `process.ppid` as a stand-in for a stoppable server. With the
guard removed, `stop(process.ppid)` sent SIGTERM to its own parent shell — killing the
process that would have printed the result. Twice, before it was understood.

Realising that also exposed a real hole in the code, not just the test. `kill(0, sig)`
signals **this process group** and `kill(-1, sig)` signals **every process the caller
may signal**. `others()` only ever yields pids above zero, so the registry check already
excluded them — but that is one gate, and it was the gate being deliberately removed.
There is now a second, independent one: `pid <= 0` is refused before the registry is
consulted. One comparison, against an unbounded failure.

The test uses a disposable `/bin/sleep` child now, and asserts the process actually
exited rather than trusting the return value. Both directions confirmed: removing the
registry check gives "refused for the wrong reason", and making `stop` a no-op gives
"stop reported success but the process is still running".

**Also measured wrong on the way, and worth recording.** The note here claimed a
dev-watcher child comes back "within a second". It does not — the watcher waits 2s, logs
`server exited (0) — restarting in 2s`, then rebuilds, and the replacement bound about
**9 seconds** later. A check at +8s reported the port free and the kill successful, which
is precisely how this would have shipped as working.

### And then the warning told somebody to kill the only server that worked

**The rule was already written down in this repo, and I broke it in a new file.**
`service.ts` says: "A port held by ANOTHER GUILDHALL is not a conflict and must not be
reported as one… The first version refused here and told the person to quit their own
room. That is not an answer."

The Settings page did exactly that. With the port set to one a dev watcher already held,
it showed a single entry — the server that was actually serving, on the port the person
had chosen — under "Another guildhall is holding port 4319… Kill the other one", with a
Kill it button beside it. The one working server on the machine, offered up for killing,
because launchd had not been the thing to start it.

The report was "did you not fix anything.. I still see it showing multiple but I only
see one running", and both halves of that were fair: the list held one row, and the row
was their own server.

**A guildhall on the configured port is a handover.** It is now stated rather than
warned about, in the secondary text color, because the browser view genuinely works.
What is worth surfacing is the part nobody can see: the service cannot bind, so launchd
restarts it every ten seconds forever — and the remedy for that is to stop the SERVICE,
the redundant half, not the server doing the work.

Servers on OTHER ports keep the warning. Those are two doors and twice the cost, which
is the situation this whole feature was built for.

**Watch for this shape.** Three messages in a row were wrong about the same facts —
"another guildhall is also serving" when the service was not serving, then "the service
cannot start" as an alarm about a working handover. Each was more accurate than the last
and still pointed the person at the wrong process. When a warning names something the
user deliberately set up, the warning is probably the thing that is wrong.

### Guards added afterwards, and the scenarios still open

The three wrong messages above were all reporting; none of them stopped the state
happening. Asked directly whether guards had been added, the honest answer was no. These
are the guards, and the scenarios that produced them:

| how the service ends up unable to bind | guarded now |
|---|---|
| another guildhall holds the port (dev watcher, or a room with sharing on) | the watcher gives way: it checks the port before spawning and takes a free one, saying which. It is the disposable half and has no business holding the port the service is configured for |
| a non-guildhall program holds it (a collector, a database, somebody's dev server) | Apply refuses before saving, naming the holder — that port can never work, so committing to it is the mistake |
| the port is changed while the service is running | Apply pre-flights it; the old order was save, restart, hope |
| a port below 1024 | already refused by the range check |
| boot order — a room takes the port first | left alone deliberately. That is a handover: the service retries and wins when the room stops, which is the behavior service.ts already argues for |

**Still open, and both need a hand-edited config to reach.** A `host` that no longer
exists on the machine gives EADDRNOTAVAIL and the same silent retry; the UI only offers
loopback and every-interface, so this needs somebody editing the file. And a port typed
by hand above 32768 can be taken by an outgoing connection later — the pre-flight only
knows whether the port is free *now*, which is why the default and the randomize band
both sit below the ephemeral floor.

**The retry itself is still unbounded** when the holder will never let go. It is now
diagnosable rather than opaque — the log names the holder and says whether waiting will
help — but launchd will still respawn every ten seconds forever. Capping it was
considered and not done: the retry is what makes the legitimate handover recover on its
own, and breaking that to tidy up a case the pre-flight now prevents is the wrong trade.

## The installed service can read every session and type into none

**Structural, and invisible until somebody read it off a phone.** cmux's socket runs in
`access_mode: cmuxOnly`: it accepts control connections only from processes started
inside cmux, which inherit `CMUX_SOCKET_CAPABILITY` from their pane. launchd starts its
jobs with almost no environment, so the installed service has no capability — and the
installed service is the DEFAULT way to serve the browser view.

Reading sessions kept working the whole time, because that comes from files on disk. Only
control was refused, with cmux's own sentence — "only processes started inside cmux can
connect" — shown on a phone underneath a panel that said control was on. Reported as
"access denied — only processes".

**How it hid for so long.** Control was being used from a phone successfully, through a
`tools/serve.mjs` dev watcher started in a terminal inside cmux. Its child inherited the
capability, so everything worked. Killing that watcher — which I did, and should not have
— moved the serving job to launchd and broke control instantly. The feature had never
worked from the service; it had only ever worked from the watcher, and nothing had ever
distinguished the two.

**Two fixes, both supported now.** Run the server from a cmux pane, or give cmux a socket
password. See "Socket Auth" in `cmux --help`, which takes `--password` first, then
`CMUX_SOCKET_PASSWORD`, then whatever is saved in cmux Settings. A password in
`~/.config/guildhall/cmux-password` is passed to the child as an ENVIRONMENT VARIABLE,
never as `--password`, because argv is readable by every process on this machine through
`ps`.

**Each server records its own verdict, and that detail matters.** A panel that ran the
check in its own process would answer a different question: the menu bar app is not
started inside cmux either, so it would report control as broken while a watcher in a
cmux pane was driving sessions perfectly. So `announce()` writes `cmux` and `cmuxNote`
about the process doing the serving, and the panel reads those.

**Do not probe by acting.** The obvious reachability test is to send something and see
whether it lands. `cmux send` with an empty or unmatched target falls back to whatever
surface is FOCUSED — this repo has typed into a live session twice that way. `cmux
capabilities` answers from local state, needs no socket, and reports `access_mode`, which
is the fact that decides the question.

## A Codex session left open overnight vanished from the room

**Shipped, and it hid a session somebody was sitting in.** A locked Codex thread whose
rollout file had not been written for 24 hours was treated as a crashed process and
dropped — from the room, the table and the browser alike. That cutoff measures how long
a session has been QUIET, not whether it exists, and a session you are not currently
typing into is the normal state of a session.

The reasoning in the code was explicit about its own weakness and still got it wrong:
"a rollout names no process, so a generous age is what there is". Three measurements
undo it:

- **Codex removes the lock when a session ends.** 45 rollouts on the reporting machine,
  one lock. Existence is a real signal, not a hint.
- **The lock is never refreshed.** Its mtime is when the session started — lock at 21:23,
  rollout still growing at 21:51. Nothing about it is a heartbeat, so aging it measures
  session lifetime.
- **The lock does name a process.** It is a real advisory flock held open by the owning
  `codex`. A non-blocking flock attempt BLOCKS while the owner lives, and one
  `lsof -c codex` lists every lock every codex process holds.

**Why the check is not in the poll.** `lsof -c codex` costs about **50 cpu-ms** measured,
against a 3 cpu-ms budget for the entire Codex poll. Per tick that is the shape of the
cache that once cost a third of a core here. It runs on a 60-second timer from the
caller instead — 0.08% of a core — and the poll only consults a Set the sweep fills.

**Unswept means shown, deliberately.** Until a sweep has said otherwise a locked thread
is live. Showing a session that has ended is a much smaller wrong than hiding one that
has not, and a sweep that cannot run — lsof missing, directory unreadable — clears its
verdicts rather than guessing.

**And the test that guarded the old behavior was deleted, not adapted.** It asserted the
cutoff was correct, in a file that now proves it is not. A test defending a disproved
premise is worse than no test: it makes the next person think the question was settled.

## "share failed" while the browser view was working

**Shipped, and reported from another machine after an upgrade.** The terminal showed
`⚠ share failed` across the top while the browser view was serving perfectly. The
person had changed the port from the menu bar, which is the easier place to do it,
and the room went on complaining.

Three faults, and the first is the interesting one.

**A user-visible state was decided by searching an error message for a phrase.** The
footer chose between "the daemon has the port, the view is up" and "share failed"
with `share.error.includes('already served')`. A later commit improved that message
to name the holder and its pid — better text by every measure — and the words stopped
matching, so every handover began reporting a failure. Both sides were individually
correct and nothing tested the coupling. It is now a boolean, which cannot be
reworded.

**A running room never re-read the port.** `adoptDiskSettings` deliberately excluded
`port` and `host`, on the grounds that "port and host cannot change under a bound
listener". True, and the wrong conclusion: they cannot change under one, so the
listener has to be REPLACED. Excluding them meant the menu bar's change reached the
service and never reached the room, which kept reporting the old port and kept
failing to bind it.

**And the room gave up permanently.** A failed bind set `cfg.serve = false`, so when
the other guildhall stopped — or the port moved — nothing was left to notice. The
intent to serve now survives a handover and the poll retries, but only for a
handover: something that is not guildhall will not let go, and retrying that is a
loop that cannot end.

**The pattern to watch.** This is the second guard in this file that never matched.
The first compared a payload containing an age in milliseconds, so it fired every
tick; this one compared prose that another commit was free to rewrite. Both were
invisible to tests because each half was right on its own. When a decision depends on
a string somebody else produces, it is not a decision, it is a coincidence.

## The ghost desk, caused by the fix for the mislabelled desks

**A fix two commits old caused a worse bug than the one it solved.** A desk drew a
lit screen, its floor light and the typing animation, with nobody sitting at it —
reported from a real room and visible for as long as the session kept working.

Dropping seat claims on a re-plan was right: desk ids are positional, so `d4` means a
different desk after the pods are re-laid out, and leaving the claims made every
nameplate name the wrong project. But `relocate()`, which runs immediately after,
only moves a character that HAS a seat. With every `seatId` just cleared it moved
nobody, and left ten characters standing on the open floor. `assign()` then handed
out new desks as a claim and nothing more, so the simulation had to walk each one
back — and where that walk failed, both callers of `walkToSeat` answer with
`ch.state = 'type'` where the character is standing. The `type` case then breaks out
of the switch every tick while working, so nothing ever re-checked.

**The fix that mattered was the invariant, not the ordering.** `fit` now re-seats
before relocating, which removes the window; but the load-bearing change is that a
typing character verifies it is at its own desk, and `walkToSeat` seats it outright
when there is no route. A path can fail for reasons that are nobody's fault — most
often the seat tile is still reserved by somebody stepping off it — and the room may
be wrong about how somebody got to their desk, but not about whether they are there,
because the screen, the badge and the floor light all say they are.

**Four fixed reproductions failed before a fuzz found it.** A fresh room: none. Idle
characters then one starts working: none. The same with a re-plan in the middle:
none. A session leaving: none. What found it was 20,000 ticks of random state
changes, arrivals and departures — which is what a room actually does over hours.

**And the tick count is measured, not chosen.** With the fix removed the first ghost
lasting longer than a single frame appears at tick **4,201**, so the 4,000-tick
version of this test passed while the bug was present. It runs 20,000 in about 400ms.
A fuzz that stops before the bug is a fuzz that certifies it.

---

## Clicking a session row did nothing, and the first fix was believed to be the whole cause

**Status: partly solved.** Clicking now brings cmux to the front. It still cannot
switch to the right tab on this machine, because cmux refuses control from processes
it did not start — see the third attempt below.

The symptom: clicking a session in the menu bar panel does not bring that terminal to
the front. Reported as "is there a reason why I cannot click an agent/session and it
bring me to that terminal?" — the README had been promising it for some time.

### Tried and did not fix it

| # | Change | Why it seemed right | What actually happened |
|---|---|---|---|
| 1 | Point `Cmux.binary()` at `Resources/bin/cmux` instead of `Resources/cmux` / `MacOS/cmux` | `MacOS/cmux` really is cmux's **GUI** executable (`plutil -extract CFBundleExecutable`), so `focus()` was running the app binary with CLI arguments. Both streams went to `/dev/null`, so nothing was reported | A real bug, correctly diagnosed and genuinely fixed — and clicking still did nothing. The commit's comment claimed "that is why clicking a session row did nothing", which was wrong |
| 2 | Add a LaunchServices raise after `select-workspace` | `select-workspace` only changes which tab is current; it never touches window ordering, so nothing came forward. Verified with a compiled probe that drove the real `Cmux.focus` | Correct, necessary, and still not enough — **the probe passed for the wrong reason** (see below). On the real machine cmux refuses the select outright, so there was never a tab change to reveal |
| 3 | Send `CMUX_SOCKET_PASSWORD` from the stored password file | cmux documents it under "Socket Auth", and `src/cmuxreach.ts` already uses that file for the server | **Did not get past `cmuxOnly`.** A launchd child supplying a password was refused with the identical "only processes started inside cmux can connect" error. Note that no password was configured in cmux itself, so this disproves the remedy as stated, not the mechanism |

The second half was never there: **`select-workspace` switches which tab is current
inside cmux and does not touch window ordering.** From the room that is invisible,
because the room runs in a cmux pane and cmux is already frontmost. The menu bar app
is never frontmost, so the tab silently changed behind whatever the person was
looking at.

### Measured, so do not re-measure

With Chrome deliberately activated first, then the frontmost app read back from
`lsappinfo front`:

| command | exit | frontmost afterwards |
|---|---|---|
| `select-workspace --workspace <uuid>` | 0 | Google Chrome — **did not raise** |
| `focus-window --window window:1` | 0, prints `OK` | Google Chrome — **did not raise** |
| `open -a /Applications/cmux.app` | 0 | cmux |

**`focus-window` is the trap.** Its help says "Focus (bring to front) the specified
window", it reports `OK`, and it does nothing visible: macOS does not let a background
process reorder another app's windows. Do not reach for it again. LaunchServices is
the route that is allowed to, which is `open -a` from the shell and
`NSWorkspace.openApplication(at:configuration:)` with `activates = true` in the app —
verified from a process with only the environment launchd actually gives this app
(`HOME`, `PATH`, `TMPDIR`, `USER`, `LOGNAME`, `SHELL`, `SSH_AUTH_SOCK`, and the two
`XPC_` variables).

**Checking the binary's date would have proved nothing**, and checking its strings is
what settled it: the installed bundle was built *after* attempt 1 landed and already
contained `Resources/bin/cmux`, so the path fix was demonstrably shipped and the click
was demonstrably still broken. That is what ruled attempt 1 out as the cause rather
than assuming a stale build.

### The verification that passed for the wrong reason

Attempt 2 was checked by compiling the real `Cmux.swift` into a probe, stripping the
environment with `env -i`, running it, and watching cmux come to the front. It passed.
It was still wrong, because **cmux does not decide by the environment variable alone —
a descendant of a cmux pane is accepted without one.** The probe was launched from a
shell inside cmux, so it inherited the ancestry that the menu bar app can never have.

Stripping the environment looked like the careful version of the test and reproduced
the wrong half of the condition. What separated them was running the same binary as a
true launchd child:

| context | ppid | capability | `select-workspace` |
|---|---|---|---|
| shell in a cmux pane | the shell | present | exit 0, `OK workspace:2` |
| `env -i` from that shell | the shell | absent | **accepted** — ancestry alone was enough |
| launchd job (what the app is) | 1 | absent | exit 1, `Access denied - only processes started inside cmux can connect` |

**To test anything about how this app reaches cmux, run it as a launchd job.** A plist
with `RunAtLoad` and `StandardOutPath`, bootstrapped into `gui/$(id -u)`, takes about
a minute to set up and is the only context that tells the truth. Reads are refused as
well as writes, so `workspace list` is a safe probe for it.

**Where the tab numbers come from, since cmux refuses this app:** not the socket.
`main.mjs --sessions` returns `tab` and `workspace` for every session when run as a
launchd child, which is why the panel can show "tab 9" for a row it cannot open. Do
not take a populated payload as evidence that cmux is reachable.

**cmux's own settings are the lever**, not guildhall: `automation.socketControlMode`
in `~/.config/cmux/cmux.json` is `cmuxOnly` by default and also accepts `allowAll`,
followed by `cmux reload-config`.

---

## Rebuilding a scrollback from the screens guildhall already polls

**Status: abandoned, and the reason is upstream.** The browser terminal shows one
screenful and will not show more. Reported as "in the browser version for the terminal
I can only scroll up a little".

**The cause is not in guildhall and cannot be fixed here.** Claude Code draws on the
terminal's ALTERNATE screen, and Ghostty — which cmux embeds — hardcodes
`scrollback-limit = 0` there. The lines are discarded by the emulator before cmux, let
alone guildhall, could see them. It is cmux issue #2334, it is open, and the same
request is open against waveterm (#2837) and xterm.js (#802, #3607).

### Measured, so do not re-measure

- Every Claude and Codex pane on this machine reports `scrollback_rows: 0`. A plain
  shell pane on the `primary` screen reports **115**. Same call, same machine.
- No parameter changes it. `scrollback`, `include_scrollback`, `scrollback_rows`,
  `max_scrollback_rows` and `history_rows` on `terminal.replay` all returned
  byte-identical payloads. `mobile.terminal.replay` returns the same grid.
- cmux exposes no deep link and no per-client viewport into history.

### The idea that was tried, and why it fails

guildhall polls the whole 60-row grid every 2s, so lines that leave the viewport pass
through it. The idea was to keep them. Two live sessions were recorded at 500ms for
five minutes — 454 and 431 deduped frames — deliberately faster than the real 2s poll
so that what a 2s poll MISSES could be measured rather than guessed.

| what was tested | result |
|---|---|
| Does the screen scroll, so lines can be followed off the top? | **No.** 267 of 271 transitions align at `k = 0` — redrawn in place. Over 137s exactly **2** rows fell off. There is no shift to stitch |
| Is the content there at all? | **Yes.** 783 settled distinct rows against 57 on the fullest screen — **13.7×** a screenful, and only 8 of 791 rows were streaming fragments |
| Can it be put back in order? | **No.** Ordering by first-seen time puts a frame's own rows in the right order in **1 of 404** frames (0.2%), with **7.2%** and **10.1%** of adjacent pairs inverted |
| Can a row's text identify it? | **No.** A single frame contains **749** (and in the other session **1052**) duplicate identical rows — borders, indentation, repeated markers |

So the data is genuinely there and cannot be reassembled. A reconstruction would be a
heap of real lines with about one in ten misplaced and duplicates collapsed, which for
code and diffs is worse than nothing **because it would look plausible while being
wrong**.

**The first analyzer said "zero scrolls" for the wrong reason** and nearly ended the
investigation early: it required the shift to explain every row down to row 59, so the
status bar and input box — which repaint every frame — vetoed every candidate offset.
Measuring the best alignment instead of testing a fixed hypothesis is what produced the
numbers above. If this is ever revisited, exclude the churning rows first.

**What was built instead:** `/api/transcript` and `web/transcript.ts` read the history
from the JSONL on disk, which has had all of it the whole time. Not a replacement for
the terminal view — a transcript cannot show a status bar or answer a prompt, and both
were reasons this was nearly built as the wrong thing.

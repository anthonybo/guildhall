# Working on guildhall

Conventions for this repo. These exist because each one was learned the hard way
here, so the reason is given rather than just the rule.

## Releasing

**Never bump the version by hand.** One command does the whole thing:

```
npm run release                            # patch  0.2.0 -> 0.2.1
npm_config_level=minor npm run release     # minor  0.2.0 -> 0.3.0
```

It runs the type check and the tests, bumps `package.json`, tags the commit, and
pushes with the tag — so the number, the tag and the remote cannot drift apart.

*Why:* the version sat at `0.1.0` for 55 commits, through a full module split and
two features, which made it useless as a signal. Then bumping it by hand left
`package-lock.json` still declaring the old version, which silently broke
`npm version` for the next person to try it.

**Bump on anything user-facing.** A new flag, a changed key, different wording on
screen, a behavior change. Not for refactors or comment edits.

The release regenerates `docs/` and `web/app.js` first and commits any change, so
neither the README picture nor the browser client can lag the program. `npm run
check` fails if either is stale — both are byte-for-byte deterministic, so a
difference always means somebody changed the code and did not regenerate. The
images deliberately carry no version or commit stamp; otherwise every commit
would churn them and bury the one change that mattered.

*Why the bundle is checked:* `web/app.js` is tracked but only `npm start` and
`npm run build` write it, so anyone who edits the room and releases without
having run the app ships a browser that draws a different program than the
terminal. The nameplates shipped exactly that way in v0.2.19 — the terminal
tripled them while the bundle still served the old 1:1 plates.

## Committing

- Commit as you go, one scoped change per commit. Say *why* in the body, not just
  what — the diff already says what.
- **No AI or Claude attribution** in commit messages. ("Claude Code" as the
  subject matter is fine; this app monitors it.)
- Ask before committing unless told otherwise, and never push without being asked.

## Code

- **No file over 500 lines.** Split by concern into a directory (`data/`,
  `office/`) rather than by mechanics.
- `npm run check` (types + tests) must pass before any commit.
- `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch` are on.
  If one fires, delete the dead code — do not silence it.
- Comments explain *why*, especially where a value was measured. Numbers that came
  from a measurement should say so, or the next person will "simplify" them away.

## Never commit a credential

`npm run check:secrets` scans the staged diff and the pre-commit hook runs it
first, because it is the one failure a later commit cannot undo — once a secret is
pushed it is public whatever happens next.

It matches private keys, this project's own `scrypt$…` hash format, GitHub/AWS/Slack
tokens, and any secret-shaped name assigned a string literal. It reads only ADDED
lines, so it never blocks unrelated work in a file that already contains something
questionable. If a match is genuinely not a credential, put `allow-secret: <why>` on
the line — the reason is required, so the exemption is a decision rather than a
habit.

**Real secrets live in `~/.config/guildhall/`, never in this repo.** The control
password is stored there as an scrypt hash, mode 0600, and no code path puts it in
the working tree.

**`setControlPass` refuses to write the live config unless the caller passes
`{ live: true }`,** which only the key handler a person typed into does. Anything
that merely imports the module is refused.

*Why all of this exists:* a throwaway script called `setControlPass` to set up a
throttle experiment and silently replaced the real password with a test string. The
only protection at the time was convention — the test files set
`GUILDHALL_CONFIG_DIR` to a temp directory before importing — which protects
whoever remembered it and nobody else. Because the test string looked like a
plausible passphrase and lived in a public repo, "is my password on GitHub?" became
a reasonable question, and answering it took far too long. **Test fixtures are now
named so they cannot be mistaken for real credentials** (`TEST-ONLY-…`).

## Write American English

`npm run check:spelling` enforces it and the pre-commit hook runs it. The prose
here kept drifting British — `colour`, `behaviour`, `licence` — and it was only
ever caught by somebody reading the README and noticing, which is late and
annoying.

It scans **markdown, and quoted strings in `src/` and `web/`** — the two places a
reader actually sees words. It does NOT scan identifiers or comments: `colourOf`
is a real API name in `office.ts`, and a check that demanded a refactor to pass
would be turned off within a week. Tests are skipped for the same reason; a test
name is read by whoever runs the suite.

If a British spelling is genuinely right — an API value from someone else's
service, a quoted name — put `allow-uk: <why>` on the line. GitHub's workflow
conclusions are the live example: `case 'cancelled':` in `web/press.ts` is their
spelling, not ours, and changing it would break the comparison.

*Why the word list is short:* an early version included `arse` and flagged
`parsed` and `git rev-parse`. A check that cries wolf gets disabled, so anything
ambiguous was left out rather than guessed at.

## Staying lightweight

This app watches a machine somebody else is trying to work on. It has no right to
be expensive, and every cost it has ever had arrived the same way — unmeasured.

**There is a budget, and it is enforced.** `npm run check:perf` prints each number
against its ceiling; the pre-commit hook runs it. Activate the hook once per clone:

```
npm run hooks          # points core.hooksPath at .githooks/
```

Current gates, and what each is guarding against:

| check | budget | why |
|---|---|---|
| terminal frame | 4.0 cpu-ms | was **5.6** — `drawPlates` called `choose()` for 11 plates every frame with arguments that never change, 77.6% of the frame |
| `collect()` poll | 12 cpu-ms | catches a broken digest cache or a directory walk added to the hot path |
| `renderRoom` @ browser scale | 20 cpu-ms | was **17.7**, over a 60fps budget by itself — the loop saturated a core and could not keep up |
| `@keyframes` in built CSS | 1 | a perpetual animation costs ~15% of a core on a phone whether anyone is looking or not |
| `web/app.js` | 170 KB | a phone downloads it over a tailnet |

**Measure in CPU time, never wall clock.** Wall clock here is meaningless: the same
benchmark read 2.4 to 17.7ms depending on machine load.

**But CPU time is not load-proof either** — I claimed it was and it is not. Within
one run it is very stable (six readings spread 0.56ms), but the whole level moves
with contention: `renderRoom` costs 9.9 cpu-ms at load 3 and 16.2 at load 27. So the
ceilings are set from the worst honest reading on a busy machine, and **this gate
catches a doubling, not a 20% creep**. That is enough for the regressions this
codebase actually produces and avoids failing commits for weather. Normalising
against a synthetic reference workload was tried twice and made it worse both times
— the reasons are written down in `tools/check-perf.mjs` so nobody repeats it.

**If you need to raise a budget, raise it in `tools/check-perf.mjs` and say why in
the commit.** The number is a decision; moving it silently is how the old costs got
in.

*Costs that got in while nobody was watching, so you know the shape of the enemy:*

- A cache TTL of 30s on a refresh that costs **9.76 CPU-seconds** — a git process
  per repository — which is a third of a core, continuously, while a panel is open.
  Nobody measured what the 30 seconds bought.
- A "push only when something changed" guard comparing a payload that contained
  `stale`, an age in milliseconds. It changed every tick by construction, so the
  guard never matched once: 8KB every 2s to every client, forever, for an office
  where nothing had happened in 35 hours.
- `--bench` forcing images off, so the benchmark measured a renderer nobody runs
  and stayed blind to the most expensive function in it. **A benchmark that
  measures the wrong path is worse than none, because it is trusted.**

## Verifying

**Measure on this machine before claiming anything.** Several confident diagnoses
here were wrong and cost hours:

- The image-loss bug was "obviously" a terminal problem for four rounds. It was a
  desk-ownership bug in the room model; the terminal was fine the whole time.
- A level curve was tuned twice against a snapshot of current sessions before
  anyone measured the accumulation *rate*, which is the number that decides
  whether a ceiling is reachable.
- The release script above was written, committed, and did not work.

**Measure the thing you are claiming, not something next to it.** Three claims in
one afternoon were wrong this way, and each number was real — it just answered a
different question:

- `$?` read after a pipe is the exit code of the LAST command in it. `cmux rpc …
  | head` reports `head`'s status, which is how "cmux returns errors with exit 0"
  became a finding, and a stdout error-sniffer got written for a bug that did not
  exist. cmux exits 1.
- `dist/main.mjs` is a build ARTIFACT. Its mtime moves on every build, including a
  rebuild of source nobody touched, so "the artifact is newer than the running
  process" does not mean the process is stale. Compare the SOURCE mtime, or read
  what the running bundle actually contains. `tools/serve.mjs` had already
  restarted correctly and was accused of not having.
- A test that passes is not a test that works. Delete the fix, watch it fail, put
  the fix back. The rpc test above passed with the fix removed, which is what
  exposed the exit-code claim as wrong.

**Never drive cmux by hand without the workspace guard.** `cmux send --workspace ""`
does not refuse — an empty or unmatched target falls back to whatever surface is
FOCUSED, and `terminal.input` accepts `workspaceId` (camelCase) while ignoring it,
with the same fallback. Both typed test strings into a live session during one
investigation: once from a shell variable that came back empty because the grep was
case-sensitive and cmux prints UUIDs in caps, once from deliberately testing the
camelCase key without thinking about where "ignored" sends it. `control.ts`
validates the UUID before every call for exactly this reason; anything driving the
CLI directly has to do the same. Test against a scratch workspace
(`cmux workspace create --focus false`), never a real session.

Useful harnesses: `npm start -- --bench` for frame cost, a python `pty` harness for
driving the real app and capturing its output bytes, a throwaway `git clone` for
anything that mutates git state, and a scratch `cmux workspace create` for anything
that types.

## Editing

Make changes with the edit tools so the diff is visible in the terminal. Do not
patch files by piping scripts into the shell — the change becomes invisible to
whoever is reviewing it.

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
screen, a behaviour change. Not for refactors or comment edits.

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
| terminal frame | 3.0 cpu-ms | was **5.6** — `drawPlates` called `choose()` for 11 plates every frame with arguments that never change, 77.6% of the frame |
| `collect()` poll | 12 cpu-ms | catches a broken digest cache or a directory walk added to the hot path |
| `renderRoom` @ browser scale | 16 cpu-ms | was **17.7**, which is over a 60fps budget by itself — the loop saturated a core and could not keep up |
| `@keyframes` in built CSS | 1 | a perpetual animation costs ~15% of a core on a phone whether anyone is looking or not |
| `web/app.js` | 170 KB | a phone downloads it over a tailnet |

**Measure in CPU time, never wall clock.** This machine sits above load 10 with a
dozen Claude sessions running, and wall clock under that load is noise — the same
benchmark read anywhere from 2.4 to 17.7ms. CPU time held to ±3% across runs.

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

Useful harnesses: `npm start -- --bench` for frame cost, a python `pty` harness for
driving the real app and capturing its output bytes, and a throwaway `git clone`
for anything that mutates git state.

## Editing

Make changes with the edit tools so the diff is visible in the terminal. Do not
patch files by piping scripts into the shell — the change becomes invisible to
whoever is reviewing it.

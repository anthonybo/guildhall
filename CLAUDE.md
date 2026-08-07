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

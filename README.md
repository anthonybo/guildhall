# guildhall

Every live Claude Code session as a pixel office, in your terminal.

Sessions that are working sit at their desks with a lit screen. Sessions waiting
on you get a placard. Everyone else walks around, gets coffee, plays ping-pong.
Below the room, a table with the detail: what each session is doing, how much
context it has left, and how long it has been ignored.

It is **read-only**. It watches the sessions you already run — in cmux or
anywhere else — and never starts, stops, or moves one. The only thing it writes
is a "focus this tab" request to cmux, and only when you press enter.

```
npm install
npm start
```

## Keys

| key | |
| --- | --- |
| `↑` `↓` | move the selection |
| `⏎` | jump to that session's cmux tab |
| `f` | show only sessions that need you |
| `l` | all labels, or only the ones that need you |
| `a` | keep the machine awake, or let it sleep |
| `tab` | cycle room / split / table |
| `r` | force a redraw |
| `q` | quit |

`--no-awake` starts with the sleep hold off. `--once` prints a single frame and
exits.

## What it reads

Nothing is installed and no session is instrumented. Three sources, all already
on disk:

- `~/.claude/sessions/<pid>.json` — one registry entry per running process
- `~/.claude/projects/<slug>/<sessionId>.jsonl` — the session transcript
- cmux's window layout, for the tab to jump to

## Two things worth knowing

**Status is derived, not reported.** Claude Code writes `busy` on state *change*,
never as a heartbeat, so a session killed mid-turn stays `busy` forever — and a
session that ended its turn on a question reports `idle` even though it is
waiting on you. Guildhall decides whose turn it is from the registry and the
transcript together. See `src/data/state.ts`.

**Levels measure work, not time.** `XP = 25·commits + 3·edits + 15·subagents +
minutes worked`, on an `n³/3` curve. Minutes come from summed turn durations, so
a session left open overnight scores nothing for it. Commits are weighted highest
but cannot be the base — if you gate commits behind approval, your busiest
sessions will have none. The curve is anchored to a measured accumulation rate
(~572 XP/day for the heaviest session observed), which puts a month of hard work
at level 37 and a year at 85. See `src/data/score.ts`.

## Keeping the machine awake

While any session is mid-task, guildhall holds a power assertion
(`caffeinate -ims`) so a long build is not lost to a sleeping laptop. It lets go
when the last one stops. Display sleep is left alone — a dark screen does not
interrupt a build. Sessions *waiting on you* deliberately do not qualify, or the
machine would never sleep again.

Press `a` to arm or disarm it at any time; disarming releases the assertion
immediately. The header shows which of the three states you are in — holding,
armed but idle, or off. Start with `--no-awake` to have it off from the outset.

**The catch:** the room only protects the machine while it is running, which is
the wrong shape for the job — a build runs longest exactly when nobody is
watching a dashboard. `guildhall --guard` is the headless version: same polling
and the same assertion, no rendering, logging each transition.

```
guildhall --guard
2026-08-07 07:56:10  guildhall guard started (pid 66179)
2026-08-07 07:56:10  holding sleep off — marina, draftingroom
2026-08-07 08:14:02  released
```

To have it always on, install it as a launch agent:

```
cp contrib/dev.guildhall.guard.plist ~/Library/LaunchAgents/
# edit the two paths inside, then
launchctl load ~/Library/LaunchAgents/dev.guildhall.guard.plist
```

Unlike the room, the guard does not exit when no sessions are live — a machine
with nothing running now is exactly the one that will have something running in
ten minutes.

## Requirements

- Node 20+
- macOS for the two optional integrations. Both degrade rather than fail: without
  cmux you lose tab-jumping and unread marks, and the sleep hold is a no-op off
  macOS. The room, the table and the scoring work anywhere Claude Code does.
  Set `GUILDHALL_CMUX` if your cmux binary is not in the usual place.
- A terminal implementing the kitty graphics protocol — Ghostty, kitty, or
  WezTerm — for the sprites. Anything else falls back to half-block rendering.

## Layout

```
src/
  main.ts          driver: frame loop, input, image transport
  data.ts          joins registry + transcripts + cmux into Sessions
  data/            paths · registry · transcript · digest · state · score · describe · cmux
  office.ts        Office — drawing and labels
  office/          model · plan (pure layout) · room (seats, paths) · sim (behaviour)
  canvas.ts        half-block pixel canvas
  kitty.ts         graphics protocol, terminal reply demultiplexer
  characters.ts    sprite sheets
  screens.ts       generated monitors and level badges
  props.ts         generated furniture
  table.ts         the detail table
  theme.ts         palette, tiers
```

`npm test` runs the suite; `npm run check` adds the type check. `npm run dev`
runs from source without the build step.

## Credits

Character sprites and the simulation model come from
[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT) — see
`assets/characters/LICENSE-pixel-agents.txt`. The room deviates from it in three
deliberate ways, each documented at the top of `src/office.ts`.

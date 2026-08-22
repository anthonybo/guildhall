# Adding Codex, without breaking the room

A plan, not an implementation. Written first because the browser view is how this
app gets used remotely, and a second agent source touching `collect()` is exactly
the change that could take it down.

## What is already true

Guildhall reads three things, all of which something else already writes:

| source | what it gives |
|---|---|
| `~/.claude/sessions/<pid>.json` | which Claude Code processes are ALIVE |
| `~/.claude/projects/<slug>/<id>.jsonl` | what each one is doing, from the tail |
| cmux's session JSON | which tab a session sits in, so it can be focused |

The first one is the unusual one. A survey of six agent CLIs found **none of the
others writes a per-process registry** — Codex, Cursor, opencode, Amp and pi all
store transcripts only. So "which sessions are alive" is the hard part of adding any
second agent, and it is worth saying that plainly before designing around it.

## What Codex gives us

Two sources, and they are not equivalent.

### The app-server, which is the real answer

Codex 0.149 ships a JSON-RPC 2.0 app-server — the same harness behind the web app,
the desktop app and the VS Code extension. `codex app-server generate-json-schema`
emits the whole protocol (39 files, 965 types), so none of this is guesswork.

`thread/list` returns per thread:

```
id sessionId cwd name preview status turns recencyAt updatedAt createdAt
path projectId gitInfo cliVersion modelProvider source threadSource
agentNickname agentRole parentThreadId forkedFromId section ephemeral
```

and `status` is `notLoaded | idle | systemError | active`, where `active` carries
`activeFlags: ["waitingOnApproval" | "waitingOnUserInput"]`.

That is guildhall's own state model, already computed:

| guildhall | Codex |
|---|---|
| idle | `idle` |
| working | `active` with no flags |
| needs you | `active` + `waitingOnApproval` / `waitingOnUserInput` |

`ThreadListParams` accepts `cwd`, `limit`, `cursor`, `sortKey`, `sortDirection`,
`archived`, `searchTerm` — so we can ask for recent threads in one call rather than
walking a directory.

Push notifications exist for everything we poll for today: `thread/status/changed`,
`thread/tokenUsage/updated`, `turn/started`, `turn/completed`, `item/started`,
`item/completed`, `thread/closed`.

The docs state the core JSON-RPC and thread/turn APIs are **stable**; only the
WebSocket transport is experimental.

**The catch: the daemon is not auto-started.** There is no socket at
`~/.codex/app-server-control/app-server-control.sock` on this machine and no
`session_index.jsonl`, consistent with it never having run here. `codex exec`
sessions — which is what the sessions on this machine are — do not use it.

So the app-server cannot be the only path, and guildhall must not start a background
daemon on somebody's machine as a side effect of being upgraded.

### The rollout files, which are the floor

`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. First line is
`session_meta` (246–470 bytes, holding `id`, `cwd`, `cli_version`,
`model_provider`); the rest is `event_msg`, `response_item`, `turn_context`.

Measured on the 44 rollouts here:

- 35 have a usable header; all 35 have a `cwd`
- 29 carry `token_count` events
- terminal record is `task_complete` (19), `turn_aborted`, or a trailing `message`

**Context comes from `token_count.info`, and the obvious field is the wrong one.**
`total_token_usage` is cumulative across compactions — it reports one session here at
**977%** of its window. `last_token_usage.total_tokens / model_context_window` is the
live figure: 68% for that same session. Anyone reading the docs and reaching for the
first field ships a broken bar.

## Cost, which is nearly free

`ccusage codex daily --json` already works here — 17 days of data. Note the total key
is `costUSD`, where the Claude side uses `totalCost`. `usage.ts` needs a second call
and a second key, not a second design.

## Architecture

### One component, one call site

A single new module, `src/data/codex.ts`, exporting one function shaped like the
existing sources:

```
codexSessions(): Session[]
```

`collect()` gains one line that concatenates it. **`collect()` is not refactored into
a provider interface.** A provider abstraction is the tempting move and it is the
wrong first move: it rewrites the code path that every existing session already flows
through, to support a source that is not proven yet. If Codex earns its place, the
abstraction can follow, with the second implementation in hand to design against.

### Off by default, and the flag is the containment

`config.codex` defaults to `false`. An upgrade changes nothing until somebody asks
for it, the same way serving does. This is the mechanism that makes a regression
here recoverable by a person who is not reading a stack trace: turn it off.

### collect() stays synchronous

`collect()` is sync and lives under a 12 cpu-ms budget. A JSON-RPC round trip is
neither. So the daemon path does NOT happen inside `collect()`.

Instead, the same shape `usage.ts` already uses: a background subscriber keeps an
in-memory snapshot, and `collect()` reads that snapshot synchronously and for free.
When the daemon is absent, the snapshot is filled from the rollout files instead,
under the file-size cache `digest.ts` already established.

```
                 ┌─ app-server up ──→ thread/list + notifications ─┐
   snapshot ←────┤                                                 ├→ Session[]
                 └─ app-server down → rollout head+tail, cached ───┘
```

### Measured costs

These are the ESTIMATES this plan was written on, and two of them turned out wrong.
The measured figures are below them; the estimates are kept because being able to see
which way a guess missed is worth more than a tidy table.

| path | estimated | measured |
|---|---|---|
| rollout, steady state (nothing changed) | 0.20 cpu-ms | **2.27–3.91** |
| rollout, naive full parse of all 44 | 849 cpu-ms | 849 — the version not to write |
| snapshot read in `collect()` | ~0 | n/a, no snapshot was built |

The steady-state estimate was about ten times optimistic. It counted the `stat` calls
and forgot the `readdir`s, and the walk is not cached — only the parsing is.

Worse, the cost is **O(total history, not live threads)**, because the walk visits every
rollout ever written before liveness is consulted. Measured with exactly ONE live
thread throughout:

| rollouts on disk | cpu-ms |
|---|---|
| 45 (the real directory) | 3.91 |
| 500 | **10.46** |
| 2000 | **22.36** |

The whole `collect()` budget is 12. So this crosses it somewhere around a few hundred
rollout files — months of ordinary use — while returning one session.

And `tools/check-perf.mjs` calls `collect()` with no argument, which means Codex is OFF
and the gate never enters the path that costs anything. That is the same mistake this
project already recorded about `--bench` forcing images off: **a benchmark that measures
the wrong path is worse than none, because it is trusted.**

## What could break the browser view, and what stops it

The web client renders whatever `/api/sessions` returns. The risks are not in
parsing, they are in the room.

| risk | why | what stops it |
|---|---|---|
| more sessions than the room has desks | Codex sessions are additive to the count | flag off by default; a cap, and a measured decision about what happens past it |
| sprite and nameplate churn | `assignLooks` hands out looks by index over a stable ordering, so inserting sessions reshuffles who looks like whom | order Codex sessions after Claude ones, so existing sessions keep their look |
| a terminal button that goes nowhere | the button assumes a cmux tab; a Codex session may have none | verify the existing no-tab path — cmux already drops `terminal.agent`, so this case exists today and is handled; add a fixture for it |
| a stale `web/app.js` | the bundle is checked byte-for-byte and only `npm start`/`build` writes it | `npm run check` already fails on this; the release regenerates it |
| an unknown field breaking an old tab | a phone with a cached bundle gets `agent` it does not know | additive optional field; the client already tolerates absent fields, and this is the reverse |

The last row is the one worth stating out loud: **every field this adds is optional.**
A browser tab running yesterday's bundle against today's server must keep working,
because that is the normal state of a phone left open.

### Two claims that were too strong, corrected

**"Not a single existing row moves" is false with the flag ON.** `disambiguate()` is
global over the combined list, so a Codex session whose project name collides with a
Claude one gives that existing Claude row a `distinct` badge it did not have — confirmed
in a browser, where the row gained `⌘2` in its `.away` slot. The behavior is right;
you do want two things called the same name told apart. The claim was wrong, and the
accurate one is: with the flag off, nothing changes at all — verified byte-for-byte
against `main`, including key order; with it on, an existing row can gain a
disambiguator, and nothing else.

**"The browser can type into a Codex session" overstated what shipped, and now it does
not.** The send path worked and was reachable only over HTTP, because both browser entry
points to the terminal panel gate on `s.workspace`, which a Codex session does not have.
A row carrying `agent` with no workspace now gets a send box in its own detail area: a
message field, a Queue button, and the control password field when the grant is not
already held. It reuses the panel's storage key and its fetch helper rather than keeping
a second copy of the password or a second idea of the deadline.

It is deliberately not a terminal. `/api/screen` and `/api/key` still refuse a Codex
target — there is no pane to read and no keys to press — and the message is queued for
the session's next turn, so the box offers exactly that and nothing that looks like
more.

## Phases

Each phase is separately revertable, and none of them is required by the next.

1. **Read-only, files only, flag off.** `codex.ts` + the mapping + tests against a
   committed rollout fixture. Proves the Session mapping without a daemon, without
   touching the web client, and without changing any default.
2. **The `agent` field and how it looks.** One optional field, plus whatever
   distinguishes a Codex worker in the room and the list. This is the phase that can
   affect the browser view, so it lands on its own.
3. **The daemon path.** Socket detection, `thread/list`, the notification
   subscription, the background snapshot. Falls back to phase 1 whenever the socket
   is absent, which is the common case today.
4. **Cost.** The second `ccusage codex` call and the `costUSD` key.
5. **Sending, separately and last.** `turn/start`, `turn/steer`, `turn/interrupt`
   would let the browser type into a Codex session. It goes behind the control
   password like every other write path, and it is the one phase that can do damage,
   so it does not ride along with a read-only feature.

## Phase 3: liveness, and the answer being somewhere else entirely

**`~/.codex/thread-writer-locks/<thread-id>.lock` exists while the process writing
that thread is alive.** That is Codex's live registry, and it had been there the whole
time.

Observed against a running session rather than reasoned about:

| | lock | last record | rollout age |
|---|---|---|---|
| the live session | present | `task_complete` | 46s, then 50s, then 54s |
| two threads from that morning | absent | `task_complete` | ~5 hours |

The lock stayed put across three samples while the session sat idle at a prompt with
its turn already finished — so the lock means **the process is alive**, not "a turn is
running". That is exactly the split guildhall already works in: the lock is the
registry, the rollout tail is the activity. It maps onto
`~/.claude/sessions/<pid>.json` plus a transcript, which is the shape the whole
program is built around.

It also removes the guess. The six-hour window was there because nothing could answer
"is this running"; now a locked thread is shown however long ago it last wrote, and an
unlocked one is not shown however recently it did. Measured against the real
directory: 4 sessions under the age guess, **1** under the locks — the one that was
actually running.

The window survives only as a fallback for an older Codex with no lock directory.

### What the app-server turned out to be worth

Not this. Worth writing down so nobody spends the day again.

The protocol itself is fine and was verified by driving it: newline-delimited JSON,
`codex app-server` runs on stdio as an ordinary child, `initialize` takes
`{clientInfo: {name, version}}`, and `thread/list` answers with `{data, nextCursor,
backwardsCursor}`. Two details a guess gets wrong — `sortKey` is snake_case and
rejects `recency` outright, and `turns` is an ARRAY, not the count its name suggests.

But **`status` is per-instance.** A freshly spawned app-server reports
`{"type":"notLoaded"}` for every thread, because status describes what THAT process
holds in memory. So our own child can never answer the liveness question, whatever the
schema implies. It can only enrich metadata — `name`, `preview`, `gitInfo` — at the
cost of a 66MB process.

And the shared daemon, which does know, could not be reached: it starts and stops
cleanly and `daemon version` returns usable JSON, but its control socket does not
answer plain newline-delimited JSON-RPC. Connecting directly returned nothing, and
`codex app-server proxy` — whose entire description is proxying stdio to that socket —
also returned nothing, empty stderr, no exit, with and without `--sock`.

None of which matters any more, which is the point. The expensive part was assuming
the answer had to be in the protocol because that was where the impressive-looking
API was. One `readdir` of a directory with two files in it was the answer.

## Still open

- **A turn in progress, told apart from a prompt waiting.** The lock says the process
  is alive; the rollout's last record says what it was doing when it last wrote. A
  session idle at a prompt and one mid-turn that has not written for ten seconds are
  currently both read the same way. `turn/started` and `turn/completed` would settle
  it, which is the one thing the app-server would still be good for.
- **`waitingOnApproval`, and what was ruled out trying to reach it.** Codex has the
  state and guildhall has `needs`, and a session blocked on an approval currently reads
  as finished — it never enters the "needs you" band and never turns the menu bar icon
  orange, which is the moment being away from the machine hurts most.

  Checked, so nobody repeats it: there is **no approval record in the rollout files** —
  21 distinct record types across 45 files, none of them an approval. Tool calls and
  their outputs are perfectly balanced (3769/3769), so "a call with no output yet" is a
  real signal in principle but says only that a tool has not finished, not why.

  The daemon still cannot be reached, and now the reason is known rather than guessed:
  the control socket speaks **the WebSocket HTTP Upgrade handshake and WebSocket
  frames**, not raw newline-delimited JSON, which is why connecting directly returns
  nothing. `codex app-server proxy` is supposed to bridge that to stdio and does
  negotiate, but the daemon closes the connection immediately — `failed to copy data
  from stdin to socket: Broken pipe`. The protocol also requires an `initialize` request
  followed by an `initialized` NOTIFICATION before anything else is accepted; sending
  that did not change the outcome. `daemon enable-remote-control` exists and was NOT
  tried, since turning on remote control of somebody's machine is not a debugging step.

  One lead, unverified and not built on: `~/.codex/logs_2.sqlite` has a `logs` table
  carrying `thread_id`, and 18 of its rows mention approval, at DEBUG and INFO from
  `codex_core::session::handlers` and `codex_core::session::turn`. It is an internal
  rolling log — 150,797 rows written, 2,445 retained — so a feature built on it would
  stop working silently. Worth checking against a session that is actually waiting,
  which is how the lock directory was settled.
- **Subagents.** `agentRole`, `parentThreadId` and `forkedFromId` look like they map
  onto what `agents.ts` already models for Claude. Worth checking rather than
  assuming.
- **Whether the lock is durable.** It is undocumented and internal. It is also a
  file whose name is a thread id in a directory called `thread-writer-locks`, which
  is about as legible as an internal detail gets — and the fallback below it is the
  age guess, so losing it degrades rather than breaks.

## Sources

- <https://learn.chatgpt.com/docs/app-server> — the protocol, and the status semantics
- <https://github.com/openai/codex/tree/main/codex-rs/app-server> — the implementation
- <https://github.com/kcosr/codex-threads> — a CLI over the app-server doing list,
  status, send, steer and interrupt; the closest thing to a reference for this
- <https://github.com/PixelPaw-Labs/codex-trace> — rollout parsing and live tailing
- <https://ccusage.com/guide/codex/> — token and cost accounting from rollouts
- <https://allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs/> — where
  six agent CLIs keep their logs, and the absence of live registries

## Not built: starting a Codex session from the browser

The `+ session` button always runs Claude Code. `spawn()` in control.ts hardcodes
`cmux workspace create … --command claude`, and nothing in the Codex work changed it.
Reading Codex sessions, their cost, and sending into an existing thread are all
supported; creating one is not.

**This is not a one-line change, and the reason is worth stating before anyone tries.**

The spawn flow's safety rests on one thing: `spawn()` returns the cmux workspace UUID and
the browser waits for the row carrying *that workspace*. That exists because the obvious
alternative — matching the new session by its directory — is what once opened an
unrelated session's terminal, mid-conversation, one keystroke from receiving a message
meant for somebody else. Seven sessions here share `~/projects`.

A Codex session has no cmux workspace. That is deliberate and recorded in data/codex.ts:
"No tab and no workspace: a Codex session is not a cmux pane." So the correlation the
Claude path depends on does not exist for Codex, and the safety argument does not
transfer.

Starting `codex` inside a cmux workspace would produce a workspace UUID, but guildhall
would still build the Codex row from `~/.codex` rollouts, which carry no reference to it.
Linking the two needs a handle, and the candidates are:

- **cwd plus a narrow time window** — the newest rollout in that exact directory created
  after the spawn. Tighter than the Claude failure (which picked "whichever was busiest"
  in a shared directory), but still inference, and it is wrong if somebody starts a Codex
  session by hand at the same moment in the same place.
- **An exact id from the CLI.** `codex --help` shows no flag to pin or print a thread id
  at start. `codex agents` lists sessions on the app-server daemon and may expose one —
  unverified, and the app-server route has its own open questions recorded above.

Until one of those is settled, this stays unbuilt rather than built on inference.

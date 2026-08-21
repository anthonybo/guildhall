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

| path | cost | budget |
|---|---|---|
| rollout, steady state (nothing changed) | **0.20 cpu-ms** | 12 for all of `collect()` |
| rollout, 4 files actively changing, 64KB tail | 3.41 cpu-ms | |
| rollout, naive full parse of all 44 | **849 cpu-ms** | — the version not to write |
| snapshot read in `collect()` | ~0 | |
| daemon present? one `stat` on the socket | microseconds | |

The naive number is in this table on purpose: it is what a straightforward
implementation costs, and it is seventy times the entire poll budget.

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

## Still open

- **The initialize handshake.** `codex app-server proxy` gives a stdio JSON-RPC pipe,
  which avoids hand-rolling socket framing; the exact opening call needs confirming
  against a running daemon. `ClientRequest.json` lists methods as enums rather than
  consts, so the method list did not fall out of the schema the way the rest did.
- **Whether guildhall should ever start the daemon.** It is a background process on
  somebody's machine. That is a setting, not a side effect, and the default is no.
- **Whether `thread-writer-locks/` is a liveness signal.** It is empty with nothing
  running, which is consistent but not evidence. Watching it during a live session
  would settle it, and would give the file path a liveness source better than mtime.
- **Subagents.** `agentRole`, `parentThreadId` and `forkedFromId` look like they map
  onto what `agents.ts` already models for Claude. Worth checking rather than
  assuming.

## Sources

- <https://learn.chatgpt.com/docs/app-server> — the protocol, and the status semantics
- <https://github.com/openai/codex/tree/main/codex-rs/app-server> — the implementation
- <https://github.com/kcosr/codex-threads> — a CLI over the app-server doing list,
  status, send, steer and interrupt; the closest thing to a reference for this
- <https://github.com/PixelPaw-Labs/codex-trace> — rollout parsing and live tailing
- <https://ccusage.com/guide/codex/> — token and cost accounting from rollouts
- <https://allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs/> — where
  six agent CLIs keep their logs, and the absence of live registries

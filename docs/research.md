# Competitive research

What else exists in this space, what it does that guildhall does not, and what is
worth taking. Kept because the same question keeps coming up and re-finding these
links costs an afternoon each time.

Reviewed August 2026. Star counts and versions are from then and will drift.

---

## Where guildhall sits

Almost everything in this space **owns the sessions it shows you**. It launches
the agent inside its own terminal, in a worktree it created, and can only show you
what it started.

Guildhall reads what Claude Code already writes — the registry under
`~/.claude/sessions/`, the transcripts under `~/.claude/projects/` — so it sees
sessions started anywhere: a cmux tab, a bare terminal, a background job. It
installs nothing and modifies no settings file.

That is the whole differentiator, and it is not theoretical:

- A commenter on the thread below asked Scape's author for exactly this — the
  ability to *"drop in active sessions from terminal, or at least detect and
  populate them in the agents bar"*. Scape cannot; it did not start them.
- Four of the five GitHub projects reviewed here require installing hooks into
  `~/.claude/settings.json`.

**The cost of that choice**, stated honestly: hooks give clean `PermissionRequest`,
`PreCompact` and `SubagentStart` events. Transcripts only imply them. If the
notification triggers below ever need to be reliable rather than inferred, an
OPTIONAL hook is the one place worth breaking the zero-install rule — optional,
because zero-install is the property none of the others have.

---

## The Reddit thread that started this

**["Example of a real working loop orchestrator"](https://www.reddit.com/r/ClaudeAI/comments/1vnnpur/example_of_a_real_working_loop_orchestrator/)** — r/ClaudeAI, 1.1k upvotes, 149 comments. All read.

An orchestrator agent ("Lloyd") whose job is managing its own SQLite ticket table.
The community's own summary: the concept landed, and the thread turned on the post
being an undisclosed ad for the author's product, `scape.work`.

**The ideas worth keeping:**

- **A loop is just a heartbeat.** A timer that pings the agent to re-read its
  mission note and run its playbook. Nothing cleverer than that.
- **A database beats a bigger context window.** The agent files its own tickets and
  looks up related past work — "tribal knowledge" that survives a model change.
  Argued as better than a folder of markdown because it can be *queried*: show me
  open tickets from this period matching this title.
- **A second table logging every turn.** Mentioned in passing and arguably the
  better idea: not the tickets, but the journal of what each agent actually did.
- **Heartbeat over triggers**, deliberately. Trigger infrastructure means the agent
  must be up 24/7 and something must watch every data source. A heartbeat runs only
  when you have it online.

**Operational lessons, learned the hard way by other people:**

- **Schedule the next run before the current one finishes**, or the loop dies
  silently.
- **Never delete, mark closed.** Add `closed_reason` and `superseded_by`. A deleted
  row makes a bad call indistinguishable from a clean backlog. Then read the last
  20 it closed each week and count how many you would reopen — that count is the
  only thing that tells you it is safe to run unattended.
- **Make ticket assignment atomic.** "Find an open ticket, then mark it assigned" as
  two queries lets two workers claim the same one.
- **Put a governor on quota.** One commenter caps background agents at 20% of the
  plan window so they cannot starve his interactive work. Another burned a month's
  allowance in two days.

---

## Products

### Scape — <https://scape.work>

A macOS app that wraps a real terminal and launches agent CLIs inside its own
sessions. Local-first, iCloud sync, harness-agnostic (Claude Code / Codex /
OpenCode). $9.99 one-time, $9.99/mo Pro, $19.99/mo Supporter, 7-day trial. <!-- allow-personal: competitor pricing, published on their own sites -->
**v1.112, three releases in four days** — shipping fast.

Docs: [Argus](https://scape.work/docs/argus) · [Watchdogs](https://scape.work/docs/watchdogs) · [What is Scape](https://scape.work/what-is-scape) · [Changelog](https://scape.work/changelog)

- **Argus** — reads a Mission note, pulses on a timer (30s–4h), spawns children in
  fresh git worktrees with full auto-approve on standard tools. Max 8 children
  (settable 2/4/8/16), depth limit 1, risky capabilities blocked by default.
- **Watchdogs** — detects pending `AskUserQuestion` prompts via hook sidecar files,
  plus permission gates and periodic drift review. Makes an LLM call (Haiku by
  default) and **answers by sending terminal keystrokes**. Configured in natural
  language: *approve all file edits but escalate any git push*. Escalates after 10
  retries or 2 convergence failures.
- Playbooks, Tables, Notes, Toolkit, dev servers, SSH, browser, spectator mode,
  backchannels, inter-session messaging, Jira/GitHub/Slack inboxes.
- Real-time usage percentages against plan limits (v1.111).

**Decision: do not build this.** It means replacing cmux, which is explicitly not
wanted, to compete with a $10 app shipping every other day. And its headline
feature — auto-approving permission prompts with a cheap model — is the exact thing
`serve.ts` refuses on purpose. Reasonable for a local app you are sitting in front
of; not for something reachable from a phone over a tailnet.

### Symphony — <https://github.com/openai/symphony>

OpenAI's open-source spec plus an experimental Elixir implementation. Watches a
work board (e.g. Linear), spawns an agent per task, requires **proof of work** — CI
status, PR review feedback, complexity analysis, walkthrough videos — then merges
autonomously on acceptance. Framing: *manage work instead of supervising agents*.

---

## The five closest projects on GitHub

| Repo | ★ | Language | What it is |
|---|---|---|---|
| [onikan27/claude-code-monitor](https://github.com/onikan27/claude-code-monitor) | 302 | TS | **The nearest thing to guildhall.** CLI TUI + mobile web UI, QR handoff, Tailscale |
| [FulAppiOS/Agent-Quest](https://github.com/FulAppiOS/Agent-Quest) | 91 | TS | Pixel-art fantasy village; heroes walk between buildings by tool type |
| [matt1398/claude-devtools](https://github.com/matt1398/claude-devtools) | 3.8k | TS | Context attribution, compaction visualization, tool-call inspection |
| [mikehasa/agentacct](https://github.com/mikehasa/agentacct) | 589 | Python | Cost/usage TUI: per-session, per-model, rate-limit bars, SVG export |
| [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | 1.5k | Python | Hook-event pipeline → live pulse chart, filters, dual-color coding |

**claude-code-monitor** is worth reading properly — it solved the same problem.
Hook-based discovery (writes to `~/.claude/settings.json`), CLI with `●◐✓` status
icons and vim keys, `h` shows a **QR code** to open the phone UI, screen capture
with pinch zoom 1×–5×, multi-line send, Tailscale for remote. It **does** let you
answer permission prompts from the phone with a d-pad — the opposite of the call
made here, and worth being deliberate about rather than drifting into.

**Agent-Quest** maps tool type to *place*: Library = Read, Forge = Edit, Arena =
Bash. Guildhall already computes `toolKind` and only uses it to tint a monitor.
It also auto-discovers **every** `~/.claude*` directory (`~/.claude-work`,
`~/.claude-personale`) plus `~/.codex`.

**claude-devtools** breaks the context window into seven attributed categories
(CLAUDE.md layers, skills, @-mentions, tool I/O, thinking, team overhead, user
text) and visualizes compaction — what filled, what compressed, what was lost.

**agentacct** shows cost and **% of weekly plan per session**, per-model token
breakdown, live rate-limit bars with reset countdowns, and exports the current view
as an SVG with one key.

**disler** treats `PermissionRequest` and `PreCompact` as first-class events, and
draws a canvas pulse chart of activity over a 1/3/5-minute window with a
dual-color border scheme (app color + session color).

---

## Also named, not reviewed in depth

Orchestrators and worktree managers, for when this question comes round again:

- [Nimbalyst](https://nimbalyst.com) — successor to Crystal (deprecated Feb 2026), open source, local-first
- [Vibe Kanban](https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/) — one card = one worktree + agent, 10+ CLI agents, community-maintained since Bloop shut down April 2026
- Conductor — orchestrator-only, Mac, diff-first review, one worktree per agent
- Baton — open-source CLI orchestrator, worktree per session
- [band.ai](https://band.ai), [slancha.ai](https://slancha.ai), [intentic.dev](https://intentic.dev) — named in the thread; band.ai does cross-agent comms
- [9 open-source agent orchestrators](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- Also seen: [codeburn](https://github.com/getagentseal/codeburn) (9.3k★), [tokscale](https://github.com/junhoyeo/tokscale) (5k★), [ClaudeBar](https://github.com/tddworks/ClaudeBar) (1.4k★ macOS menu bar quota), [claude-code-otel](https://github.com/ColeMurray/claude-code-otel) (OpenTelemetry)

---

## Backlog, in the order I would do it

Everything here is compatible with staying read-only. Nothing requires owning a
session.

**Free — the data is already parsed**

- Cost and model per row. Someone in the thread burned a month of quota in two days
  without noticing; tidepool ran at its context limit and a day of budget here and nothing said so.
- Plan burn in the footer: the five-hour and weekly windows. Already on Claude Code's own
  status line; agentacct and Scape both ship it.
- Context-cliff warning past ~90%, rather than a gauge you have to read.
- Context attribution instead of one number — what is actually filling the window.
- Branch or worktree per row. One `git rev-parse` per cwd; catches two sessions on
  one branch.
- Stuck vs idle. `stale` is already computed; "blocked 20+ min on a question" is a
  different state from "finished".

**Small and cheap**

- **QR code to open the phone view.** Removes typing a tailnet IP on a phone, which
  is the actual first-run friction. Straight from claude-code-monitor.
- Number keys 1–9 to jump to a session; `j`/`k` alongside `↑`/`↓`.
- SVG snapshot of the current view. `docs/room.svg` already renders deterministically
  — same machinery, one key.
- Session export to Markdown/JSON. Terminal copy-paste with ANSI codes is miserable.

**Genuinely missing**

- **Discover every `~/.claude*` directory**, not one fixed path. Anyone with a
  second install is currently invisible.
- **Notifications with real triggers**: `.env` access, tool errors, token spikes,
  custom regex. This is the watch-and-notify heartbeat, concretely specified.
- **Permission prompts as visible state.** Answering them remotely stays refused;
  showing *which session is blocked on what* is pure observation and is the biggest
  waste of wall-clock there is.
- Cross-session search.
- Per-session activity journal — the second table from the thread.

**Ideas**

- Tool type drives *where the character walks*, not just the screen tint.
- A live pulse sparkline of room activity.
- SSH remote reading via `~/.ssh/config`.

**Explicitly not doing**

- Ticket database, child spawning, Argus-style orchestration — a different product.
- Auto-answering permission prompts. See `serve.ts`; it is the fifth guard and the
  reason is written there.

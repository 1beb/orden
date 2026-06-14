# Clean restart and live recovery

Design for restarting the orden host without abandoning in-progress agent
sessions, and for recovering sessions whose agent process was taken down by a
restart or crash. The goal is operator-stated plainly: a host restart should be
invisible to running work, and the board should reflect reality within seconds
of coming back up.

## Problem

Developing orden while running orden means restarting the host to load new
backend code. Today that restart is destructive in practice:

- `apps/host/src/serve.ts` has no `SIGTERM`/`SIGINT` handler. Killing the
  process just drops it.
- TUI sessions actually survive — they run in detached tmux
  (`launchDetached` in `terminal.ts`, `tmux new-session -d -s <tmuxNameFor(id)>`),
  and tmux is its own server. But the handoff is broken: the browser WebSocket
  is dead until a manual refresh, agent lifecycle hooks that fire while the host
  is down are lost (they curl a dead port), and the board can stay wrong for up
  to five minutes until `idleReconciler` sweeps stuck `in-progress` cards to
  `blocked`.
- GUI / native Chat sessions are worse: their driver runs in-process
  (`nodeHost.ts`: "chat drivers live for the host process lifetime"). A restart
  kills the agent mid-turn for real.

So the agents are not the core problem for TUI — the handoff is. For GUI, the
problem is that the agent executes inside the process being restarted.

## Principle

The agent must not execute inside the process you restart, and the UI must snap
back to truth on reconnect without a manual refresh. State that matters
(conversation transcript, card state) is already durable in the vault; recovery
is about reconnecting to it, not reconstructing it.

## Phase 1: graceful restart and boot reconcile (TUI)

TUI agents already survive. Phase 1 makes the restart clean and the recovery
immediate.

### Graceful shutdown

Add a `SIGTERM`/`SIGINT` handler to `serve.ts` that stops accepting new
connections, flushes in-flight vault writes, and exits fast. It never touches
tmux — detached agents are meant to outlive the host.

### Fast restart workflow

A `restart` dev command that signals the running host, waits for the port to
free, and starts the new process — so there is no manual kill-then-start dance
and the dark window is one to two seconds rather than however long a human
takes.

### Boot reconcile (authoritative)

On startup, enumerate sessions, probe real liveness with `tmux has-session` per
session, and reconcile every card from durable signals immediately — not after
the five-minute idle window. A session whose tmux is gone moves to a correct
resting state; a live one is confirmed in place. This reuses the durable-signal
logic already in `idleReconciler` (transcript mtime, creation-time floor), run
once eagerly at boot instead of only on the periodic timer.

### Web auto-reconnect

The web WebSocket client reconnects with backoff and re-hydrates its stores on
reconnect, so the UI goes live again with no refresh. This pairs with the
existing build-info toast (which already detects a newer `dist`).

## Phase 2: out-of-process agent runner and self-recovery (GUI)

When GUI becomes a primary mode, phase 1 is not enough — the agent runs inside
the host. Phase 2 moves the agent runner out of the restartable process.

### Single agent daemon (`agentd`)

All chat drivers live in one long-lived `agentd` process. The `serve` process
(HTTP, web RPC, MCP) connects to it over a local socket and restarts freely; as
long as the edit is in the serve/web/MCP layer, GUI sessions are untouched.

The single-daemon shape is chosen over per-session processes deliberately: with
durable transcripts and harness-level resume, a daemon crash is survivable (see
recovery below), so per-session fault isolation buys less than it costs, and one
process is trivially trackable and killable. The blast radius of a daemon crash
is "every GUI session pauses and resumes," not "work is lost."

### Crash and restart recovery

Recovery is the same reconcile machinery as phase 1, triggered by "daemon died"
instead of "host restarted":

1. Detect the crash / SIGTERM of `agentd`.
2. Enumerate the blast radius: the daemon's owned sessions whose card state is
   `in-progress`. This is exact and cheap — the daemon knows its own session
   set; any in-progress member was interrupted. Mark them `blocked` so the
   operator is not fooled into thinking they are still working.
3. Respawn `agentd`, then loop the blast-radius sessions and push a recovery
   prompt into each, through the same path the chat composer already uses to
   send prompts to a GUI session (`SessionManager.prompt` / the chat-core
   engine). The prompt is plain language:

   > You may have been interrupted mid-task by a restart. Check your actual
   > state — re-read the files you were editing, run `git status` — and decide
   > whether to continue, redo, or skip what you were doing.

The agent reads its own transcript and decides. orden encodes no recovery logic
and no last-event taxonomy. Resuming an interrupted session — including closing
out a tool call that never returned a result — is the harness's responsibility
(the claude CLI and opencode both resume interrupted sessions by design), not
orden's. orden talks to the harness, not the raw Messages API.

### The one verify-during-implementation item

The mid-tool-execution case — a session whose last recorded event was a tool
call with no result — must be checked empirically: confirm the harness `resume`
accepts a fresh prompt cleanly for that session rather than erroring or hanging.
This is a per-session `try/catch` around step 3, not a redesign: a session the
harness cannot resume simply stays `blocked` for a human glance — the state we
already have.

### Optional safety valve

A non-idempotent denylist (destructive git, database migrations, `git push`)
can, for an interrupted tool on that list, hold the session at `blocked` and ask
for a human glance instead of auto-continuing. This is belt-and-suspenders, not
core: the recovery prompt already tells the agent to verify before redoing, and
a well-behaved agent checks state first. The valve only guards the few
genuinely irreversible actions against a sloppy agent.

## Why not the alternatives

- A monolithic daemon that also holds the serve layer was rejected: editing the
  chat-core/runner code still restarts it, and it has no isolation benefit over
  the chosen split.
- Per-session detached processes (one runner per GUI session, tmux-supervised)
  were considered and dropped in favor of the single daemon: with resume making
  crashes survivable, the isolation gain did not justify N tracked processes.
- Hot-reloading host modules in place was rejected as Node-fragile
  over-engineering; the durable-state plus fast-restart approach reaches the
  same "live updates while developing" outcome without it.

## Sequencing

Phase 1 ships first and stands alone — it is needed regardless of GUI adoption,
and its reconcile/reconnect plumbing is written to be agent-mode-agnostic so
phase 2's recovery reuses it wholesale. Phase 2 follows when GUI sessions become
common enough to justify the `agentd` split.

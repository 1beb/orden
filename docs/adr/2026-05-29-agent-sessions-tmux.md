# ADR-0006: Tmux-based agent sessions with git worktree isolation

**Date:** 2026-05-29
**Status:** accepted

## Context

Orden must spawn and resume real AI coding agents (Claude Code, opencode) as
interactive terminal sessions. Sessions must survive browser disconnects, be
resumable across restarts, support local and remote execution, and isolate each
session's filesystem changes from others working in the same project.

## Decision

**Host each agent in tmux via `node-pty`. Use git worktrees for filesystem
isolation. Never use headless `claude -p`.**

- tmux provides lifecycle, durability (sessions survive disconnects), and a
  uniform local-or-remote surface via `ssh host tmux`.
- The terminal is rendered in the web UI using xterm.js over the pty WebSocket.
- Each session works in a git worktree under its assigned project folder,
  isolating filesystem changes between concurrent sessions.
- Session identity is tracked: for Claude Code, orden mints the conversation id
  (`claude --session-id <uuid>`) and records it as `conversationId` on the
  session record. For opencode, the id is captured from the serve API
  (`POST /session` → `{ id }`).
- Resume: `cd <cwd> && claude --resume <conversationId>` (or the opencode
  equivalent). The session record persists `cwd` and `conversationId` so resume
  is context-aware.
- **Headless `claude -p` is explicitly banned.** Sessions are the interactive TUI
  only. The `prompt()` method on SessionManager throws to surface this loudly.

**Rejected alternatives:**

- **`claude -p` headless mode.** Would route through API billing rather than the
  subscription. The interactive TUI is the intended agent experience.
- **No tmux, just a bare pty.** Would lose disconnection resilience — a browser
  tab close would kill the agent.
- **Docker containers for isolation.** Heavier than git worktrees and adds
  container management complexity. Git worktrees provide sufficient filesystem
  isolation with minimal overhead.

## Consequences

**Easier:**

- Sessions survive browser crashes, network drops, and deliberate disconnects —
  the tmux session keeps running.
- Remote sessions are identical to local (ssh + tmux), enabling the "run agent on
  a powerful machine, interact from a laptop" workflow.
- Worktree isolation means concurrent sessions in the same project don't step on
  each other's files.

**Harder:**

- tmux dependency: every host machine must have tmux installed.
- Session cleanup requires explicit tmux session killing; abandoned sessions
  accumulate if not reaped.
- The two agents have different session models (Claude is process-per-session over
  stdio; opencode is a persistent local HTTP server), requiring separate launch
  paths.
- Worktree creation, assignment, and cleanup policy needs careful management to
  avoid accumulating stale worktrees.

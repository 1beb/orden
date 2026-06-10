# ADR-0005: Single HTTP server multiplexing all transport

**Date:** 2026-05-29
**Status:** accepted

## Context

Orden needs multiple concurrent transport channels: static file serving for the web
bundle, a WebSocket for UI-to-host RPC and live change feed, MCP HTTP for agent
tool calls, raw file bytes for the image/code viewers, and agent lifecycle hooks.
Running separate servers per protocol adds operational complexity with no benefit
for a single-user tool.

## Decision

**One Node process serves one HTTP server on one port (default 4319).
All transports multiplex through it.**

Route map:

- `GET /` — static web bundle from `apps/web/dist`.
- WebSocket upgrade — UI↔host RPC (vault, files, sessions, locks) + live change
  feed. The `/term` WebSocket upgrade is a sub-case that connects to the agent PTY
  instead.
- `POST /mcp` — agent MCP tool calls (Streamable HTTP). Per-session binding via
  `/mcp/<conversationId>`.
- `/hooks/` — agent lifecycle hooks (UserPromptSubmit, Stop, Notification).
- `/repo-file/<projectId>/<path>` — raw file bytes for image/code viewers.

**Rejected alternatives:**

- **Separate servers per protocol (e.g., WS on one port, MCP on another).**
  Adds port management, CORS, and configuration surface for no functional gain.
- **A separate process for the MCP server.** The MCP server must share the live
  in-memory `Host` and change feed with the web RPC; a separate process would
  break the reactive vault reactivity that makes the kanban live-update.

## Consequences

**Easier:**

- Single process to start, stop, and debug. No cross-origin configuration needed.
- The MCP server and web RPC share one `VaultStore`, so an agent's `card_move`
  instantly appears on the live board via the shared change feed.
- Binding runs loopback + tailnet IP only by default (never `0.0.0.0`), so there
  is no accidental LAN/public exposure.

**Harder:**

- The single server must handle WebSocket upgrades, MCP POSTs, and static files on
  one port with no framework router — this is raw `node:http` with manual URL
  dispatch. Adding a new route type requires touching the central dispatch.
- No process isolation between transports — a crash in one handler takes down
  everything. Mitigated by the single-user scope.

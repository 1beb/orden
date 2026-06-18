# ADR-0015: Host file root for opening arbitrary referenced files

**Date:** 2026-06-14
**Status:** accepted

## Context

`panel_open` and the file viewers resolved every doc path relative to a
*project* root (ADR-0013). A file outside every project root — e.g. the user's
global `~/.claude/CLAUDE.md` — could not be opened, edited, or annotated:
`panel_open` wrote its intent but the web silently refused to render it, because
the `/repo-file` route and `FsFiles` reject any path that escapes a known
project root (`relative(root, full)` starting with `..`).

This surfaced when the user asked to see a simple referenced document and the
agent could not bring it up. The limitation was never a deliberate access
policy — it was an emergent consequence of the per-project file model plus a
routine path-traversal guard. The user's intent: open/edit/annotate ANY file
they reference, without being forced into a project flow.

## Decision

**Add a reserved `"host"` file root that resolves to `/`, so an absolute doc
path opens directly with no project.**

- `makeProjectRootResolver("host") => "/"`. `join("/", "/abs/path")` is
  contained, so the existing traversal guard admits any absolute path. The byte
  route (`/repo-file`) and `FsFiles` (read/write/annotate over RPC) share this
  one resolver, so open + edit + annotate all work through the single sentinel.
- An absolute doc target routes through `"host"` automatically: in the web
  `openRepoFile` (covering panel-intent, recent files, and clicks), in the MCP
  `panel_open` tool, and in the `/agent/panel-open` HTTP fallback.
- These ad-hoc files are a deliberate escape hatch from the per-project model,
  NOT projects. They are never listed, watched, or fed to omnisearch: omnisearch
  keeps reading the project file tree (`listFiles`), while recent-files (nav) may
  list them so the user can re-open.

**Rejected alternatives:**

- A new `panel_open` `kind` for absolute paths — more API surface than simply
  auto-detecting a leading `/`.
- A per-file allowlist — friction with no real benefit for a single-user local
  tool whose agent already has full shell access.

## Consequences

**Easier:**

- The user, or an agent on their behalf, can surface any on-disk file in the main
  panel for read/edit/annotate without adding a project.

**Security posture (accepted, revisitable):**

- The `"host"` root lets `/repo-file` (unauthenticated GET) and `files.read` /
  `files.write` (WS) reach any path the host process can access, over the host's
  loopback + tailnet bind — a strict broadening of project-only serving. Accepted
  because orden is single-user, the bind is the user's own devices, and the agent
  already runs with the user's full shell access. It can be narrowed later (gate
  `"host"` to loopback, or behind a setting) without changing the resolver shape.

## Related

This session also shipped two adjacent changes: proactive `panel_open` of review
docs (the `orden-surface-docs` skill, plus a one-line nudge in the MCP
instructions and AGENTS.md), and an `/agent/*` HTTP fallback mirroring
`panel_open` + `card_move` + `card_create` for when an agent's MCP transport
drops mid-session. See `apps/host/src/agentRoute.ts` and `terminal.ts`
(`sessionLaunchEnv`).

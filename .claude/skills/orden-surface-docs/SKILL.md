---
name: orden-surface-docs
description: Use in an orden session right after you write or render a doc the user should read — any .md/.html/.qmd/.ipynb plan, report, or writeup. Surfaces it in the main panel unprompted, and survives an MCP drop.
---

# Surface docs in the orden main panel

When you create or finish a document for the user to read — a plan, a review, a
report, any `.md`/`.html`/`.qmd`/`.ipynb` writeup — open it in their main panel
yourself, the moment it is ready. Don't wait to be asked.

Only surface docs that live inside the session's project or worktree. `panel_open`
resolves a path under a project root and refuses anything outside it, so an
absolute path to a file elsewhere on the machine will not render.

## The normal path (MCP up)

For a doc that needs rendering: edit the source, call `doc_render({path})`,
confirm `ok` is true, then `panel_open({kind:"doc", target:<outputPath>})`. The
two tools stay separate on purpose — verify the render before you open it.

For a doc that needs no render (a plain `.md`): just
`panel_open({kind:"doc", target:<repo-relative path>})` once it's written.

## When the orden MCP tools are gone

The `orden` MCP server can disconnect mid-session; claude then marks it
disconnected and `panel_open` and the `card_*` tools disappear for the rest of
the run. The host is still up. Fall back to its HTTP API from a shell, using the
env the session launched with (`ORDEN_PORT`, `ORDEN_SESSION_ID`):

```bash
curl -sS -X POST \
  "http://127.0.0.1:${ORDEN_PORT:-4319}/agent/panel-open?orden_session_id=${ORDEN_SESSION_ID}" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"doc","target":"docs/report.html"}'
```

The same fallback drives the board:

- `/agent/card-move` with `{"state":"in-progress"}` or `{"state":"blocked"}`
- `/agent/card-create` with `{"title":"..."}` (optionally `description`, `notes`)

Each route runs the same host logic the matching MCP tool does, resolving "my
card" from `$ORDEN_SESSION_ID` — so the panel and the board keep working even
after the MCP transport dies.

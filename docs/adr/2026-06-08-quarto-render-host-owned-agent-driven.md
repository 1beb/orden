# ADR-0014: Document rendering is host-owned, agent-driven

**Date:** 2026-06-08
**Status:** accepted

## Context

Orden renders documents (Quarto `.qmd`/`.md` → HTML) as part of the agent review
loop. The render must always run on the host (it owns quarto, the environment,
and render error capture). But the agent must orchestrate the process: edit the
source, trigger the render, verify success, then surface the result.

## Discussed in

Conversation `2f886c18-7abf-44b3-8412-ee916a622279` (2026-06-05 to 2026-06-08):

> "When we are working on a qmd document and you render it, I want you to
> automatically open it in the main panel."

This was refined during the same brainstorming session:

> "The render always has to happen on the host, but the agent should say when it
> happens, make sure it completed, then open/update the main panel view with the
> rendered result."

When the agent presented a combined vs separate tool choice, the user responded:

> "two tools please"

## Decision

**Split rendering into two MCP tools kept deliberately separate: `doc_render`
builds, `panel_open` surfaces. The verify-then-open step stays an explicit
agent gate.**

- `doc_render({ path })` — host runs quarto synchronously, returns
  `{ ok, outputPath, errors }`. Build only; surfaces nothing.
- `panel_open({ kind: "doc", target: outputPath })` — existing tool, surfaces a
  rendered path in the main panel.
- Agent procedure: edit the `.qmd`/`.md` source, call `doc_render`, check `ok`;
  on success `panel_open(outputPath)`, on failure read `errors` and fix without
  touching the panel.
- Re-render-on-annotation is the same loop with no special case: annotation comes
  back → edit source → `doc_render` → verify → re-`panel_open`.
- Gated by `capabilities().docRender` (true when quarto is on PATH).
- Gated on the MCP side so the agent knows whether the tool is available.

**Rejected alternatives:**

- **One combined tool `doc_render_and_open`.** Would allow the agent to open a
  document without verifying the render succeeded — the user sees a broken page.
  Two-tool pattern forces an explicit check.
- **Agent-side rendering (agent runs quarto).** The agent may not have quarto
  installed or the correct environment. Host-owned rendering keeps the
  dependency in one place.
- **Auto-render on file save.** Would couple the save path to the render path;
  the explicit gate keeps the agent in control of when renders happen.

## Consequences

**Easier:**

- The agent's verify-then-open step is mandatory — it can't accidentally surface
  a broken render.
- Quarto errors are captured and returned to the agent as structured feedback,
  not lost in terminal output.
- `panel_open` is reused for all surface types (docs, pages, kanban, cards),
  keeping the main-panel navigation uniform.

**Harder:**

- The agent must explicitly call two tools in sequence. A well-prompted agent
  does this naturally, but a naive agent might call `panel_open` without
  rendering first.
- Quarto must be installed on the host machine — gating behind `docRender`
  capability means the tool is simply absent when quarto is missing.

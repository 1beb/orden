# ADR-0001: ProseMirror as editor, markdown as source of truth

**Date:** 2026-05-28
**Status:** accepted

## Context

Orden needs an authoring surface for the daily journal outliner and document editing.
The primary content format must be durable, diffable, and agent-readable. Annotations
must survive edit cycles and cold restarts. The editor must support real-time
collaboration as a future possibility.

## Decision

**Use ProseMirror for the WYSIWYG editor with markdown as the source of truth.**

- ProseMirror provides the editing surface with full schema control (prose, lists,
  tables, headings).
- Markdown on disk is the durable format. ProseMirror serializes back to it on every
  save; the editor never stores internal state as the canonical form.
- Annotations are ProseMirror marks carrying only an opaque `id`. The mark's position
  tracks through edits, splits, and reorders automatically via ProseMirror's native
  position mapping. The durable content (body, thread, status) lives in a separate
  log keyed by that id — markdown stays clean of annotation metadata.
- On cold start (markdown has no marks), stored annotations re-anchor by re-finding
  their stored quotes via context-disambiguated text matching.
- The app is built vanilla (no React/framework). ProseMirror is framework-agnostic
  and handles the heavy lifting; a framework wrapper can be added later.

**Rejected alternatives:**

- **Logseq plugin.** The plugin surface was too limiting for the full app vision.
- **CodeMirror.** A code editor is wrong for a prose outliner; ProseMirror's
  document model is purpose-built for this.
- **Editable HTML.** Breaks both diffs and agent markdown input; last resort only.

## Consequences

**Easier:**

- Markdown is agent-friendly — agents read and write it naturally over SFTP.
- Cold-start re-anchoring works because markdown is a stable text format.
- The door stays open for Yjs + y-prosemirror CRDT collaboration later.

**Harder:**

- Markdown round-trip fidelity through ProseMirror (especially for tables and edge
  cases) is the primary editor risk and must be tested thoroughly.
- The two representations (PM document in memory, markdown on disk) must stay in
  sync; annotation re-anchoring on cold start is a recurring complexity.

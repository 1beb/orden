# ADR-0002: Block-level annotation anchoring with quote fallback

**Date:** 2026-05-28 (superseded 2026-05-31)
**Status:** superseded
**Superseded by:** 2026-05-31-annotation-wadm-model.md

## Context

Orden needs durable, re-resolvable annotations that survive document re-renders and
edits. The anchor must be portable (work across the editor, rendered HTML viewers,
and a future browser extension) and must never silently point at unrelated text.

## Decision (original, 2026-05-28)

**ProseMirror marks as live anchor, block-id + text-quote as durable anchor.**

In the editor, annotations are ProseMirror `annotation` marks carrying an `id`.
ProseMirror maps their position through edits automatically. The durable log stores
the annotation body keyed by id. On cold start, each logged annotation re-finds its
stored quote within the re-parsed markdown via context-disambiguated matching (exact
quote + prefix/suffix context). A quote that no longer matches is surfaced as
orphaned — never re-pointed at unrelated text.

For non-editor hosts (rendered HTML), the anchor is a block id (`data-orden-block-id`)
computed via FNV-1a hash of structural path + text content, combined with a
text-quote selector and character offsets. Resolution finds the block by id and
locates the quote inside it.

**Rejected alternatives:**

- **Coordinate-based anchoring** (like PDFs). Not robust across re-renders; the
  block-based approach survives structural changes.
- **Inline annotation ids in markdown.** Would pollute the canonical format and
  complicate diffs.
- **Whole-document bare-word scan for quote repair.** Produces false matches; the
  design explicitly requires context-disambiguated matching and orphans on ambiguity
  rather than guessing.
- **Persistent position stores.** Require synchronization with the document model;
  a document-order scan recomputed on each update eliminates this.

## Consequences

**Easier:**

- Annotations follow text through edits in the editor with no custom tracking code.
- The markdown files stay clean — no inline annotation metadata.
- Orphaned annotations are explicitly surfaced rather than silently pointing at
  wrong text.
- The quote-based durable format is portable across rendering environments.

**Harder:**

- Cold-start re-anchoring requires a context-disambiguated text matcher with
  prefix/suffix scoring — more complex than a simple find.
- Block-id computation is sensitive to structural changes (inserting a block above
  changes ids); the quote fallback path must handle this.
- A future browser extension needs a separate anchor strategy (text-quote
  selectors against foreign DOM), since it has no ProseMirror document.
- The model was later superseded by the W3C Web Annotation-based model (see
  ADR-0003), which formalized the selector types and added source-keyed storage.

# ADR-0011: Annotation model — W3C Web Annotation Data Model with orden superset

**Date:** 2026-05-31
**Status:** accepted
**Supersedes:** 2026-05-28-annotation-model.md

## Context

The original annotation model (ADR-0002) attached annotations to a specific
document and assumed orden-owned ProseMirror documents. To support external
sources (clipped web pages, images, PDFs) and ensure long-term legibility
without orden's source code surviving, the model needs to be self-describing,
portable, and source-agnostic.

## Decision

**Adopt the W3C Web Annotation Data Model (WADM) as the canonical shape for ALL
annotations, stored as plain JSON with an `orden:` conversational superset.**

- **WADM shape, not strict JSON-LD.** No `@context`, no IRI-keyed properties,
  no graph semantics. Store WADM-shaped plain JSON. JSON-LD ceremony is noise for
  both the user and an LLM reading the file.
- **`source` is mandatory** (discriminated union):
  - `{ kind: "file", vaultPath, contentHash, title? }` — orden-owned docs.
  - `{ kind: "web", url, snapshotPath, contentHash, title? }` — clipped sources.
- **`selector` is a discriminated union** (single or ordered array of fallbacks):
  - `{ type: "text-quote", exact, prefix, suffix, blockId? }`
  - `{ type: "text-position", start, end, blockId? }`
  - `{ type: "region", page?, rect: {x,y,w,h} }` — for images/scanned PDFs.
- **`orden:` conversational superset**: `orden:status` (open/sent/resolved),
  `orden:audience` (agent/human), `orden:thread` (reply array). WADM has no
  concept of threads, lifecycle, or audience; these live under `orden:` keys so
  the base model stays portable.
- **Source-keyed storage**: annotations move OUT of the per-document blob into
  `.orden/annotations/<sourceHash>.json` — one file per source. `sourceHash` is
  an FNV-1a hash of source identity (url or vaultPath), so all notes on one page
  cluster together. `contentHash` (SHA-256) enables drift detection.
- **Snapshots** stored at `.orden/snapshots/<contentHash>.<ext>` — the frozen
  bytes, independent of whether the original URL still exists.

**Rejected alternatives:**

- **Keep the old per-document model.** Would work for orden-owned docs but break
  for external sources whose bytes can't be co-stored and whose text drifts.
- **Full JSON-LD compliance (with @context, IRI keys).** The ceremony adds no
  value for orden's use case and makes the files harder for both humans and LLMs
  to read.
- **Store annotations inline in markdown.** Pollutes the canonical format and
  makes source-keyed clustering impossible.

## Consequences

**Easier:**

- Annotations are self-describing — readable decades from now without orden's
  source code.
- The source-keyed store clusters all annotations on one page together, whether
  that page is a local file or a clipped URL.
- Content integrity hashing lets the renderer flag "anchor may have drifted"
  rather than silently mis-highlighting.

**Harder:**

- The old per-document model must be migrated. Dual-path (old persist.ts path
  for markdown, new source-keyed for everything else) is accepted as transitional
  debt.
- Two `Annotation` types coexist (legacy `Annotation` in annotation-core/types.ts
  and new `OrdenAnnotation` in wadm.ts) until the cutover is complete. Name
  collisions must be managed at the barrel export.
- `contentHash` for binary sources (images, PDFs) requires a wider signature
  than the initial string-only implementation — deferred.

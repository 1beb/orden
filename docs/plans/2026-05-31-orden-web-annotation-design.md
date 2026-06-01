# Orden Web Annotation Design

Date: 2026-05-31
Status: Design (brainstorm complete, not yet planned)

## Goal

Let the user mark up and annotate any page they visit — markdown, HTML, image, or
PDF — and save those annotations into orden in a form a human or an agent can read
clearly. Annotations on external sources must be archived so the knowledge base
stays legible for decades, independent of whether the original source still exists.

orden is a personal knowledge base meant to grow over time. That longevity goal
drives the format and archival decisions below.

## Core insight

The annotation stack has two layers with opposite portability:

- The anchoring engine (`packages/annotation-core`: `blockId.ts`, `anchor.ts`,
  `textOffsets.ts`) is DOM-first. It walks any DOM, hashes blocks, and resolves
  text-quote + position anchors. It already works on arbitrary HTML — it has only
  ever been fed markdown rendered through ProseMirror.
- The rendering/UI layer (`apps/web/src/schema.ts`, `annotations.ts`,
  `annotator-ui.ts`) is ProseMirror-first. Highlights are ProseMirror marks —
  inline spans inside an editable doc orden owns.

A live website, a frozen snapshot, a PDF, and an image are none of them ProseMirror
documents. So any version of this feature requires a second, overlay-based highlight
renderer decoupled from ProseMirror. That cost is unavoidable and is shared by both
the in-app and extension surfaces.

The scorecard:

- Anchoring engine — reusable in both directions, mostly as-is.
- ProseMirror highlight/UI — must be rebuilt as an overlay for non-PM sources.
- The thing that differs between in-app browser vs. extension — who renders the
  third-party page.

## Decisions

1. Both surfaces, phased. The in-app clipper/viewer ships first; the browser
   extension plugs in later. The design is surface-agnostic: both surfaces are mere
   producers of one annotation record; orden's panel and agents are consumers.

2. Adopt the W3C Web Annotation Data Model (WADM) as the canonical shape for ALL
   annotations, not just external ones. Reason: a personal KB read decades from now
   should be self-describing and standard, interpretable without orden's source code
   surviving. This is adopted for the user's own future legibility, not for
   third-party interop.

3. Adopt WADM's model, not strict JSON-LD serialization. No `@context`, no
   IRI-keyed properties, no graph semantics. Store WADM-shaped plain JSON. JSON-LD
   ceremony is noise for both the user and an LLM reading the file.

4. Carry the conversational layer as a strict superset under an `orden:` namespace.
   WADM has no concept of threads, lifecycle status, or audience. The existing
   model's `thread`, `status`, and `audience` (renamed from `target` to avoid
   colliding with WADM's `target = the thing annotated`) live under `orden:` keys.
   Consequence to name honestly: a third-party tool importing these annotations gets
   the highlight and note but NOT the orden thread/status. Acceptable — interop was
   never the reason.

5. The durable artifact is the snapshot of the source, pinned by `contentHash`, not
   the annotation JSON. An annotation pointing at a URL that 404s later is a dangling
   reference regardless of format. Content archival is the half that makes the KB
   permanent.

## A. The annotation record (the contract)

```ts
interface OrdenAnnotation {
  id: string;
  created: string;                                // ISO 8601
  creator: { kind: "human" | "agent"; id: string };

  target: {
    source: Source;                               // MANDATORY — the guardrail
    selector: Selector;                           // discriminated union
  };
  body: { text: string; tags?: string[]; color?: string };

  // orden: conversational superset (namespaced)
  "orden:status": "open" | "sent" | "resolved";
  "orden:audience": "agent" | "human";            // was `target` in the old model
  "orden:thread": AnnotationReply[];
}

type Source =
  | { kind: "file"; vaultPath: string; contentHash: string; title?: string }
  | { kind: "web";  url: string; snapshotPath: string; contentHash: string; title?: string };

type Selector =
  | { type: "text-quote";    exact: string; prefix: string; suffix: string; blockId?: string }
  | { type: "text-position"; start: number; end: number; blockId?: string }
  | { type: "region";        page?: number; rect: { x: number; y: number; w: number; h: number } };
  // region: image / scanned-PDF; rect normalized 0–1 for resolution independence

interface AnnotationReply {
  author: "user" | "agent";
  body: string;
  createdAt: string;
}
```

Design guardrails:

- `source` is mandatory. For orden-owned docs it is `{ kind: "file", vaultPath, contentHash }`.
  Mandatory-source + a discriminated-union selector is what stops the type from rotting
  into a pile of optional fields — the one real risk of extending rather than rewriting.
- `blockId` is an optional hint ON the selector, not a required sibling of it.
- `contentHash` tells the renderer whether the source changed since annotation time,
  so it can flag "anchor may have drifted" instead of silently mis-highlighting.

## Mapping from the current model

The existing `packages/annotation-core/src/types.ts` `Annotation` maps cleanly:

| New | Today | Action |
|---|---|---|
| `selector` text-quote / text-position | `anchor.quote` / `anchor.position` | collapse into union variants |
| `body`, `id`, `created`, `orden:status`, `orden:thread` | `body`, `id`, `createdAt`, `status`, `thread` | keep |
| `orden:audience` | `target: "agent" \| "human"` | rename (frees `target` for WADM) |
| `target.source` (url/vaultPath + contentHash) | — | new |
| `region` selector | — | new (image / scanned PDF) |

The migration is mechanical: existing anchors already are WADM-flavored.

## B. Storage layout

Annotations move OUT of the per-document blob and become source-keyed, so external
sources and orden docs share one model.

- Canonical: `.orden/annotations/<sourceHash>.json` →
  `{ source, annotations: OrdenAnnotation[] }`. One file per source; `sourceHash`
  is a hash of source identity (vaultPath or url), so all notes on one page cluster.
- Snapshots: `.orden/snapshots/<contentHash>.<ext>` — the frozen bytes (single-file
  HTML capture, copied PDF, image). `source.snapshotPath` points here. Annotations
  target the frozen copy; the live URL is provenance only.
- Migration: existing `vault docs/<docKey>` blobs split — the markdown stays where it
  is (orden owns it); `records[]` lift into `.orden/annotations/` with
  `source.kind: "file"`. One-time script.

This supersedes today's `apps/web/src/persist.ts` model, which co-stores markdown +
annotations in one `docKey`-keyed blob. That works only because orden owns the text;
it breaks for external sources whose bytes can't be co-stored and whose text drifts.

The earlier idea of a separately-generated "derived markdown view" is dropped as a
general requirement: orden already co-stores markdown for its own docs, so that idea
only earns its keep for external sources, if at all.

## C. The overlay renderer

ProseMirror marks stay for orden-owned editable markdown. Non-PM sources get an
overlay highlighter:

- Text sources (HTML snapshot, PDF text, markdown viewed non-editable): the browser
  CSS Custom Highlight API paints `Range`s without mutating the DOM — essential for a
  frozen snapshot that must not be corrupted.
- `region` selectors: absolutely-positioned boxes over the image / PDF canvas.

The anchoring engine (`anchor.ts`, `textOffsets.ts`) is shared by both renderers;
only the paint differs.

## D. Phasing

1. Foundation — extend types, source-keyed storage, migration script. No UI change;
   the existing app keeps working.
2. In-app viewers + overlay — html / pdf / image viewers in the main panel, the
   overlay highlighter, region anchors. Annotate orden-held files.
3. Web clipper — Playwright single-file snapshot on "clip URL"; annotate the frozen
   page in-app.
4. Browser extension — Chrome / Firefox companion; annotate live pages in the user's
   own browsing flow; POST `OrdenAnnotation` records to the host. Reuses everything
   from phases 1–3.

## Open questions / deferred

- Re-anchoring policy when `contentHash` mismatches (best-effort quote re-resolve vs.
  mark as drifted): defer to implementation.
- Whether the extension needs its own lightweight anchoring build or can import
  `annotation-core` directly: defer to phase 4.
- Snapshot tooling choice (Playwright single-file vs. SingleFile lib): defer to
  phase 3.

# Browser clipper extension — design

Status: design (brainstormed 2026-06-08). Implementation not started.

## What this is

A browser extension (`extensions/clipper`) that lets you annotate generic external
webpages — the ones orden's main panel cannot render same-origin and therefore cannot
annotate directly (see [HTML annotation trust model](../../README) and the
`html-annotation-trust-model` memory). You enter an annotation mode on any page,
highlight text and attach notes, and the result is captured back into orden's vault as
a first-class artifact.

The mockup of the annotation-mode UI lives at `extensions/clipper/mockup/overlay.html`.

## Motivating use: second brain first, agent input second

orden is a note-taking / second-brain tool as much as an agent operator. A clipping
session therefore has two lives:

1. Think-in-place (primary). You are researching — reading docs, specs, articles — and
   want to capture passages and your own margin notes. This is personal knowledge work;
   no agent is involved.
2. Task input (optional, downstream). Some captures become context for an agent: "build
   this the way X describes, here are my notes." Routing to a session is a deliberate
   later action, not the default.

This drives the whole data model: a capture is stored as orden content (a page + a
journal entry), and agent delivery is an optional projection of it.

## Outcome of a clipping session

One clipping session produces three linked things in the vault:

- A page (vault ns `pages`) holding the captured snapshot and assets — its own page,
  separate from your other notes. This is the durable artifact.
- A journal entry (the daily outliner) recording the session: a block titled with the
  page title and source URL, linking to the page. This is how captures surface in your
  day without a separate "inbox" surface.
- Annotations anchored to the page, stored through the existing annotation model, each
  targeting either the agent or yourself.

Optionally, the journal block / page is linked to a project, and from there optionally
spawned into an agent session with the snapshot + agent-targeted annotations as input.

## Capture payload

Each capture stores, for an HTML page:

- A Readability extraction of the main content, rendered to the page as markdown/HTML
  with block-ids assigned at extraction time (see Anchoring).
- Per-highlight assets: the exact quoted text, surrounding context text from the
  Readability output, and a viewport screenshot cropped to the highlight region.
- Source metadata: URL, title, captured-at timestamp.

PDFs are deferred to v2 (see Constraints).

## Anchoring on arbitrary DOM

This is the crux: orden anchors annotations to block-ids assigned at render time
(`packages/annotation-core/src/anchor.ts`, `createAnchor`/`resolveAnchor`). External
pages have no such block-ids. The resolution: Readability extraction is itself a render,
so we assign block-ids during extraction and external pages join the existing model
rather than fighting it. The `Anchor` type is reused unchanged:
`{ blockId, quote: { exact, prefix, suffix }, position }`.

Two layers, both computed in the content script at highlight time:

- Live-page locator (capture-time only). From `window.getSelection()` we compute a
  W3C-style `TextQuoteSelector` (`exact` + ~32 chars `prefix`/`suffix`). This is used
  once, to locate the selection inside the freshly extracted Readability output. It is
  robust to whitespace/markup differences between the live DOM and the cleaned article.
- Durable block-id (the stored anchor). Readability output has stable block-ids per
  block; we record which block the highlight landed in. The persisted `Anchor` is
  identical in shape to an agent-doc annotation, so any agent already understands it.

Because the durable artifact is the frozen snapshot, highlights never break on source
edits, A/B variants, or revisits.

Fallback: if a selection survives extraction poorly (spans stripped chrome), we keep the
raw quote + screenshot with `blockId: "unanchored"` so nothing is lost. This mirrors
orden's existing orphaned-annotation handling.

## Transport and auth

The extension is not an agent, so it does not speak MCP's per-conversation, session-id
handshake (fragile from an ephemeral service worker anyway). Instead the host gains one
thin route:

- `POST /capture` on the existing server (`apps/host/src/serve.ts`). It accepts a single
  capture bundle and writes the page + assets + annotations + journal entry, reusing the
  same host logic the MCP bus already exposes (`vault.set`, page write, session_create,
  annotation delivery). "The existing bus" is honored at the logic layer.
- `GET /projects` (or reuse the existing project listing) so the optional project picker
  can populate.
- Assets (screenshots) are served back over the existing raw-bytes route for orden and
  agents to fetch.

Auth (v1): loopback trust, no token. The extension only talks to `127.0.0.1:4319`. To
keep that safe against a malicious page you are visiting firing blind cross-origin POSTs,
the route requires a custom header (`x-orden-clipper: 1`) and sends no CORS
allow-origin. That forces a preflight the host rejects for page-origin requests; only
the extension — exempt from page CORS via `host_permissions` — can call it.

Accepted tradeoff: no remote tailnet host in v1 (the host can bind the tailnet IP, but
loopback trust cannot authenticate a cross-machine caller). A pasted pairing token is
the v2 upgrade path if remote capture is wanted.

## Extension internals (Manifest V3)

MV3 constraints drive the component split: the service worker is ephemeral (killed when
idle) and has no DOM; broad `content_scripts` would run on every page.

- Service worker (`sw.ts`) — coordinator, holds no durable state in memory. On the
  action click / shortcut it injects the content script via `chrome.scripting.executeScript`
  under `activeTab` (the extension is inert until invoked). Runs Readability, owns the
  screenshot pipeline, assembles and POSTs the bundle. In-progress captures persist to
  `chrome.storage.local` keyed by URL, so an SW restart mid-capture resumes.
- Content script (`highlighter.ts`) — injected on demand; owns all in-page UI inside a
  Shadow DOM root so host-page CSS cannot bleed in. Computes `TextQuoteSelector` and the
  highlight `DOMRect`; never talks to the host directly (no host permissions).
- Offscreen document (`offscreen.html`) — the SW cannot use a canvas, so per-highlight
  cropping runs here: content script scrolls the rect into view, SW calls
  `chrome.tabs.captureVisibleTab` (full viewport PNG), offscreen canvas crops to the
  highlight region and returns WebP. Sequential, because captureVisibleTab grabs the
  current viewport.
- Options page — host URL (default `http://127.0.0.1:4319`) and a connection test.

Permissions: `activeTab`, `scripting`, `storage`, `offscreen`, `commands` (keyboard
shortcut), `host_permissions: ["http://127.0.0.1:4319/*"]`. No `tabs`, no broad host
match.

## Annotation-mode UX

Matches orden's main panel deliberately (styling and behavior copied from
`apps/web/src/styles.css`); the mockup demonstrates it.

- Entering: extension action or a keyboard shortcut toggles annotation mode on the active
  tab. A slim mode bar signals the page is armed; Exit (or the shortcut / Esc) leaves.
- Highlights: orden's marks — a 2px accent underline at rest, soft fill on hover/active.
  Agent-target highlights use `--accent`; personal (for-me) highlights use `--human`.
  Colors inherit the user's Settings accent (same `--accent` variable).
- Selecting: releasing a selection shows orden's `.annotator` pill at the selection;
  clicking it expands to the composer with the To agent / For me target toggle, a note
  field, and the per-highlight screenshot indicator.
- Annotations rail: a faithful copy of `#panel` / `#annotation-list` — bordered cards
  with a left accent stripe, italic single-line quote, note text, a target chip, and a
  hover-revealed Delete. Clicking a card scrolls its highlight into view and pulses it;
  hover syncs active state both ways.
- Submitting: the rail header has Submit (accent) + Copy. Submit optionally routes to a
  project (dropdown) with session instructions, or saves to the journal/pages only.

## Host changes

- New `POST /capture` route (and asset GET) wired in `serve.ts`, reusing existing vault /
  page / session / annotation logic.
- Capture handler: write the snapshot page, store assets, create annotations anchored to
  the page, append a journal entry linking the page, optionally link a project and
  optionally spawn a session (existing `session_create` + initial-prompt path) carrying
  the snapshot + agent-targeted annotations.
- Personal (for-me) annotations are stored on the page but never delivered to an agent.

## Firefox port

Ship Chrome first. Firefox uses the same MV3 codebase with two known deltas: background
is an event page (Firefox MV3 still allows non-SW background in places) and
`browser.*` promises vs `chrome.*` — abstract behind a thin `browserApi` shim. The
offscreen-document API differs; Firefox can crop in the background page directly. Keep
the capture bundle + route identical so the host is browser-agnostic.

## Testing

- Pure units: anchoring (live locator -> Readability block-id, including the unanchored
  fallback), capture-bundle assembly, the `/capture` handler against a faked vault
  (page + annotations + journal written), and the CORS/header guard.
- The screenshot/offscreen pipeline and content-script DOM are integration-tested in a
  headless browser separately; keep host-side logic pure and faked like
  `annotationDelivery` already is.

## Constraints and deferred work

- PDFs (v2). Chrome's native PDF viewer is a sandboxed plugin; content scripts cannot
  read its text selection or text layer, so PDF highlights cannot be text-anchored. v1
  shows "PDFs not yet supported." v2 options: store the PDF bytes with page-level notes,
  or bundle a PDF.js viewer for a real text layer.
- Remote tailnet host (v2). Requires the pairing-token auth upgrade.
- Region/figure clipping and full-page screenshots were considered and dropped (YAGNI);
  per-highlight context shots cover the research need.

## Milestones

1. Package scaffold + `/capture` route + capture bundle schema, host-side unit tested.
2. Content-script overlay (Shadow DOM) with orden-styled marks, rail, and composer.
3. Readability extraction + block-id anchoring + the unanchored fallback.
4. Screenshot pipeline (SW + offscreen crop).
5. Host capture handler: page + annotations + journal entry; optional project link and
   session spawn.
6. Options page, keyboard shortcut, end-to-end verify against a running host.
7. Firefox port behind the `browserApi` shim.

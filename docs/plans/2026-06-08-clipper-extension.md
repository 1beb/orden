# Browser Clipper Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a Chrome-first (Firefox-second) MV3 extension that lets the user enter an annotation mode on any external webpage, highlight + note passages with per-highlight screenshots, and POST the result to the local host, where it becomes an orden web-annotation snapshot plus a Journal entry, optionally linked to a project/session.

**Architecture:** The extension is Phase 4 of the web-annotation design (`docs/plans/2026-05-31-orden-web-annotation-design.md`). It produces orden's existing `OrdenAnnotation` records (`packages/annotation-core/src/wadm.ts`) with `source = {kind:"web", url, snapshotPath, contentHash}`, reusing the DOM-first anchoring engine (`annotation-core`) directly in the content script. The host gains the snapshot-storage + web-annotation write path (shared Phase-3/4 infra that does not exist yet) plus a single `POST /capture` route. New on top of phases 1-3: Readability snapshot, per-highlight screenshots, journal/project/session linking.

**Tech Stack:** TypeScript, pnpm workspace, vitest + happy-dom (host/core tests), esbuild (extension bundle), MV3 (service worker + content script + offscreen document), `@mozilla/readability`, the browser CSS Custom Highlight API, Node `node:crypto`/`node:fs` on the host.

**Reading order before starting:** `packages/annotation-core/src/wadm.ts` (the record), `anchor.ts` + `blockId.ts` + `textOffsets.ts` (the engine), `apps/web/src/annotationStore.ts` (storage shape + `sourceHash`), `apps/host/src/serve.ts` (`makeServer` routing, `ORDEN_BIND`), `apps/host/src/hooks.ts` (route handler pattern), and the design doc `2026-06-08-clipper-extension-design.md`.

**Conventions:** TDD for all host + pure-core tasks (vitest). The extension runtime (service worker, content script, offscreen, options) cannot be unit-tested by vitest — it needs a real browser — so those tasks specify implementation + a concrete manual verification instead, and are committed when the verification passes. DRY, YAGNI, frequent commits. Run from the worktree `.claude/worktrees/clipper-extension`. Never `git add .` — stage named files. New deps are subject to the 30-day cooldown (`minimumReleaseAge`); if `@mozilla/readability` fails to resolve, see Task 14's note.

---

## Phase 1 — Host: snapshot storage + web-annotation write path (Phase-3/4 infra)

This phase builds the host side first, fully test-driven, so the extension has a real endpoint to hit. None of it requires a browser.

### Task 1: `contentHash` helper

**Files:**
- Create: `apps/host/src/clipper/contentHash.ts`
- Test: `apps/host/test/clipper/contentHash.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { contentHash } from "../../src/clipper/contentHash";

describe("contentHash", () => {
  it("is stable and hex, 64 chars (sha256)", () => {
    const h = contentHash("<p>hello</p>");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("<p>hello</p>")).toBe(h);
  });
  it("differs for different bytes", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
```

**Step 2: Run it, expect FAIL** (`Cannot find module`).

Run: `pnpm --filter @orden/host exec vitest run test/clipper/contentHash.test.ts`

**Step 3: Implement**

```ts
import { createHash } from "node:crypto";

/** Stable sha256 hex of a snapshot's bytes — pins the durable artifact. */
export function contentHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
```

**Step 4: Run it, expect PASS.**

**Step 5: Commit**

```bash
git add apps/host/src/clipper/contentHash.ts apps/host/test/clipper/contentHash.test.ts
git commit -m "host(clipper): contentHash helper"
```

### Task 2: `SnapshotStore` — write/read frozen snapshot bytes

The snapshot lives at `<vaultRoot>/snapshots/<contentHash>.<ext>` per the web-annotation design ("B. Storage layout"). The host already has a vault root; reuse it. Model the store behind a tiny interface so it's faked in tests.

**Files:**
- Create: `apps/host/src/clipper/snapshotStore.ts`
- Test: `apps/host/test/clipper/snapshotStore.test.ts`

**Step 1: Write the failing test** (use a tmp dir, real fs — the store is thin I/O)

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSnapshotStore } from "../../src/clipper/snapshotStore";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orden-snap-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("DiskSnapshotStore", () => {
  it("writes bytes under snapshots/<hash>.<ext> and returns a vault-relative path", async () => {
    const store = new DiskSnapshotStore(root);
    const path = await store.put("deadbeef", "html", "<p>hi</p>");
    expect(path).toBe("snapshots/deadbeef.html");
    expect(existsSync(join(root, path))).toBe(true);
    expect(await store.get(path)).toBe("<p>hi</p>");
  });
  it("is idempotent for the same hash (no duplicate write churn)", async () => {
    const store = new DiskSnapshotStore(root);
    const a = await store.put("h1", "html", "<p>x</p>");
    const b = await store.put("h1", "html", "<p>x</p>");
    expect(a).toBe(b);
  });
});
```

**Step 2: Run it, expect FAIL.**

**Step 3: Implement**

```ts
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SnapshotStore {
  /** Store bytes for a contentHash; returns the vault-relative snapshotPath. */
  put(hash: string, ext: string, bytes: string): Promise<string>;
  get(snapshotPath: string): Promise<string | null>;
}

export class DiskSnapshotStore implements SnapshotStore {
  constructor(private readonly vaultRoot: string) {}
  async put(hash: string, ext: string, bytes: string): Promise<string> {
    const rel = `snapshots/${hash}.${ext}`;
    const abs = join(this.vaultRoot, rel);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
    return rel;
  }
  async get(snapshotPath: string): Promise<string | null> {
    const abs = join(this.vaultRoot, snapshotPath);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }
}
```

**Step 4: Run it, expect PASS.**

**Step 5: Commit**

```bash
git add apps/host/src/clipper/snapshotStore.ts apps/host/test/clipper/snapshotStore.test.ts
git commit -m "host(clipper): DiskSnapshotStore for frozen snapshot bytes"
```

### Task 3: `buildWebAnnotations` — pure: snapshot HTML + raw highlights → OrdenAnnotation[]

This is the heart of the host side and it is pure (happy-dom), so TDD it hard. Input: the snapshot HTML (already block-id-stamped — see Task 4 for who stamps), the `Source`, and the raw highlights from the extension (`{ exact, prefix, suffix, blockId, note, audience, shot? }`). Output: WADM `OrdenAnnotation[]`. Reuse `annotation-core`'s selector shape; do not re-derive anchoring math — the extension already computed the quote selector against the live DOM, and Task 4 re-validates the blockId against the stored snapshot. Here we just assemble records.

**Files:**
- Create: `apps/host/src/clipper/buildWebAnnotations.ts`
- Test: `apps/host/test/clipper/buildWebAnnotations.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildWebAnnotations, type RawHighlight } from "../../src/clipper/buildWebAnnotations";
import type { Source } from "@orden/annotation-core";

const source: Source = { kind: "web", url: "https://x.test/a", snapshotPath: "snapshots/h.html", contentHash: "h", title: "A" };

function raw(over: Partial<RawHighlight> = {}): RawHighlight {
  return { exact: "the server mints", prefix: "...", suffix: "...", blockId: "b1", note: "n", audience: "agent", ...over };
}

describe("buildWebAnnotations", () => {
  it("produces a WADM OrdenAnnotation per highlight, with a text-quote selector carrying blockId", () => {
    const [a] = buildWebAnnotations(source, [raw()], () => "id-1", () => "2026-06-08T00:00:00Z");
    expect(a.target.source).toEqual(source);
    expect(a.target.selector).toMatchObject({ type: "text-quote", exact: "the server mints", blockId: "b1" });
    expect(a.body.text).toBe("n");
    expect(a["orden:audience"]).toBe("agent");
    expect(a["orden:status"]).toBe("open");
    expect(a.creator.kind).toBe("human");
  });
  it("carries a per-highlight screenshot path under an orden: field when present", () => {
    const [a] = buildWebAnnotations(source, [raw({ shot: "snapshots/h-0.webp" })], () => "id", () => "t");
    expect(a["orden:shot"]).toBe("snapshots/h-0.webp");
  });
  it("maps a for-me highlight to human audience", () => {
    const [a] = buildWebAnnotations(source, [raw({ audience: "human" })], () => "id", () => "t");
    expect(a["orden:audience"]).toBe("human");
  });
});
```

**Step 2: Run it, expect FAIL.**

**Step 3: Implement** (depends on Task 7's `orden:shot` field; if doing strict order, do Task 7 first — noted there. The `OrdenAnnotation` import resolves once Task 7 widens the type.)

```ts
import type { OrdenAnnotation, Source } from "@orden/annotation-core";

export interface RawHighlight {
  exact: string;
  prefix: string;
  suffix: string;
  blockId: string;
  note: string;
  audience: "agent" | "human";
  shot?: string; // vault-relative screenshot path
}

/** Assemble WADM records from raw extension highlights. Pure; ids/timestamps injected. */
export function buildWebAnnotations(
  source: Source,
  highlights: RawHighlight[],
  mintId: () => string,
  now: () => string,
): OrdenAnnotation[] {
  return highlights.map((h) => ({
    id: mintId(),
    created: now(),
    creator: { kind: "human", id: "user" },
    target: {
      source,
      selector: { type: "text-quote", exact: h.exact, prefix: h.prefix, suffix: h.suffix, blockId: h.blockId },
    },
    body: { text: h.note },
    "orden:status": "open",
    "orden:audience": h.audience,
    "orden:thread": [],
    ...(h.shot ? { "orden:shot": h.shot } : {}),
  }));
}
```

**Step 4: Run it, expect PASS.**

**Step 5: Commit**

```bash
git add apps/host/src/clipper/buildWebAnnotations.ts apps/host/test/clipper/buildWebAnnotations.test.ts
git commit -m "host(clipper): buildWebAnnotations assembles WADM records"
```

### Task 7 (do before Task 3's impl): widen `OrdenAnnotation` with optional `orden:shot`

**Files:**
- Modify: `packages/annotation-core/src/wadm.ts` (the `OrdenAnnotation` interface)
- Test: `packages/annotation-core/test/wadm.shot.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expectTypeOf } from "vitest";
import type { OrdenAnnotation } from "../src/wadm";

describe("OrdenAnnotation orden:shot", () => {
  it("accepts an optional screenshot asset path", () => {
    expectTypeOf<OrdenAnnotation["orden:shot"]>().toEqualTypeOf<string | undefined>();
  });
});
```

**Step 2: Run it, expect FAIL** (property does not exist).

Run: `pnpm --filter @orden/annotation-core exec vitest run test/wadm.shot.test.ts`

**Step 3: Implement** — add one line to the interface:

```ts
  "orden:thread": AnnotationReply[];
  /** Optional per-highlight context screenshot (vault-relative path). Clipper-only. */
  "orden:shot"?: string;
```

**Step 4: Run it, expect PASS;** then `pnpm --filter @orden/annotation-core test` (no regressions).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/wadm.ts packages/annotation-core/test/wadm.shot.test.ts
git commit -m "annotation-core: optional orden:shot for per-highlight screenshots"
```

### Task 4: `applyCapture` — the orchestrator (snapshot + annotations + journal + optional routing)

Pure-ish: takes a `Host`, a `SnapshotStore`, the decoded capture bundle, and injected id/clock; performs all vault writes. TDD against a faked `VaultStore` + in-memory `SnapshotStore`, exactly like `annotationDelivery.test.ts` fakes `PaneOps`.

**Bundle shape (the wire contract)**

```ts
export interface CaptureBundle {
  url: string;
  title: string;
  snapshotHtml: string;             // Readability output, block-ids already stamped by the extension
  ext: "html";
  highlights: Array<{
    exact: string; prefix: string; suffix: string; blockId: string;
    note: string; audience: "agent" | "human";
    shotBase64?: string;            // cropped WebP, sans data: prefix
  }>;
  routing: { projectId?: string; instructions?: string };  // empty projectId => inbox/journal only
}
```

**Behavior (assert each in tests):**
1. Compute `contentHash(snapshotHtml)`, `store.put(hash, "html", snapshotHtml)` → `snapshotPath`.
2. Build `source = {kind:"web", url, snapshotPath, contentHash, title}`.
3. For each highlight with `shotBase64`, `store.put(\`${hash}-${i}\`, "webp", decoded)` → its `shot` path.
4. `buildWebAnnotations(source, rawHighlights)` → records; write `vault.set("annotations", sourceHash(source), { source, annotations })`.
5. Append a Journal entry: read today's journal page (ns `pages`, key = `journalKey(now, tz)`), append an outline block linking the snapshot + the source title/url and the highlight count; write it back. (Use the host's existing journal/page write convention — confirm the on-disk page format by reading `apps/web/src/outlineEditor.ts` / `@orden/outliner` `journalKey`. If the format is non-trivial, the minimal correct append is a new top-level bullet line; keep it dumb.)
6. If `routing.projectId`: write a project link onto the journal block / or call the existing `sessionCreate` tool path with the snapshot + agent-audience notes as the initial prompt when `instructions` is present. Reuse `packages/mcp` `sessionCreate` rather than re-implementing.
7. Return `{ snapshotPath, contentHash, annotationCount, journalKey, sessionId? }`.

**Files:**
- Create: `apps/host/src/clipper/applyCapture.ts`
- Test: `apps/host/test/clipper/applyCapture.test.ts`

**Step 1: Write failing tests** — at minimum:
- writes a snapshot and an `annotations/<sourceHash>` bundle with N records;
- agent vs human audience preserved;
- appends exactly one journal block to today's page (assert the page text grew and references the URL);
- `projectId` empty ⇒ no session created; `projectId` + `instructions` ⇒ `sessions` ns gains one record (fake the sessionCreate dependency).

Use a `FakeVault` implementing `VaultStore` (Map-backed) and an in-memory `SnapshotStore`. Inject `mintId`, `now`, and `tz`.

**Step 2: Run, expect FAIL.**

**Step 3: Implement** per Behavior above. Keep all side effects through injected `host.vault` + `store`; no direct fs.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add apps/host/src/clipper/applyCapture.ts apps/host/test/clipper/applyCapture.test.ts
git commit -m "host(clipper): applyCapture writes snapshot + annotations + journal + optional session"
```

### Task 5: `POST /capture` route + CSRF/header guard, wired into `serve.ts`

The guard is the security model (design: loopback trust + a custom header that forces a preflight the host rejects for page origins). Make the guard a pure function first.

**Files:**
- Create: `apps/host/src/clipper/captureRoute.ts` (guard + `handleCaptureRequest`)
- Modify: `apps/host/src/serve.ts` (`makeServer` dispatch: route `POST /capture` and `OPTIONS /capture`)
- Test: `apps/host/test/clipper/captureRoute.test.ts`

**Step 1: Write failing tests**
- `isClipperRequest({method, headers})` is true only for `POST` with `x-orden-clipper: 1`; false without the header (the CSRF guard).
- `OPTIONS /capture` returns 403 / no `access-control-allow-origin` (so a page preflight fails).
- `handleCaptureRequest` parses a JSON `CaptureBundle`, calls an injected `applyCapture`, and replies `200 {snapshotPath, annotationCount}`; a malformed body ⇒ `400`.

Drive `handleCaptureRequest` with fake `IncomingMessage`/`ServerResponse` shims (the repo already does this for hooks/mcp — mirror `apps/host/test/hooks.test.ts`).

**Step 2: Run, expect FAIL.**

**Step 3: Implement.** Guard:

```ts
export function isClipperRequest(req: { method?: string; headers: Record<string, string | string[] | undefined> }): boolean {
  return req.method === "POST" && req.headers["x-orden-clipper"] === "1";
}
```

`handleCaptureRequest(host, store, req, res, deps)` reads the JSON body (reuse the `readBody` pattern from `hooks.ts`), validates required fields, calls `applyCapture`, and writes the JSON result. Respond to `OPTIONS` with `403` and NO CORS allow headers. Then in `serve.ts` `makeServer`, before the static fallback, add:

```ts
if (url.pathname === "/capture") {
  if (req.method === "OPTIONS") { res.writeHead(403).end(); return; }
  if (isClipperRequest(req)) { await handleCaptureRequest(host, snapshotStore, req, res); return; }
  res.writeHead(403).end(); return;
}
```

Construct the `snapshotStore` once in `serve.ts` from the resolved vault root (the same root `DiskVault` uses — read how `serve.ts` builds the vault path).

**Step 4: Run, expect PASS;** then `pnpm --filter @orden/host test` (no regressions).

**Step 5: Commit**

```bash
git add apps/host/src/clipper/captureRoute.ts apps/host/src/serve.ts apps/host/test/clipper/captureRoute.test.ts
git commit -m "host(clipper): POST /capture route with loopback CSRF header guard"
```

### Task 6: snapshot + screenshot serving for the main panel

The in-app web viewer must be able to load `source.snapshotPath` and `orden:shot` bytes same-origin to render + paint. Check whether `/repo-file/` or an existing vault-file route already serves vault-relative paths; if it serves the snapshots dir, this task is just a test asserting it. If not, add a minimal `GET /snapshot/<path>` (and reuse for shots) that reads via `SnapshotStore.get` and sets the right content-type.

**Files:**
- Modify: `apps/host/src/serve.ts` (only if no existing route covers it)
- Test: `apps/host/test/clipper/snapshotServe.test.ts`

TDD: a stored snapshot path returns `200 text/html` with the bytes; a `.webp` returns `image/webp`; path traversal (`../`) is rejected `400`. Commit `host(clipper): serve snapshot + screenshot bytes`.

---

## Phase 2 — Shared anchoring usable in the extension

### Task 8: verify `annotation-core` bundles into a browser content script

The content script needs `createAnchor`/`resolveAnchor`/`blockId` from `annotation-core`. The deferred question (own build vs import) resolves to "import directly" — but verify it has zero Node-only imports so esbuild can bundle it for the browser.

**Files:**
- Test: `packages/annotation-core/test/browser-safe.test.ts`

**Step 1: Write a test** that imports every public entry of `annotation-core` and asserts no `node:` specifier appears in the built output. Practically: add a tiny esbuild step in the test (or a script `scripts/check-browser-safe.mjs`) that bundles `annotation-core` with `platform: "browser"` and fails on an unresolved `node:*`. If it already bundles clean, the test passes immediately and documents the guarantee.

**Step 2-4:** Run; if it fails because some file imports `node:crypto` (e.g. a hashing util), extract the browser-safe subset the content script needs into a named export and re-test.

**Step 5: Commit** `annotation-core: assert browser-bundle safety for the content script`.

---

## Phase 3 — Extension scaffold (MV3)

> Browser-runtime tasks: no vitest. Each ends with a concrete manual verification done by loading the unpacked extension in Chrome.

### Task 9: package scaffold + manifest + build

**Files (create):**
- `extensions/clipper/package.json` (name `@orden/clipper`, private, scripts `build`/`watch` via esbuild; devDeps esbuild, typescript)
- `extensions/clipper/manifest.json` (MV3)
- `extensions/clipper/src/sw.ts` (empty service worker that logs on install)
- `extensions/clipper/src/content.ts` (logs "clipper armed")
- `extensions/clipper/src/offscreen.html` + `offscreen.ts` (stub)
- `extensions/clipper/src/options.html` + `options.ts` (host URL field, default `http://127.0.0.1:4319`)
- `extensions/clipper/build.mjs` (esbuild: bundle sw/content/offscreen/options to `dist/`, copy manifest + html, `platform:"browser"`)
- `extensions/clipper/tsconfig.json`

**manifest.json essentials:**

```json
{
  "manifest_version": 3,
  "name": "orden clipper",
  "version": "0.1.0",
  "background": { "service_worker": "sw.js", "type": "module" },
  "action": { "default_title": "Annotate for orden" },
  "options_page": "options.html",
  "permissions": ["activeTab", "scripting", "storage", "offscreen"],
  "host_permissions": ["http://127.0.0.1:4319/*"],
  "commands": {
    "toggle-annotation-mode": {
      "suggested_key": { "default": "Ctrl+Shift+E", "mac": "Command+Shift+E" },
      "description": "Toggle orden annotation mode"
    }
  }
}
```

Add `extensions/clipper/dist` and `extensions/clipper/node_modules` to `.gitignore`. Wire the package into the pnpm workspace (`pnpm-workspace.yaml` `packages:` already globs — confirm `extensions/*` is included; if not, add it).

**Manual verification:** `pnpm --filter @orden/clipper build`; in Chrome `chrome://extensions` → Developer mode → Load unpacked → `extensions/clipper/dist`. Confirm the extension loads with no manifest errors and the SW logs on install (service worker console).

**Commit** `clipper: MV3 scaffold (manifest, sw/content/offscreen/options, esbuild build)`.

### Task 10: arm/disarm annotation mode (action + shortcut → inject content script)

**Files:** modify `sw.ts`, `content.ts`.

`sw.ts`: on `chrome.action.onClicked` and `chrome.commands.onCommand("toggle-annotation-mode")`, `chrome.scripting.executeScript({ target:{tabId}, files:["content.js"] })` (guard against double-inject by messaging the content script to toggle if already present). `content.ts`: on inject, mount a minimal fixed banner ("Annotation mode — Exit") in a Shadow DOM root; Exit/Esc/second-toggle removes it.

**Manual verification:** press Ctrl+Shift+E on any page → banner appears; again → gone. Works via the toolbar button too.

**Commit** `clipper: arm/disarm annotation mode via action + shortcut`.

---

## Phase 4 — Content-script overlay (the real UI)

Port `extensions/clipper/mockup/overlay.html` into `content.ts`, but back highlights with the CSS Custom Highlight API (design decision C: never mutate the frozen/live DOM) and anchor with `annotation-core`. Reuse the mockup's orden-styled CSS verbatim inside the Shadow root.

### Task 11: selection → anchor → in-memory highlight + rail card

Modify `content.ts`. On `mouseup` with a non-empty selection inside the page (not the overlay): build a quote selector via `annotation-core` `createAnchor` against the live block (stamp block-ids on the live DOM first with `annotation-core` `blockId` if needed, or compute prefix/suffix directly). Show the orden `.annotator` pill → composer (To agent / For me + note). Save pushes a highlight `{exact,prefix,suffix,blockId,note,audience,rect}` into an in-memory array, paints it with `CSS.highlights`, and appends a rail card (orden `#annotation-list` markup). Clicking a card scrolls to the range and pulses it; hover syncs both ways. This mirrors `apps/web/src/main.ts` `openAnnotatableText`'s onSelect/onDelete contract — read it and follow the same shape.

**Manual verification:** select text → composer → Save → underline appears, rail card appears; click card → scrolls; delete works; For-me vs To-agent show accent vs human color.

**Commit** `clipper: overlay highlighting + rail backed by CSS Highlight API + annotation-core`.

### Task 12: Submit panel (project routing) + Exit semantics + per-URL persistence

Modify `content.ts` + `sw.ts`. Rail header gets Submit ▾ (opens a project picker fetched from the host — Task 13) + Copy. Exit keeps highlights in `chrome.storage.local` keyed by URL; re-arming the same URL restores them. Submit hands the highlight array to the SW.

**Manual verification:** make highlights, Exit, re-arm same page → highlights restored; reload extension → still restored (storage, not memory).

**Commit** `clipper: submit panel, exit-keeps-state, per-URL persistence`.

### Task 13: project list fetch (host `GET /projects` or reuse)

Check whether an HTTP project list exists; if not, add a tiny `GET /projects` to `serve.ts` (behind the same `x-orden-clipper` guard) returning `[{id,name}]` from `vault.list("projects")`. TDD that route on the host (it's testable). The SW fetches it and forwards to the content script for the picker.

**Commit** `clipper: project list for the submit picker (host GET /projects, guarded)`.

---

## Phase 5 — Service-worker capture pipeline

### Task 14: Readability snapshot + block-id stamping in the SW

Add `@mozilla/readability` as a dep of `@orden/clipper`. On Submit, the content script (which has the live `document`) runs Readability on a clone, producing article HTML; stamp block-ids with `annotation-core` `blockId` so the stored snapshot's ids match the highlights' `blockId`. (Do the extraction in the content script, not the SW — the SW has no DOM. The SW only assembles + POSTs.) Re-resolve each highlight's quote against the extracted article to finalize `blockId`; if it does not resolve, set `blockId: "unanchored"` (the design's fallback) and keep the raw quote + screenshot.

**Cooldown note:** if `@mozilla/readability`'s latest version is <30 days old, `pnpm add` fails by design. Pin an older version that resolves, or vendor the single `Readability.js` file under `extensions/clipper/vendor/` with a provenance comment.

**Manual verification:** Submit on a long article → inspect the POSTed bundle (Network tab on the SW, or a temporary `console.log`) → `snapshotHtml` is the cleaned article with `data-block-id` attrs; highlight `blockId`s appear in it; a highlight over stripped chrome is `unanchored`.

**Commit** `clipper: Readability snapshot + block-id stamping + unanchored fallback`.

### Task 15: per-highlight screenshot pipeline (SW + offscreen crop)

For each highlight, the content script scrolls its rect into view and reports the viewport-relative rect; the SW calls `chrome.tabs.captureVisibleTab` (PNG of the viewport) and forwards PNG + rect to the offscreen document, which crops to the rect on a canvas and returns WebP; the SW attaches `shotBase64`. Sequential (captureVisibleTab is viewport-current). Create the offscreen document on demand (`chrome.offscreen.createDocument`, reason `DOM_PARSER`/`BLOBS`).

**Manual verification:** Submit with 2 highlights → bundle carries 2 `shotBase64` values; decode one (paste into an `<img src="data:image/webp;base64,...">`) and confirm it shows the highlighted region.

**Commit** `clipper: per-highlight viewport screenshot via offscreen crop`.

### Task 16: assemble + POST `/capture`, with retry from storage

The SW builds the `CaptureBundle`, reads the host URL from `chrome.storage`, and `fetch(hostURL + "/capture", { method:"POST", headers:{ "content-type":"application/json", "x-orden-clipper":"1" }, body })`. On success, clear the URL's stored highlights and toast in the content script. On network failure, keep the bundle in `chrome.storage` and surface a retry. (SW may be killed mid-flight — the stored bundle is the recovery.)

**Manual verification (end-to-end, needs the host):**
1. Build web + run host: `pnpm --filter @orden/web build && pnpm --filter @orden/host exec tsx apps/host/src/serve.ts`.
2. Arm on an external page, add 2 highlights (one For-me), Submit to inbox.
3. In orden: a new Journal block references the page; opening the snapshot in the main panel shows the highlights painted; the agent-audience ones are addressable. Confirm `~/.orden/vault/snapshots/<hash>.html` and `annotations/<sourceHash>.json` exist on disk.

**Commit** `clipper: assemble + POST capture bundle with storage-backed retry`.

---

## Phase 6 — Options + polish

### Task 17: options page (host URL + connection test) and toasts

`options.ts`: persist host URL to `chrome.storage.sync`; a "Test connection" button does a guarded `GET /projects` and reports OK/fail. Content-script toast component for submit success/failure (orden-styled).

**Manual verification:** change the port in options, Test connection reflects reachability; submit toast appears.

**Commit** `clipper: options page (host URL + connection test) and submit toasts`.

---

## Phase 7 — End-to-end verification and design-doc closeout

### Task 18: full happy-path run + update design doc status

Run the Task-16 end-to-end scenario plus: route a capture to a project with instructions and confirm a session is created in the `planning` column with the snapshot + agent notes as its prompt. Flip the design doc Status to "implemented (Chrome)". Verify `pnpm -r typecheck` and `pnpm -r test` are green.

**Commit** `clipper: e2e verified; design status → implemented (Chrome)`.

---

## Phase 8 — Firefox port

### Task 19: `browserApi` shim + Firefox manifest

Introduce `extensions/clipper/src/browserApi.ts` that aliases `chrome`/`browser` and normalizes the few divergent APIs (offscreen vs background crop, promise vs callback). Add a Firefox build target (`manifest.firefox.json`: event-page background, `browser_specific_settings`). Firefox can crop in the background page (no offscreen document) — branch in the shim.

**Manual verification:** `about:debugging` → Load Temporary Add-on → the Firefox `dist`; run the Task-16 scenario in Firefox.

**Commit** `clipper: Firefox port behind browserApi shim`.

---

## Definition of done

- `pnpm -r typecheck` and `pnpm -r test` green (host + core tasks fully TDD'd).
- Chrome extension: arm → highlight (agent/human) → screenshot → Submit → snapshot + WADM annotations + Journal entry in orden; optional project/session routing works.
- Firefox extension runs the same happy path.
- Design doc reconciled and marked implemented; this plan's tasks all committed.

## Risks / watch-items

- **Readability cooldown** (Task 14) — may force a pinned/vendored version.
- **Journal append format** (Task 4 step 5) — confirm the on-disk outline page format before writing; keep the append minimal (one bullet) to avoid corrupting the ProseMirror doc model.
- **contentHash drift** — the extension stamps block-ids then the host re-validates against the stored snapshot; keep the stamping deterministic so the host's re-resolve matches (same `blockId` algorithm on both sides — both use `annotation-core`).
- **CSS Custom Highlight API support** — Chrome/Firefox current both support it; if a target page sets a restrictive CSP, the Shadow-root overlay still works (it's same-world DOM, not an injected stylesheet URL).

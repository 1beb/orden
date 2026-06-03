# Web Annotation — Phase 2 (In-App Viewers + Overlay) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make annotations visible and creatable on the code, image, and owned-HTML viewers — paint text highlights via the CSS Custom Highlight API and image `region` boxes via overlay divs, backed by source-keyed storage, with the annotations panel persisting across every viewer.

**Architecture:** Phase 1 built the WADM library (`OrdenAnnotation`, `Source`/`Selector`, `resolveSelectors`, `sourceHash`/`contentHash`, `migrate`) in `packages/annotation-core`. This phase wires it into `apps/web`: a source-keyed annotation store over the existing vault (ns `annotations`, key `sourceHash` → bundle `{ source, annotations }`, which the host's `DiskVault` lands as `<vaultRoot>/annotations/<sourceHash>.json` — the spec's legible on-disk JSON, no new host adapter). The annotations panel is lifted out of `#main` so it spans all center views and renders from a bundle instead of from ProseMirror. A non-PM overlay renderer paints highlights: CSS Custom Highlight API for text sources (code / plain text / owned-HTML rendered same-origin), absolutely-positioned boxes for image `region` selectors. The existing markdown/review path (ProseMirror marks + `persist.ts`) is left untouched this phase — dual-path is intentional; the `migrate.ts` unify is deferred.

**Tech Stack:** TypeScript, Vite (`apps/web` builds to `dist`, host serves static — rebuild to see changes), Vitest + happy-dom for unit tests, `@orden/annotation-core` (WADM foundation), browser CSS Custom Highlight API (`Highlight` / `CSS.highlights`).

**Design references:**
- `docs/plans/2026-05-31-orden-web-annotation-design.md` (the spec)
- `docs/plans/2026-06-01-web-annotation-phase1-foundation.md` (what already exists)

**Decisions locked for this phase:**
1. Owned (on-disk repo) HTML renders **same-origin** (`sandbox="allow-scripts allow-same-origin"`) so the parent annotates the rendered DOM directly. External webpages stay null-origin sandboxed and are out of scope (future browser extension, Phase 4). See memory `html-annotation-trust-model`.
2. Storage is **new-viewers-only**: source-keyed for code/image/html; markdown/review stays on `persist.ts`. No legacy migration run this phase.
3. Annotatable surfaces this phase: code viewer, plain-text viewer (same path as code), owned-HTML rendered viewer, image viewer (region). PDF deferred.

**Key facts about the existing code (verified):**
- `apps/web/src/persist.ts` — markdown+records co-stored in vault ns `docs` per `docKey`. Untouched here.
- `apps/web/src/store.ts` — `AnnotationLog` (in-memory, legacy `Annotation`). Untouched; new code uses a separate store.
- `apps/web/src/viewState.ts` — `View = "review" | "code" | "image" | "html" | ...`; `createViewStore` notifies subscribers on every `set`.
- `apps/web/src/main.ts` — `viewEls` (611), view switch toggles `.active` (697-698), `openRepoFile` (997-1024) is the single funnel and already computes `kind` + reads bytes, `renderPanel` (497) is ProseMirror-coupled, `currentDocKey`/`currentDocTitle` track the open file.
- `apps/web/index.html` — `#panel` aside (Outline + `.annotations-block`) is nested **inside** `#main` (66-91); other views are sibling empty `<section>`s (94-100).
- `apps/web/src/richView.ts` — `renderImageView` (img over `/repo-file/`), `renderHtmlView` (iframe `srcdoc`, sandbox `allow-scripts`). `repoFileUrl` exists.
- `apps/web/src/codeView.ts` — `renderCodeView` builds `<pre.code-view><code.hljs>` with one `.code-line`(`.code-gutter`+`.code-src`) per line.
- `packages/annotation-core/src/blockId.ts` — `assignBlockIds(root)` + `BLOCK_ID_ATTR`; `resolveSelectors(selector, root)` returns a `Range | null`.
- `packages/host-api` — `VaultStore { get/set/list/delete }`; host RPC already exposes `host.vault`. `SessionManager.annotationSend` exists for delivery.
- The web build is served from `dist`; `npm run build --prefix apps/web` then run the host (memory `web-served-from-dist`, `run-orden-locally`).

---

## Task 1: Source-keyed annotation store (web)

A thin store over `host.vault` ns `annotations`: read/write the per-source bundle `{ source, annotations: OrdenAnnotation[] }`, keyed by `sourceHash(source)`. Hydrate-at-boot + write-through cache, mirroring `persist.ts`'s pattern so reads are synchronous.

**Files:**
- Create: `apps/web/src/annotationStore.ts`
- Test: `apps/web/test/annotationStore.test.ts`

**Step 1: Write the failing test**

```ts
// apps/web/test/annotationStore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import type { VaultStore } from "@orden/host-api";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";
import { sourceHash } from "@orden/annotation-core";
import { AnnotationStore } from "../src/annotationStore";

function fakeVault(): VaultStore {
  const data = new Map<string, unknown>();
  return {
    async get(ns, key) { return (data.get(`${ns}/${key}`) ?? null) as any; },
    async set(ns, key, value) { data.set(`${ns}/${key}`, value); },
    async list(ns) {
      return [...data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1));
    },
    async delete(ns, key) { data.delete(`${ns}/${key}`); },
  };
}

const source: Source = { kind: "file", vaultPath: "x/a.ts", contentHash: "sha256:aa" };
function ann(id: string): OrdenAnnotation {
  return {
    id, created: "2026-06-02T00:00:00.000Z", creator: { kind: "human", id: "me" },
    target: { source, selector: { type: "text-quote", exact: "x", prefix: "", suffix: "" } },
    body: { text: "note" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
  };
}

describe("AnnotationStore", () => {
  let vault: VaultStore;
  let store: AnnotationStore;
  beforeEach(async () => {
    vault = fakeVault();
    store = new AnnotationStore(vault);
    await store.hydrate();
  });

  it("returns [] for an unknown source", () => {
    expect(store.forSource(source)).toEqual([]);
  });

  it("adds and lists annotations for a source, and write-through persists", async () => {
    store.add(source, ann("a1"));
    expect(store.forSource(source).map((a) => a.id)).toEqual(["a1"]);
    const bundle = await vault.get<{ source: Source; annotations: OrdenAnnotation[] }>("annotations", sourceHash(source));
    expect(bundle?.annotations).toHaveLength(1);
    expect(bundle?.source).toEqual(source);
  });

  it("removes an annotation", () => {
    store.add(source, ann("a1"));
    store.add(source, ann("a2"));
    store.remove(source, "a1");
    expect(store.forSource(source).map((a) => a.id)).toEqual(["a2"]);
  });

  it("re-hydrates persisted bundles into a fresh store", async () => {
    store.add(source, ann("a1"));
    const store2 = new AnnotationStore(vault);
    await store2.hydrate();
    expect(store2.forSource(source).map((a) => a.id)).toEqual(["a1"]);
  });

  it("guards source-hash collisions by comparing stored source identity before merging", async () => {
    // Two distinct sources are never merged even if a future hash collides:
    // the bundle stores the full source and forSource compares identity.
    const other: Source = { kind: "file", vaultPath: "y/b.ts", contentHash: "sha256:bb" };
    store.add(source, ann("a1"));
    expect(store.forSource(other)).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run (from repo root): `npm test --prefix apps/web -- annotationStore`
Expected: FAIL — `Cannot find module '../src/annotationStore'`.

**Step 3: Write minimal implementation**

```ts
// apps/web/src/annotationStore.ts
import type { VaultStore } from "@orden/host-api";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";
import { sourceHash } from "@orden/annotation-core";

const NS = "annotations";

export interface AnnotationBundle {
  source: Source;
  annotations: OrdenAnnotation[];
}

// Helper: do two sources name the same thing? (identity, not bytes)
function sameSource(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "web" && b.kind === "web"
    ? a.url === b.url
    : (a as { vaultPath: string }).vaultPath === (b as { vaultPath: string }).vaultPath;
}

// Source-keyed annotation store. Bundles live in vault ns `annotations`, key =
// sourceHash(source); the host's DiskVault lands each as
// <vaultRoot>/annotations/<sourceHash>.json — legible on-disk JSON.
export class AnnotationStore {
  private cache = new Map<string, AnnotationBundle>();
  constructor(private readonly vault: VaultStore) {}

  async hydrate(): Promise<void> {
    const keys = await this.vault.list(NS);
    this.cache.clear();
    for (const k of keys) {
      const b = await this.vault.get<AnnotationBundle>(NS, k);
      if (b) this.cache.set(k, b);
    }
  }

  forSource(source: Source): OrdenAnnotation[] {
    const b = this.cache.get(sourceHash(source));
    // Collision guard: only return when the stored bundle is the SAME source.
    if (!b || !sameSource(b.source, source)) return [];
    return b.annotations;
  }

  add(source: Source, ann: OrdenAnnotation): void {
    const key = sourceHash(source);
    const existing = this.cache.get(key);
    const bundle: AnnotationBundle =
      existing && sameSource(existing.source, source)
        ? { source, annotations: [...existing.annotations, ann] }
        : { source, annotations: [ann] };
    this.cache.set(key, bundle);
    void this.vault.set(NS, key, bundle);
  }

  remove(source: Source, id: string): void {
    const key = sourceHash(source);
    const existing = this.cache.get(key);
    if (!existing || !sameSource(existing.source, source)) return;
    const bundle = { source, annotations: existing.annotations.filter((a) => a.id !== id) };
    this.cache.set(key, bundle);
    void this.vault.set(NS, key, bundle);
  }

  replace(source: Source, id: string, next: OrdenAnnotation): void {
    const key = sourceHash(source);
    const existing = this.cache.get(key);
    if (!existing || !sameSource(existing.source, source)) return;
    const bundle = { source, annotations: existing.annotations.map((a) => (a.id === id ? next : a)) };
    this.cache.set(key, bundle);
    void this.vault.set(NS, key, bundle);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix apps/web -- annotationStore`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add apps/web/src/annotationStore.ts apps/web/test/annotationStore.test.ts
git commit -m "feat(web): source-keyed annotation store over vault ns annotations"
```

---

## Task 2: Build a `Source` for the active viewer

Given the open repo file (path + bytes), produce the WADM `Source` the store keys on. Owned repo files are `{ kind: "file", vaultPath, contentHash }`. `contentHash` reuses the Phase-1 `contentHash(text)`.

**Files:**
- Create: `apps/web/src/viewerSource.ts`
- Test: `apps/web/test/viewerSource.test.ts`

**Step 1: Write the failing test**

```ts
// apps/web/test/viewerSource.test.ts
import { describe, it, expect } from "vitest";
import { fileSource } from "../src/viewerSource";

describe("fileSource", () => {
  it("builds a file source with a sha256 content hash from text", async () => {
    const s = await fileSource("docs/a.ts", "hello", "A");
    expect(s.kind).toBe("file");
    expect(s).toMatchObject({ vaultPath: "docs/a.ts", title: "A" });
    expect(s.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is content-sensitive (drift detectable)", async () => {
    const a = await fileSource("docs/a.ts", "v1");
    const b = await fileSource("docs/a.ts", "v2");
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix apps/web -- viewerSource`
Expected: FAIL — `Cannot find module '../src/viewerSource'`.

**Step 3: Write minimal implementation**

```ts
// apps/web/src/viewerSource.ts
import { contentHash, type Source } from "@orden/annotation-core";

// The WADM Source for an owned repo file currently open in a viewer.
export async function fileSource(path: string, content: string, title?: string): Promise<Source> {
  return { kind: "file", vaultPath: path, contentHash: await contentHash(content), title };
}
```

For images (binary, loaded via `/repo-file/`, not read as text), hash the path+bytelen placeholder is insufficient — defer a true binary `contentHash` (Phase-1 carry-forward note: widen `contentHash` to `BufferSource`). For this phase images use `fileSource(path, path)` (identity-only hash) — region anchors don't depend on text drift, and `sourceHash` keys on `vaultPath` regardless. Document this in the code comment.

**Step 4: Run test to verify it passes**

Run: `npm test --prefix apps/web -- viewerSource`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add apps/web/src/viewerSource.ts apps/web/test/viewerSource.test.ts
git commit -m "feat(web): build WADM Source for the active viewer"
```

---

## Task 3: Selection → text selector (pure)

Turn a DOM `Range` (a user text selection inside a block-id'd root) into the `[text-quote, text-position]` fallback selector array the store records. Mirrors `addAnnotation`'s quote-context capture but emits WADM selectors against an arbitrary DOM, not ProseMirror.

**Files:**
- Create: `apps/web/src/textSelector.ts`
- Test: `apps/web/test/textSelector.test.ts`

**Step 1: Write the failing test**

```ts
// apps/web/test/textSelector.test.ts
import { describe, it, expect } from "vitest";
import { assignBlockIds, BLOCK_ID_ATTR } from "@orden/annotation-core";
import { selectorsForRange } from "../src/textSelector";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(root);
  assignBlockIds(root);
  return root;
}

describe("selectorsForRange", () => {
  it("emits a text-quote + text-position fallback for a selection", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const p = root.querySelector("p")!;
    const range = document.createRange();
    const textNode = p.firstChild!;
    range.setStart(textNode, 4); // "quick"
    range.setEnd(textNode, 9);
    const sels = selectorsForRange(range, root);
    expect(sels[0]).toMatchObject({ type: "text-quote", exact: "quick", prefix: "the ", suffix: " brown" });
    expect(sels[1]).toMatchObject({ type: "text-position", start: 4, end: 9 });
    expect((sels[1] as { blockId: string }).blockId).toBe(p.getAttribute(BLOCK_ID_ATTR));
  });

  it("returns [] for a collapsed range", () => {
    const root = rendered("<section><p>abc</p></section>");
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 1);
    range.collapse(true);
    expect(selectorsForRange(range, root)).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test --prefix apps/web -- textSelector`
Expected: FAIL — `Cannot find module '../src/textSelector'`.

**Step 3: Write minimal implementation**

```ts
// apps/web/src/textSelector.ts
import { BLOCK_ID_ATTR, type Selector } from "@orden/annotation-core";

const QUOTE_CONTEXT = 32;

// The nearest ancestor element carrying a block id, and the text offset of `node`
// within that block's textContent.
function blockOffset(node: Node, offset: number): { block: Element; pos: number } | null {
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && !el.hasAttribute(BLOCK_ID_ATTR)) el = el.parentElement;
  if (!el) return null;
  // Sum text length of all text nodes preceding (node, offset) within `el`.
  let pos = 0;
  const walk = (n: Node): boolean => {
    if (n === node) { pos += offset; return true; }
    if (n.nodeType === Node.TEXT_NODE) { pos += n.textContent?.length ?? 0; return false; }
    for (const c of Array.from(n.childNodes)) if (walk(c)) return true;
    return false;
  };
  walk(el);
  return { block: el, pos };
}

// Convert a non-collapsed selection Range into [text-quote, text-position] fallbacks.
export function selectorsForRange(range: Range, _root: Element): Selector[] {
  if (range.collapsed) return [];
  const start = blockOffset(range.startContainer, range.startOffset);
  const end = blockOffset(range.endContainer, range.endOffset);
  if (!start || !end || start.block !== end.block) {
    // Cross-block selection: fall back to quote-only (position needs one block).
    const exact = range.toString();
    if (!exact) return [];
    return [{ type: "text-quote", exact, prefix: "", suffix: "" }];
  }
  const text = start.block.textContent ?? "";
  const from = start.pos, to = end.pos;
  const blockId = start.block.getAttribute(BLOCK_ID_ATTR) ?? undefined;
  const exact = text.slice(from, to);
  if (!exact) return [];
  const prefix = text.slice(Math.max(0, from - QUOTE_CONTEXT), from);
  const suffix = text.slice(to, Math.min(text.length, to + QUOTE_CONTEXT));
  return [
    { type: "text-quote", exact, prefix, suffix, blockId },
    { type: "text-position", start: from, end: to, blockId },
  ];
}
```

**Step 4: Run test to verify it passes**

Run: `npm test --prefix apps/web -- textSelector`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add apps/web/src/textSelector.ts apps/web/test/textSelector.test.ts
git commit -m "feat(web): selection Range -> WADM text selectors"
```

---

## Task 4: Lift the annotations panel out of `#main`

Structural HTML/CSS change so the panel spans every center view. Today `#panel` is inside `#main` (review only); move it to be a child of `#view-area`, a sibling of the view sections, in a flex row. No behavior change to the review path yet — `renderPanel` still drives it; Task 6 makes it source-aware.

**Files:**
- Modify: `apps/web/index.html` (move `<aside id="panel">` out of `#main` to a sibling under `#view-area`)
- Modify: `apps/web/src/styles.css` (`#view-area` becomes a flex row: active `.view` + persistent `#panel`; remove `#main`-nested panel assumptions at 176-190, 1482+)
- Modify: `apps/web/src/main.ts` if any selector assumes `#panel` lives in `#main` (e.g. `panels-collapsed` toggling at 183-190)

**Step 1: Write the failing test (DOM-structure guard)**

```ts
// apps/web/test/panelLayout.test.ts  (new)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("panel is a sibling of the views, not nested in #main", () => {
  it("index.html places #panel directly under #view-area", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    // crude structural assertion: #panel closes AFTER #main closes
    const panelIdx = html.indexOf('id="panel"');
    const mainOpen = html.indexOf('id="main"');
    const mainClose = html.indexOf("</section>", mainOpen);
    expect(panelIdx).toBeGreaterThan(mainClose); // panel no longer inside #main
  });
});
```

**Step 2: Run to verify it fails**

Run: `npm test --prefix apps/web -- panelLayout`
Expected: FAIL — panel currently sits before `#main` closes.

**Step 3: Implement**

- In `index.html`: cut the `<aside id="panel">…</aside>` block out of `#main` (so `#main` holds only `#doc-pane`), and place it as the LAST child of `#view-area`, after `#view-kanban`.
- In `styles.css`: make `#view-area { display: flex; }`; the active `.view` flexes to fill, `#panel` keeps its fixed/percent width and is always present. Audit rules under `#main` / `#main.panels-collapsed #panel` (183-190) and `#panel` (1482+) — re-scope `panels-collapsed` to `#view-area` (or `body`) so hide/show still works.
- In `main.ts`: if `panel.classList`/`panels-collapsed` is toggled on `#main`, retarget to the new parent. Verify `wireFurl`, `annHideShow`, mobile sheet rules (2013+) still resolve.

**Step 4: Verify**

Run: `npm test --prefix apps/web -- panelLayout` → PASS.
Run full web suite: `npm test --prefix apps/web` → green.
Build + run the app, open the review view: panel still renders, hide/show + collapse still work, mobile sheet unaffected (memory `visual-work-show-dont-narrate`: rebuild `dist`, run host, `xdg-open`).

**Step 5: Commit**

```bash
git add apps/web/index.html apps/web/src/styles.css apps/web/src/main.ts apps/web/test/panelLayout.test.ts
git commit -m "feat(web): lift annotations panel out of #main so it spans all viewers"
```

---

## Task 5: Source-agnostic panel renderer

Add a renderer that lists a `OrdenAnnotation[]` (from `AnnotationStore.forSource`) into `#annotation-list`, independent of ProseMirror. On the review view the existing `renderPanel` still runs; on code/image/html the new `renderSourcePanel(anns, { onSelect, onDelete })` runs. Reuse the existing row markup/classes (`.quote`, `.note`, status chip) for visual parity.

**Files:**
- Create: `apps/web/src/sourcePanel.ts`
- Test: `apps/web/test/sourcePanel.test.ts`

**Step 1: Write the failing test**

```ts
// apps/web/test/sourcePanel.test.ts
import { describe, it, expect, vi } from "vitest";
import type { OrdenAnnotation } from "@orden/annotation-core";
import { renderSourcePanel } from "../src/sourcePanel";

const base: OrdenAnnotation = {
  id: "a1", created: "2026-06-02T00:00:00.000Z", creator: { kind: "human", id: "me" },
  target: { source: { kind: "file", vaultPath: "a.ts", contentHash: "sha256:z" },
            selector: { type: "text-quote", exact: "foo", prefix: "", suffix: "" } },
  body: { text: "a note" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
};

describe("renderSourcePanel", () => {
  it("renders a row per annotation with quote + note, newest first", () => {
    const list = document.createElement("ul");
    renderSourcePanel(list, [base, { ...base, id: "a2", body: { text: "second" } }], {});
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(list.textContent).toContain("foo");
    expect(list.textContent).toContain("a note");
  });

  it("fires onSelect/onDelete callbacks", () => {
    const list = document.createElement("ul");
    const onSelect = vi.fn(), onDelete = vi.fn();
    renderSourcePanel(list, [base], { onSelect, onDelete });
    list.querySelector("li")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith("a1");
    list.querySelector<HTMLButtonElement>("button.del")!.click();
    expect(onDelete).toHaveBeenCalledWith("a1");
  });

  it("shows an empty hint when there are no annotations", () => {
    const list = document.createElement("ul");
    renderSourcePanel(list, [], {});
    expect(list.textContent).toMatch(/no annotations/i);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npm test --prefix apps/web -- sourcePanel`
Expected: FAIL — module missing.

**Step 3: Implement** `apps/web/src/sourcePanel.ts` — build one `<li>` per annotation (quote text from the `text-quote` selector's `exact`, note from `body.text`, status chip from `orden:status`), wire `onSelect(id)` on row click and an `onDelete(id)` button; render a `.panel-empty` hint when the list is empty. Match the class names used by `buildRow` (`main.ts` ~440-480) so existing CSS applies. (Selector extraction: handle `selector` being a single object or an array — pick the first `text-quote`.)

**Step 4: Run to verify it passes** → PASS (3 tests).

**Step 5: Commit**

```bash
git add apps/web/src/sourcePanel.ts apps/web/test/sourcePanel.test.ts
git commit -m "feat(web): source-agnostic annotation panel renderer"
```

---

## Task 6: Text overlay highlighter (CSS Custom Highlight API)

Paint stored text annotations as highlights over a rendered text root (code/text/owned-HTML), without mutating the DOM. Resolve each annotation's selector to a `Range` via `resolveSelectors`, register them in a named `Highlight`, and expose hover/active linking to the panel.

**Files:**
- Create: `apps/web/src/textOverlay.ts`
- Test: `apps/web/test/textOverlay.test.ts` (logic-level; happy-dom lacks the Highlight API, so test the resolve-and-collect step, guard the paint behind a feature check)

**Step 1: Write the failing test**

```ts
// apps/web/test/textOverlay.test.ts
import { describe, it, expect } from "vitest";
import { assignBlockIds } from "@orden/annotation-core";
import type { OrdenAnnotation } from "@orden/annotation-core";
import { resolveAnnotationRanges } from "../src/textOverlay";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html; document.body.innerHTML = ""; document.body.appendChild(root);
  assignBlockIds(root); return root;
}
const ann = (exact: string): OrdenAnnotation => ({
  id: "a1", created: "t", creator: { kind: "human", id: "me" },
  target: { source: { kind: "file", vaultPath: "a", contentHash: "h" },
            selector: { type: "text-quote", exact, prefix: "", suffix: "" } },
  body: { text: "n" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
});

describe("resolveAnnotationRanges", () => {
  it("returns a {id, range} for each resolvable annotation", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const out = resolveAnnotationRanges([ann("quick")], root);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a1");
    expect(out[0].range.toString()).toBe("quick");
  });
  it("skips annotations that don't resolve (orphans)", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    expect(resolveAnnotationRanges([ann("ZZZ")], root)).toHaveLength(0);
  });
});
```

**Step 2: Run to verify it fails** → FAIL (module missing).

**Step 3: Implement** `apps/web/src/textOverlay.ts`:
- `resolveAnnotationRanges(anns, root)` → `{ id, range }[]` using `resolveSelectors(a.target.selector, root)`, dropping nulls. (Pure; unit-tested.)
- `paintHighlights(root, anns)` → if `typeof Highlight !== "undefined" && CSS.highlights`, build a `Highlight(...ranges)` and `CSS.highlights.set("orden-annotation", h)`; also a second registry `orden-annotation-active` for the hovered one. Returns the `{ id, range }[]` so callers can map id→range for "scroll to". Feature-guarded so happy-dom/older browsers no-op the paint.
- Add the CSS in `styles.css`: `::highlight(orden-annotation) { background: <accent-tint>; }` and `::highlight(orden-annotation-active) { background: <stronger-accent>; }`.

**Step 4: Run to verify it passes** → PASS (2 tests).

**Step 5: Commit**

```bash
git add apps/web/src/textOverlay.ts apps/web/test/textOverlay.test.ts apps/web/src/styles.css
git commit -m "feat(web): CSS Custom Highlight overlay for text annotations"
```

---

## Task 7: Create + render text annotations on the code/text viewer

Wire it together for the code viewer: after `renderCodeView`, `assignBlockIds` over the code root, paint stored highlights, and on user text selection show an "Annotate" affordance that creates an `OrdenAnnotation` (via `createOrdenAnnotation` + `selectorsForRange`), stores it, re-paints, and re-renders the panel.

**Files:**
- Modify: `apps/web/src/codeView.ts` (return the root element; ensure lines are block-id'able — wrap so `assignBlockIds` tags per-line or per-`<code>`)
- Modify: `apps/web/src/main.ts` (`openRepoFile` code branch: build source, load anns, paint, wire selection→create, render source panel; on view leave, clear `CSS.highlights`)

**Steps (integration — verify by running the app):**
1. Make `renderCodeView` return the container/root so callers can `assignBlockIds` it and resolve selectors against it. Add/adjust a `codeView` unit test asserting it returns an element containing the highlighted lines.
2. In `main.ts`, factor a helper `openAnnotatableText(view, { path, title, content, root })`:
   - `const source = await fileSource(path, content, title)`
   - `assignBlockIds(root)`
   - `const anns = annotationStore.forSource(source)`
   - `paintHighlights(root, anns)` and `renderSourcePanel(annotation-list, anns, { onSelect: scrollToId, onDelete })`
   - selection handler on `root`: on `mouseup`, if `window.getSelection()` is non-empty inside `root`, show the existing annotate affordance; on confirm with a note, `createOrdenAnnotation({ source, selector: selectorsForRange(range, root), body: { text }, creator: await host.identity.me() ?? {kind:"human",id:"me"}, audience: "agent" })`, `annotationStore.add(source, ann)`, re-paint, re-render panel.
3. Call it from the code branch of `openRepoFile` (and the plain-text path).
4. On switching away from a text view, `CSS.highlights.delete("orden-annotation")` so highlights don't leak across sources.

**Verify:** rebuild `dist`, run host, open a `.ts` file: existing annotations highlight; select text → annotate → it persists (check `<vaultRoot>/annotations/<hash>.json`), survives reload, lists in the panel, click row scrolls to it. Run `npm test --prefix apps/web` green.

**Commit:**

```bash
git add apps/web/src/codeView.ts apps/web/src/main.ts
git commit -m "feat(web): annotate + highlight text on the code/text viewer"
```

---

## Task 8: Owned-HTML same-origin render + annotate rendered DOM

Trusted on-disk HTML renders same-origin so the parent reaches `contentDocument`. Reuse the text overlay path against the iframe's document.

**Files:**
- Modify: `apps/web/src/richView.ts` (`renderHtmlView` takes an `owned: boolean`; owned → `sandbox="allow-scripts allow-same-origin"`, external → keep null-origin `allow-scripts`)
- Modify: `apps/web/src/main.ts` (html branch: owned files pass `owned: true`; after iframe `load`, run `openAnnotatableText` against `frame.contentDocument.body`)

**Steps:**
1. Unit-test `renderHtmlView` sets `allow-same-origin` only when `owned` is true (assert the `sandbox` attribute string for both cases).
2. Implement the `owned` branch.
3. In `main.ts`, after `renderHtmlView(..., { owned: true })`, await the iframe `load` event, then `assignBlockIds` + paint + selection-wire against `frame.contentDocument!.body`. `CSS.highlights` is per-document — register highlights using the **iframe document's** `Range`s; the highlight registry is `frame.contentWindow.CSS.highlights`. (Confirm by running: highlights paint inside the iframe.)
4. Selection inside a same-origin iframe is read via `frame.contentWindow.getSelection()`.

**Verify:** open an owned `.html` file rendered: select text → annotate → persists + highlights inside the rendered page. Open the same file via "View source" (code view): annotations there are a *different source content* but same `vaultPath` — confirm `sourceHash` keys on `vaultPath` so both modes share one bundle (they do; `contentHash` differs but `sourceHash` ignores it). Decide + note whether rendered-DOM offsets and source offsets are compatible (they are NOT — selectors anchored in rendered DOM won't resolve against raw source text). Document this: rendered-mode and source-mode annotations coexist in the bundle but each only resolves in its own mode; orphan gracefully in the other. Add a `mode` tag if needed (defer unless it causes confusion).

**Commit:**

```bash
git add apps/web/src/richView.ts apps/web/src/main.ts apps/web/test/richView.test.ts
git commit -m "feat(web): render owned HTML same-origin and annotate the rendered page"
```

---

## Task 9: Image region annotations

Drag a rectangle over the image → normalized `region` selector → store + render an absolutely-positioned overlay box; panel lists region notes.

**Files:**
- Create: `apps/web/src/regionOverlay.ts` (pure: normalize/denormalize rect ↔ pixel given container size; render boxes)
- Test: `apps/web/test/regionOverlay.test.ts`
- Modify: `apps/web/src/richView.ts` (`renderImageView` returns root + wraps img in a positioned container)
- Modify: `apps/web/src/main.ts` (image branch: build source, load region anns, render boxes, drag-to-create)

**Step 1: Write the failing test (pure rect math)**

```ts
// apps/web/test/regionOverlay.test.ts
import { describe, it, expect } from "vitest";
import { normalizeRect, denormalizeRect } from "../src/regionOverlay";

describe("region rect normalization", () => {
  it("normalizes pixel rect to 0-1 against container size", () => {
    expect(normalizeRect({ x: 50, y: 20, w: 100, h: 40 }, { w: 200, h: 80 }))
      .toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });
  it("round-trips", () => {
    const norm = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const px = denormalizeRect(norm, { w: 1000, h: 500 });
    expect(normalizeRect(px, { w: 1000, h: 500 })).toEqual(norm);
  });
});
```

**Step 2: Run to verify it fails** → FAIL.

**Step 3: Implement** `regionOverlay.ts`: `normalizeRect`, `denormalizeRect`, and `renderRegionBoxes(container, anns, { onSelect })` that places `div.region-box` per region selector (denormalized to container size) + an empty-state. Add `.region-box` styling in `styles.css`.

**Step 4: Run to verify it passes** → PASS.

**Step 5: Integration (verify by running):** image branch builds `fileSource(path, path)`, renders boxes for stored region anns, supports mouse drag on the image container to draw a rect → on mouseup prompt for a note → `createOrdenAnnotation({ source, selector: { type: "region", rect: normalizeRect(...) }, ... })` → store + re-render boxes + panel. Reposition boxes on container resize.

**Step 6: Commit**

```bash
git add apps/web/src/regionOverlay.ts apps/web/test/regionOverlay.test.ts apps/web/src/richView.ts apps/web/src/main.ts apps/web/src/styles.css
git commit -m "feat(web): image region annotations with overlay boxes"
```

---

## Task 10: Deliver new-viewer annotations to the agent

The panel's primary action (Approve/Send) and the `annotationSend` host RPC already deliver review annotations. Route new-viewer annotations through the same delivery so "annotate everything" reaches the agent.

**Files:**
- Modify: `apps/web/src/main.ts` (panel send for non-review sources builds an `AnnotationRef`-shaped payload from the `OrdenAnnotation` — `quote` = selector exact (or "region in <file>"), `note` = `body.text`, target file = `source.vaultPath`)
- Check: `packages/host-api` `AnnotationSendInput`/`AnnotationRef` shape (already defined) — map without host changes if possible.

**Steps:** inspect `annotationDelivery.ts` + `AnnotationSendInput`; add a mapping from `OrdenAnnotation` + `Source` to the existing send input; wire the panel's send button when the active view is code/image/html. On success mark `orden:status: "sent"` via `annotationStore.replace`. Add a unit test for the mapping function. Verify end-to-end against a live session if available; otherwise assert the not-linked result path.

**Commit:**

```bash
git add apps/web/src/main.ts apps/web/test/annotationDeliveryMap.test.ts
git commit -m "feat(web): deliver code/image/html annotations to the agent"
```

---

## Done criteria for Phase 2

- Opening a code, plain-text, owned-HTML (rendered or source), or image file shows the annotations panel (lifted out of `#main`) with that source's annotations.
- Selecting text (code/text/owned-HTML) or dragging a box (image) creates an annotation that persists to `<vaultRoot>/annotations/<sourceHash>.json`, survives reload, paints an overlay, lists in the panel, and can be delivered to the agent.
- The review/markdown path (ProseMirror + `persist.ts`) is unchanged.
- `npm test --prefix apps/web` and `npm test --prefix packages/annotation-core` are green.
- App verified by running (rebuild `dist` → host → open files), per `visual-work-show-dont-narrate`.

## Explicitly deferred (not this phase)

- Full storage cutover + legacy migration off `persist.ts` (spec Phase 2's "switch apps/web off the old path"). Markdown stays dual-path until a later unify using `migrate.ts`.
- External webpages / live-page annotation → browser extension (Phase 4).
- Web clipper / single-file snapshots (Phase 3).
- PDF viewer + text/region anchoring on PDFs.
- Binary `contentHash` for images (carry-forward note) — region anchors don't need it; using identity-only source hash for now.
- text-position bounds-checking / orphan-on-overrun fix (Phase-1 carry-forward) — adopt when unifying resolvers.

## Open questions to confirm before/while executing

- Rendered-HTML vs source-mode selectors target different content under one `vaultPath`/bundle. Acceptable to let each orphan gracefully in the other mode, or add a `mode` discriminator on the selector? (Lean: ship without, add only if it confuses in practice.)
- Identity: `createOrdenAnnotation` creator — use `host.identity.me()` when present, else `{ kind: "human", id: "me" }` (matches Phase-1 migration placeholder).

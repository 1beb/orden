# Web Annotation — Phase 1 (Foundation) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the WADM-shaped `OrdenAnnotation` record, a source-keyed selector/resolver model, content + source hashing, and a one-time migration from the old per-doc annotation format — all inside `packages/annotation-core`, with zero change to the running app.

**Architecture:** This phase is pure library work. We extend `annotation-core` with new types (`Source`, `Selector`, `OrdenAnnotation`) that sit *alongside* the existing `Annotation` type — nothing is deleted yet. The current app keeps using the old `Annotation`/`persist.ts` path unchanged; the switch-over happens in Phase 2 when external viewers land. Everything here is unit-testable with no DOM-app wiring, so it ships safely behind no UI.

**Tech Stack:** TypeScript, Vitest + happy-dom (per-package). Hashing: `fnv1a` (existing idiom, for filename-safe source keys) and Web Crypto `crypto.subtle` SHA-256 (for content integrity, works in browser + Node 18+).

**Design reference:** `docs/plans/2026-05-31-orden-web-annotation-design.md`

**Key facts about the existing code (verified):**
- `packages/annotation-core/src/types.ts` defines today's `Annotation` (`anchor`, `body`, `target`, `status`, `thread`, `createdAt`).
- `resolveAnchor` in `anchor.ts` reads **only** `anchor.quote` — `position` is captured but never used to resolve. The new model turns `position` into a real fallback.
- Hash idiom is `fnv1a(str): string` returning base36 (`blockId.ts`).
- Tests run via `npm test` (= `vitest run`) **from the package directory** `packages/annotation-core`. Env is happy-dom.
- `createAnnotation` factory uses `Date.now()` + a module counter for ids.

---

## Task 1: New core types (Source, Selector, OrdenAnnotation)

**Files:**
- Create: `packages/annotation-core/src/wadm.ts`
- Test: `packages/annotation-core/test/wadm.types.test.ts`

These are type definitions; the "test" is a compile-time assertion file that constructs valid values, guarding the shape. Keep the conversational layer under `orden:` keys exactly as designed.

**Step 1: Write the failing test**

Create `packages/annotation-core/test/wadm.types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type {
  Source,
  Selector,
  OrdenAnnotation,
  AnnotationReply,
} from "../src/wadm";

describe("OrdenAnnotation shape", () => {
  it("accepts a web source with a text-quote selector and orden: superset", () => {
    const reply: AnnotationReply = {
      author: "agent",
      body: "done",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const source: Source = {
      kind: "web",
      url: "https://example.com/a",
      snapshotPath: ".orden/snapshots/abc.html",
      contentHash: "sha256:abc",
      title: "Example",
    };
    const selector: Selector = {
      type: "text-quote",
      exact: "quick",
      prefix: "the ",
      suffix: " brown",
    };
    const ann: OrdenAnnotation = {
      id: "ann_1",
      created: "2026-06-01T00:00:00.000Z",
      creator: { kind: "human", id: "me" },
      target: { source, selector },
      body: { text: "note", tags: ["x"], color: "yellow" },
      "orden:status": "open",
      "orden:audience": "agent",
      "orden:thread": [reply],
    };
    expect(ann.target.source.kind).toBe("web");
    expect(ann.target.selector.type).toBe("text-quote");
    expect(ann["orden:thread"]).toHaveLength(1);
  });

  it("accepts a file source with a region selector array", () => {
    const ann: OrdenAnnotation = {
      id: "ann_2",
      created: "2026-06-01T00:00:00.000Z",
      creator: { kind: "agent", id: "claude" },
      target: {
        source: { kind: "file", vaultPath: "clips/x.png", contentHash: "sha256:zz" },
        selector: [
          { type: "region", page: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
        ],
      },
      body: { text: "see this area" },
      "orden:status": "open",
      "orden:audience": "human",
      "orden:thread": [],
    };
    const sel = Array.isArray(ann.target.selector)
      ? ann.target.selector[0]
      : ann.target.selector;
    expect(sel.type).toBe("region");
  });
});
```

**Step 2: Run test to verify it fails**

Run (from `packages/annotation-core`): `npm test -- wadm.types`
Expected: FAIL — `Cannot find module '../src/wadm'`.

**Step 3: Write minimal implementation**

Create `packages/annotation-core/src/wadm.ts`:

```ts
// WADM-shaped annotation model. See docs/plans/2026-05-31-orden-web-annotation-design.md.
// The W3C Web Annotation Data MODEL (not strict JSON-LD): plain JSON, plus an
// `orden:` superset carrying the conversational layer WADM lacks.

export type Source =
  | { kind: "file"; vaultPath: string; contentHash: string; title?: string }
  | { kind: "web"; url: string; snapshotPath: string; contentHash: string; title?: string };

export interface TextQuoteSelector {
  type: "text-quote";
  exact: string;
  prefix: string;
  suffix: string;
  blockId?: string;
}

export interface TextPositionSelector {
  type: "text-position";
  start: number;
  end: number;
  blockId?: string;
}

export interface RegionSelector {
  type: "region";
  page?: number;
  // Normalized 0-1 for resolution independence (image / scanned PDF).
  rect: { x: number; y: number; w: number; h: number };
}

export type Selector = TextQuoteSelector | TextPositionSelector | RegionSelector;

export interface AnnotationReply {
  author: "user" | "agent";
  body: string;
  createdAt: string;
}

export type OrdenStatus = "open" | "sent" | "resolved";
export type OrdenAudience = "agent" | "human";

export interface OrdenAnnotation {
  id: string;
  created: string;
  creator: { kind: "human" | "agent"; id: string };
  target: {
    source: Source;
    // Single selector, or an ordered array of fallbacks (try first that resolves).
    selector: Selector | Selector[];
  };
  body: { text: string; tags?: string[]; color?: string };

  // orden: conversational superset (strict superset over WADM).
  "orden:status": OrdenStatus;
  "orden:audience": OrdenAudience;
  "orden:thread": AnnotationReply[];
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- wadm.types`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/wadm.ts packages/annotation-core/test/wadm.types.test.ts
git commit -m "feat(annotation-core): WADM annotation types + orden superset"
```

---

## Task 2: `createOrdenAnnotation` factory

**Files:**
- Create: `packages/annotation-core/src/wadmFactory.ts`
- Test: `packages/annotation-core/test/wadmFactory.test.ts`

Mirror the existing `createAnnotation` id idiom (`ann_${Date.now().toString(36)}_${n}`) so ids stay consistent across the codebase.

**Step 1: Write the failing test**

Create `packages/annotation-core/test/wadmFactory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createOrdenAnnotation } from "../src/wadmFactory";

const source = {
  kind: "file" as const,
  vaultPath: "notes/x.md",
  contentHash: "sha256:aa",
};
const selector = {
  type: "text-quote" as const,
  exact: "hi",
  prefix: "",
  suffix: "",
};

describe("createOrdenAnnotation", () => {
  it("defaults to open status, agent audience, empty thread, human creator", () => {
    const a = createOrdenAnnotation({
      source,
      selector,
      body: { text: "note" },
      creator: { kind: "human", id: "me" },
    });
    expect(a.id).toMatch(/^ann_/);
    expect(a["orden:status"]).toBe("open");
    expect(a["orden:audience"]).toBe("agent");
    expect(a["orden:thread"]).toEqual([]);
    expect(a.creator).toEqual({ kind: "human", id: "me" });
    expect(typeof a.created).toBe("string");
  });

  it("honors an explicit audience", () => {
    const a = createOrdenAnnotation({
      source,
      selector,
      body: { text: "note" },
      creator: { kind: "human", id: "me" },
      audience: "human",
    });
    expect(a["orden:audience"]).toBe("human");
  });

  it("mints unique ids", () => {
    const mk = () =>
      createOrdenAnnotation({ source, selector, body: { text: "n" }, creator: { kind: "human", id: "me" } });
    expect(mk().id).not.toBe(mk().id);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- wadmFactory`
Expected: FAIL — `Cannot find module '../src/wadmFactory'`.

**Step 3: Write minimal implementation**

Create `packages/annotation-core/src/wadmFactory.ts`:

```ts
import type {
  OrdenAnnotation,
  OrdenAudience,
  Selector,
  Source,
} from "./wadm";

let counter = 0;

export function createOrdenAnnotation(input: {
  source: Source;
  selector: Selector | Selector[];
  body: { text: string; tags?: string[]; color?: string };
  creator: { kind: "human" | "agent"; id: string };
  audience?: OrdenAudience;
}): OrdenAnnotation {
  counter += 1;
  return {
    id: `ann_${Date.now().toString(36)}_${counter}`,
    created: new Date().toISOString(),
    creator: input.creator,
    target: { source: input.source, selector: input.selector },
    body: input.body,
    "orden:status": "open",
    "orden:audience": input.audience ?? "agent",
    "orden:thread": [],
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- wadmFactory`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/wadmFactory.ts packages/annotation-core/test/wadmFactory.test.ts
git commit -m "feat(annotation-core): createOrdenAnnotation factory"
```

---

## Task 3: Hashing utilities (`sourceHash`, `contentHash`)

**Files:**
- Create: `packages/annotation-core/src/hash.ts`
- Test: `packages/annotation-core/test/hash.test.ts`

`sourceHash` = stable, filename-safe key derived from source *identity* (url for web, vaultPath for file) using the existing `fnv1a` idiom — collisions are tolerable because the full `source` object is stored alongside and thus detectable. `contentHash` = integrity hash of the source *bytes/text* via Web Crypto SHA-256, returned as `sha256:<hex>` (async).

**Step 1: Write the failing test**

Create `packages/annotation-core/test/hash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sourceHash, contentHash } from "../src/hash";

describe("sourceHash", () => {
  it("keys a web source by url, file source by vaultPath", () => {
    const web = sourceHash({ kind: "web", url: "https://a.com/x", snapshotPath: "s", contentHash: "sha256:z" });
    const file = sourceHash({ kind: "file", vaultPath: "notes/x.md", contentHash: "sha256:z" });
    expect(web).toMatch(/^[a-z0-9]+$/); // filename-safe base36
    expect(file).toMatch(/^[a-z0-9]+$/);
    expect(web).not.toBe(file);
  });

  it("is stable for the same identity regardless of contentHash/title", () => {
    const a = sourceHash({ kind: "web", url: "https://a.com/x", snapshotPath: "s1", contentHash: "sha256:1", title: "A" });
    const b = sourceHash({ kind: "web", url: "https://a.com/x", snapshotPath: "s2", contentHash: "sha256:2", title: "B" });
    expect(a).toBe(b);
  });
});

describe("contentHash", () => {
  it("returns a sha256:-prefixed hex digest", async () => {
    const h = await contentHash("hello");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic and content-sensitive", async () => {
    expect(await contentHash("a")).toBe(await contentHash("a"));
    expect(await contentHash("a")).not.toBe(await contentHash("b"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- hash`
Expected: FAIL — `Cannot find module '../src/hash'`.

**Step 3: Write minimal implementation**

Create `packages/annotation-core/src/hash.ts`:

```ts
import type { Source } from "./wadm";

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Stable, filename-safe key from a source's IDENTITY (not its bytes).
export function sourceHash(source: Source): string {
  const identity = source.kind === "web" ? `web|${source.url}` : `file|${source.vaultPath}`;
  return fnv1a(identity);
}

// Integrity hash of source bytes/text. SHA-256 via Web Crypto (browser + Node 18+).
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
```

Note: if happy-dom does not expose `crypto.subtle` in the test env, the `contentHash` tests will surface it. If so, import `webcrypto` from `node:crypto` at the top guarded by `globalThis.crypto ??= ...` — but try without first (Node 20 exposes global `crypto`).

**Step 4: Run test to verify it passes**

Run: `npm test -- hash`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/hash.ts packages/annotation-core/test/hash.test.ts
git commit -m "feat(annotation-core): sourceHash + contentHash utilities"
```

---

## Task 4: Selector resolver (text-quote + text-position fallback)

**Files:**
- Create: `packages/annotation-core/src/selector.ts`
- Test: `packages/annotation-core/test/selector.test.ts`

Reuse the proven quote-matching logic. `resolveSelectors` accepts one selector or an ordered array and returns the first that resolves to a `Range`. text-quote uses the existing fuzzy scoring (lifted from `resolveAnchor`); text-position resolves via `rangeFromOffsets` against the block named by `blockId`. `region` returns `null` (not a DOM range — rendered separately in Phase 2).

**Step 1: Write the failing test**

Create `packages/annotation-core/test/selector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assignBlockIds, BLOCK_ID_ATTR } from "../src/blockId";
import type { Selector } from "../src/wadm";
import { resolveSelectors } from "../src/selector";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(root);
  assignBlockIds(root);
  return root;
}

describe("resolveSelectors", () => {
  it("resolves a text-quote selector", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const sel: Selector = { type: "text-quote", exact: "quick", prefix: "the ", suffix: " brown" };
    const range = resolveSelectors(sel, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("quick");
  });

  it("falls back to text-position when quote fails", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const blockId = root.querySelector("p")!.getAttribute(BLOCK_ID_ATTR)!;
    const selectors: Selector[] = [
      { type: "text-quote", exact: "ZZZ-gone", prefix: "", suffix: "" },
      { type: "text-position", start: 4, end: 9, blockId },
    ];
    const range = resolveSelectors(selectors, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("quick");
  });

  it("returns null for a region selector (no DOM range)", () => {
    const root = rendered("<section><p>x</p></section>");
    const sel: Selector = { type: "region", rect: { x: 0, y: 0, w: 1, h: 1 } };
    expect(resolveSelectors(sel, root)).toBeNull();
  });

  it("returns null when nothing resolves", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const sel: Selector = { type: "text-quote", exact: "nope", prefix: "", suffix: "" };
    expect(resolveSelectors(sel, root)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- selector`
Expected: FAIL — `Cannot find module '../src/selector'`.

**Step 3: Write minimal implementation**

Create `packages/annotation-core/src/selector.ts`:

```ts
import { BLOCK_ID_ATTR } from "./blockId";
import { rangeFromOffsets } from "./textOffsets";
import type { Selector, TextQuoteSelector, TextPositionSelector } from "./wadm";

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function resolveQuote(sel: TextQuoteSelector, root: Element): Range | null {
  if (sel.exact.length === 0) return null;
  const occurrences: { block: Element; at: number; score: number }[] = [];
  for (const block of Array.from(root.querySelectorAll(`[${BLOCK_ID_ATTR}]`))) {
    const text = block.textContent ?? "";
    let from = 0;
    let at = text.indexOf(sel.exact, from);
    while (at !== -1) {
      const before = text.slice(0, at);
      const after = text.slice(at + sel.exact.length);
      const score = commonSuffixLength(before, sel.prefix) + commonPrefixLength(after, sel.suffix);
      occurrences.push({ block, at, score });
      from = at + 1;
      at = text.indexOf(sel.exact, from);
    }
  }
  if (occurrences.length === 0) return null;
  let chosen = occurrences[0];
  if (occurrences.length > 1) {
    const maxScore = Math.max(...occurrences.map((o) => o.score));
    const top = occurrences.filter((o) => o.score === maxScore);
    if (top.length !== 1) return null; // ambiguous -> orphan
    chosen = top[0];
  }
  return rangeFromOffsets(chosen.block, chosen.at, chosen.at + sel.exact.length);
}

function resolvePosition(sel: TextPositionSelector, root: Element): Range | null {
  if (!sel.blockId) return null;
  const block = root.querySelector(`[${BLOCK_ID_ATTR}="${sel.blockId}"]`);
  if (!block) return null;
  return rangeFromOffsets(block, sel.start, sel.end);
}

function resolveOne(sel: Selector, root: Element): Range | null {
  switch (sel.type) {
    case "text-quote":
      return resolveQuote(sel, root);
    case "text-position":
      return resolvePosition(sel, root);
    case "region":
      return null; // rendered as an overlay box, not a DOM Range
  }
}

// Try selectors in order; return the first that resolves to a Range.
export function resolveSelectors(selector: Selector | Selector[], root: Element): Range | null {
  const list = Array.isArray(selector) ? selector : [selector];
  for (const sel of list) {
    const range = resolveOne(sel, root);
    if (range) return range;
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- selector`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/selector.ts packages/annotation-core/test/selector.test.ts
git commit -m "feat(annotation-core): resolveSelectors with quote+position fallback"
```

---

## Task 5: Migration from the legacy `Annotation` model

**Files:**
- Create: `packages/annotation-core/src/migrate.ts`
- Test: `packages/annotation-core/test/migrate.test.ts`

Convert one legacy `PersistedDoc`-equivalent (a `docKey`, the file's `vaultPath`, its `contentHash`, and the old `Annotation[]`) into the new source-keyed bundle `{ source, annotations: OrdenAnnotation[] }`. Mapping: `anchor.quote` → text-quote selector; `anchor.position` (+ `anchor.blockId`) → text-position selector; both kept as an ordered fallback array. `target` → `orden:audience`; `status`/`thread`/`createdAt` preserved. This is a **pure function** — the host wiring that feeds it real vault data is Phase 2.

**Step 1: Write the failing test**

Create `packages/annotation-core/test/migrate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Annotation } from "../src/types";
import { migrateLegacyDoc } from "../src/migrate";

const legacy: Annotation[] = [
  {
    id: "ann_old_1",
    anchor: { blockId: "b1", quote: { exact: "quick", prefix: "the ", suffix: " brown" }, position: { start: 4, end: 9 } },
    body: "tighten this",
    target: "human",
    status: "sent",
    thread: [{ author: "agent", body: "ok", createdAt: "2026-05-01T00:00:00.000Z" }],
    createdAt: "2026-05-01T00:00:00.000Z",
  },
];

describe("migrateLegacyDoc", () => {
  it("produces a file source bundle keyed by vaultPath", () => {
    const bundle = migrateLegacyDoc({
      vaultPath: "notes/x.md",
      contentHash: "sha256:aa",
      records: legacy,
    });
    expect(bundle.source).toEqual({ kind: "file", vaultPath: "notes/x.md", contentHash: "sha256:aa" });
    expect(bundle.annotations).toHaveLength(1);
  });

  it("maps anchor to a [text-quote, text-position] selector fallback array", () => {
    const { annotations } = migrateLegacyDoc({ vaultPath: "notes/x.md", contentHash: "sha256:aa", records: legacy });
    const sel = annotations[0].target.selector;
    expect(Array.isArray(sel)).toBe(true);
    const arr = sel as any[];
    expect(arr[0]).toMatchObject({ type: "text-quote", exact: "quick", prefix: "the ", suffix: " brown", blockId: "b1" });
    expect(arr[1]).toMatchObject({ type: "text-position", start: 4, end: 9, blockId: "b1" });
  });

  it("preserves id, body, audience, status, thread, created", () => {
    const a = migrateLegacyDoc({ vaultPath: "notes/x.md", contentHash: "sha256:aa", records: legacy }).annotations[0];
    expect(a.id).toBe("ann_old_1");
    expect(a.body.text).toBe("tighten this");
    expect(a["orden:audience"]).toBe("human");
    expect(a["orden:status"]).toBe("sent");
    expect(a["orden:thread"]).toHaveLength(1);
    expect(a.created).toBe("2026-05-01T00:00:00.000Z");
  });

  it("omits a selector variant when its source anchor field is absent", () => {
    const quoteOnly: Annotation[] = [{ ...legacy[0], anchor: { blockId: "b1", quote: { exact: "x", prefix: "", suffix: "" } } }];
    const a = migrateLegacyDoc({ vaultPath: "n.md", contentHash: "sha256:bb", records: quoteOnly }).annotations[0];
    const arr = a.target.selector as any[];
    expect(arr).toHaveLength(1);
    expect(arr[0].type).toBe("text-quote");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- migrate`
Expected: FAIL — `Cannot find module '../src/migrate'`.

**Step 3: Write minimal implementation**

Create `packages/annotation-core/src/migrate.ts`:

```ts
import type { Annotation } from "./types";
import type { OrdenAnnotation, Selector, Source } from "./wadm";

export interface LegacyDocInput {
  vaultPath: string;
  contentHash: string;
  records: Annotation[];
}

export interface AnnotationBundle {
  source: Source;
  annotations: OrdenAnnotation[];
}

function anchorToSelectors(a: Annotation["anchor"]): Selector[] {
  const out: Selector[] = [];
  if (a.quote) {
    out.push({ type: "text-quote", exact: a.quote.exact, prefix: a.quote.prefix, suffix: a.quote.suffix, blockId: a.blockId });
  }
  if (a.position) {
    out.push({ type: "text-position", start: a.position.start, end: a.position.end, blockId: a.blockId });
  }
  return out;
}

export function migrateLegacyDoc(input: LegacyDocInput): AnnotationBundle {
  const source: Source = { kind: "file", vaultPath: input.vaultPath, contentHash: input.contentHash };
  const annotations: OrdenAnnotation[] = input.records.map((r) => ({
    id: r.id,
    created: r.createdAt,
    creator: { kind: "human", id: "me" },
    target: { source, selector: anchorToSelectors(r.anchor) },
    body: { text: r.body },
    "orden:status": r.status,
    "orden:audience": r.target,
    "orden:thread": r.thread.map((t) => ({ author: t.author, body: t.body, createdAt: t.createdAt })),
  }));
  return { source, annotations };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- migrate`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/migrate.ts packages/annotation-core/test/migrate.test.ts
git commit -m "feat(annotation-core): migrate legacy Annotation -> OrdenAnnotation bundle"
```

---

## Task 6: Export the new public surface

**Files:**
- Modify: `packages/annotation-core/src/index.ts`
- Test: `packages/annotation-core/test/wadm.exports.test.ts`

Expose the new pieces without disturbing existing exports (the running app still imports `createAnnotation`, `createAnchor`, etc.).

**Step 1: Write the failing test**

Create `packages/annotation-core/test/wadm.exports.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createOrdenAnnotation,
  resolveSelectors,
  sourceHash,
  contentHash,
  migrateLegacyDoc,
} from "../src/index";

describe("public surface", () => {
  it("re-exports the WADM foundation", () => {
    expect(typeof createOrdenAnnotation).toBe("function");
    expect(typeof resolveSelectors).toBe("function");
    expect(typeof sourceHash).toBe("function");
    expect(typeof contentHash).toBe("function");
    expect(typeof migrateLegacyDoc).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- wadm.exports`
Expected: FAIL — named exports missing from `../src/index`.

**Step 3: Write minimal implementation**

Append to `packages/annotation-core/src/index.ts`:

```ts
// --- WADM foundation (web annotation Phase 1) ---
export type {
  Source,
  Selector,
  TextQuoteSelector,
  TextPositionSelector,
  RegionSelector,
  OrdenAnnotation,
  OrdenStatus,
  OrdenAudience,
  AnnotationReply as OrdenReply,
} from "./wadm";
export { createOrdenAnnotation } from "./wadmFactory";
export { resolveSelectors } from "./selector";
export { sourceHash, contentHash } from "./hash";
export { migrateLegacyDoc } from "./migrate";
export type { AnnotationBundle, LegacyDocInput } from "./migrate";
```

Note: the existing `export * from "./types"` already exports an `AnnotationReply`; we alias the WADM one to `OrdenReply` above to avoid a name clash. Verify no other clashes when the test runs.

**Step 4: Run test to verify it passes**

Run: `npm test -- wadm.exports`
Expected: PASS.

**Step 5: Run the FULL package suite — nothing regressed**

Run (from `packages/annotation-core`): `npm test`
Expected: all prior tests (18) + the new tests PASS. If `tsc` is part of CI, also run `npm run typecheck` and expect no errors.

**Step 6: Commit**

```bash
git add packages/annotation-core/src/index.ts packages/annotation-core/test/wadm.exports.test.ts
git commit -m "feat(annotation-core): export WADM foundation surface"
```

---

## Done criteria for Phase 1

- New `OrdenAnnotation` model, factory, selector resolver, hashing, and legacy migration all live in `annotation-core` with passing unit tests.
- `npm test` in `packages/annotation-core` is fully green (old + new).
- The running app is byte-for-byte unchanged at runtime — nothing imports the new surface yet. (Verify: `git grep -n "createOrdenAnnotation\|resolveSelectors\|migrateLegacyDoc" apps/` returns nothing.)

## Explicitly deferred to later phases (do NOT build here)

- **Phase 2:** host storage adapter (`.orden/annotations/<sourceHash>.json` files + snapshot blob store in `host-api`/`diskVault`), running the migration against real vault data, in-app html/pdf/image viewers, the CSS Custom Highlight API overlay renderer, region-box rendering, switching `apps/web` off the old `persist.ts` path.
- **Phase 3:** web clipper (Playwright single-file snapshot → `.orden/snapshots/`).
- **Phase 4:** browser extension.

## Open question to resolve before Phase 2

The legacy migration sets `creator: { kind: "human", id: "me" }` for every record because the old model has no creator identity — only `audience`. Confirm `"me"` is an acceptable placeholder, or wire `host.identity.me()` in during the Phase 2 migration run so historical annotations get the real id.

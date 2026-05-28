# Annotation Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a framework-agnostic TypeScript module that turns a DOM text selection into a durable, re-resolvable annotation anchored to document structure, and batches annotations to a pluggable sink.

**Architecture:** Pure functions over a DOM tree, no framework. A block is any rendered element stamped with a deterministic `data-orden-block-id`. An anchor is a block id plus an optional text-quote and character offsets. Resolution finds the block by id and locates the quote inside it; if the id is gone, it repairs by searching the whole root for the quote. The module exposes Source and Sink seams so the same core serves the Orden app and a future browser extension.

**Tech Stack:** TypeScript, Vitest, happy-dom (DOM environment for tests), npm. No runtime dependencies.

---

## Conventions

- Package lives at `packages/annotation-core/` so the repo can grow into a workspace later.
- All anchor/selector shapes follow the W3C Web Annotation model loosely (TextQuoteSelector, TextPositionSelector) for future portability.
- TDD throughout: failing test first, minimal implementation, green, commit.
- Commit messages are short and contain no attribution.

---

### Task 1: Scaffold the package

**Files:**
- Create: `packages/annotation-core/package.json`
- Create: `packages/annotation-core/tsconfig.json`
- Create: `packages/annotation-core/vitest.config.ts`
- Create: `packages/annotation-core/src/index.ts`
- Create: `packages/annotation-core/test/smoke.test.ts`

**Step 1: Write the package manifest**

`packages/annotation-core/package.json`:

```json
{
  "name": "@orden/annotation-core",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "happy-dom": "^14.0.0"
  }
}
```

**Step 2: Write tsconfig**

`packages/annotation-core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2021", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

**Step 3: Write vitest config**

`packages/annotation-core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
  },
});
```

**Step 4: Write a smoke test**

`packages/annotation-core/test/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("environment", () => {
  it("has a DOM", () => {
    const el = document.createElement("div");
    el.textContent = "hello";
    expect(el.textContent).toBe("hello");
  });
});
```

Create an empty `packages/annotation-core/src/index.ts` (one line: `export {};`).

**Step 5: Install and run**

Run: `cd packages/annotation-core && npm install && npm test`
Expected: 1 test passes.

**Step 6: Commit**

```bash
git add packages/annotation-core
git commit -m "scaffold annotation-core package"
```

---

### Task 2: Annotation types and factory

**Files:**
- Create: `packages/annotation-core/src/types.ts`
- Create: `packages/annotation-core/src/annotation.ts`
- Test: `packages/annotation-core/test/annotation.test.ts`

**Step 1: Write the failing test**

`packages/annotation-core/test/annotation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createAnnotation } from "../src/annotation";

describe("createAnnotation", () => {
  it("creates an open, agent-targeted annotation with an id", () => {
    const a = createAnnotation({
      anchor: { blockId: "b1" },
      body: "tighten this paragraph",
    });
    expect(a.id).toMatch(/.+/);
    expect(a.target).toBe("agent");
    expect(a.status).toBe("open");
    expect(a.thread).toEqual([]);
    expect(typeof a.createdAt).toBe("string");
  });

  it("honors an explicit human target", () => {
    const a = createAnnotation({
      anchor: { blockId: "b1" },
      body: "share with Sam",
      target: "human",
    });
    expect(a.target).toBe("human");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- annotation`
Expected: FAIL, cannot find module `../src/annotation`.

**Step 3: Write minimal implementation**

`packages/annotation-core/src/types.ts`:

```ts
export interface TextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  start: number;
  end: number;
}

export interface Anchor {
  blockId: string;
  quote?: TextQuoteSelector;
  position?: TextPositionSelector;
}

export type FeedbackTarget = "agent" | "human";
export type AnnotationStatus = "open" | "sent" | "resolved";

export interface AnnotationReply {
  author: "user" | "agent";
  body: string;
  createdAt: string;
}

export interface Annotation {
  id: string;
  anchor: Anchor;
  body: string;
  target: FeedbackTarget;
  status: AnnotationStatus;
  thread: AnnotationReply[];
  createdAt: string;
}
```

`packages/annotation-core/src/annotation.ts`:

```ts
import type { Annotation, Anchor, FeedbackTarget } from "./types";

let counter = 0;

export function createAnnotation(input: {
  anchor: Anchor;
  body: string;
  target?: FeedbackTarget;
}): Annotation {
  counter += 1;
  return {
    id: `ann_${Date.now().toString(36)}_${counter}`,
    anchor: input.anchor,
    body: input.body,
    target: input.target ?? "agent",
    status: "open",
    thread: [],
    createdAt: new Date().toISOString(),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- annotation`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/types.ts packages/annotation-core/src/annotation.ts packages/annotation-core/test/annotation.test.ts
git commit -m "add annotation types and factory"
```

---

### Task 3: Deterministic block id

**Files:**
- Create: `packages/annotation-core/src/blockId.ts`
- Test: `packages/annotation-core/test/blockId.test.ts`

**Step 1: Write the failing test**

`packages/annotation-core/test/blockId.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeBlockId } from "../src/blockId";

function blockAt(html: string, selector: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root.querySelector(selector)!;
}

describe("computeBlockId", () => {
  it("is stable for the same block across calls", () => {
    const html = "<section><p>alpha</p><p>beta</p></section>";
    const a = computeBlockId(blockAt(html, "p:nth-child(2)"));
    const b = computeBlockId(blockAt(html, "p:nth-child(2)"));
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const html = "<section><p>alpha</p><p>beta</p></section>";
    const first = computeBlockId(blockAt(html, "p:nth-child(1)"));
    const second = computeBlockId(blockAt(html, "p:nth-child(2)"));
    expect(first).not.toBe(second);
  });

  it("differs for the same text at a different structural path", () => {
    const a = computeBlockId(blockAt("<section><p>same</p></section>", "p"));
    const b = computeBlockId(blockAt("<article><p>same</p></article>", "p"));
    expect(a).not.toBe(b);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- blockId`
Expected: FAIL, cannot find module `../src/blockId`.

**Step 3: Write minimal implementation**

`packages/annotation-core/src/blockId.ts`:

```ts
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function structuralPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.parentElement) {
    const parent = node.parentElement;
    const index = Array.prototype.indexOf.call(parent.children, node);
    parts.push(`${node.tagName}:${index}`);
    node = parent;
  }
  return parts.reverse().join("/");
}

export function computeBlockId(el: Element): string {
  const text = (el.textContent ?? "").trim();
  return fnv1a(`${structuralPath(el)}|${text}`);
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- blockId`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/blockId.ts packages/annotation-core/test/blockId.test.ts
git commit -m "add deterministic block id"
```

---

### Task 4: Stamp block ids onto a tree

**Files:**
- Modify: `packages/annotation-core/src/blockId.ts`
- Test: `packages/annotation-core/test/blockId.test.ts`

**Step 1: Write the failing test (append to existing file)**

```ts
import { assignBlockIds, BLOCK_ID_ATTR } from "../src/blockId";

describe("assignBlockIds", () => {
  it("stamps an id on every block-level element", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>Title</h1><p>one</p><ul><li>a</li><li>b</li></ul>";
    assignBlockIds(root);
    const stamped = root.querySelectorAll(`[${BLOCK_ID_ATTR}]`);
    expect(stamped.length).toBe(5); // h1, p, ul, li, li
  });

  it("is idempotent", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>one</p>";
    assignBlockIds(root);
    const first = root.querySelector("p")!.getAttribute(BLOCK_ID_ATTR);
    assignBlockIds(root);
    const second = root.querySelector("p")!.getAttribute(BLOCK_ID_ATTR);
    expect(second).toBe(first);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- blockId`
Expected: FAIL, `assignBlockIds` / `BLOCK_ID_ATTR` not exported.

**Step 3: Write minimal implementation (append to blockId.ts)**

```ts
export const BLOCK_ID_ATTR = "data-orden-block-id";

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6",
  "LI", "UL", "OL", "BLOCKQUOTE", "PRE",
  "TABLE", "TR", "TD", "TH", "FIGURE", "DIV",
]);

export function assignBlockIds(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (BLOCK_TAGS.has(node.tagName) && !node.hasAttribute(BLOCK_ID_ATTR)) {
      node.setAttribute(BLOCK_ID_ATTR, computeBlockId(node));
    }
    node = walker.nextNode() as Element | null;
  }
}
```

Note: idempotence comes from the `!hasAttribute` guard, so a re-stamp keeps the original id even if content later changes.

**Step 4: Run test to verify it passes**

Run: `npm test -- blockId`
Expected: PASS (5 tests total in file).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/blockId.ts packages/annotation-core/test/blockId.test.ts
git commit -m "stamp block ids onto a tree"
```

---

### Task 5: Text offset helpers

**Files:**
- Create: `packages/annotation-core/src/textOffsets.ts`
- Test: `packages/annotation-core/test/textOffsets.test.ts`

**Step 1: Write the failing test**

`packages/annotation-core/test/textOffsets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rangeFromOffsets, offsetsFromRange } from "../src/textOffsets";

function block(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root.firstElementChild!;
}

describe("text offsets", () => {
  it("maps offsets to a range and back", () => {
    const p = block("<p>the quick brown fox</p>");
    const range = rangeFromOffsets(p, 4, 9); // "quick"
    expect(range.toString()).toBe("quick");
    expect(offsetsFromRange(p, range)).toEqual({ start: 4, end: 9 });
  });

  it("handles offsets that span multiple text nodes", () => {
    const p = block("<p>the <em>quick</em> brown fox</p>");
    const range = rangeFromOffsets(p, 4, 15); // "quick brown"
    expect(range.toString()).toBe("quick brown");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- textOffsets`
Expected: FAIL, cannot find module.

**Step 3: Write minimal implementation**

`packages/annotation-core/src/textOffsets.ts`:

```ts
interface TextPoint {
  node: Text;
  offset: number;
}

function locate(block: Element, target: number): TextPoint {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node = walker.nextNode() as Text | null;
  let last: Text | null = null;
  while (node) {
    const len = node.data.length;
    if (target <= consumed + len) {
      return { node, offset: target - consumed };
    }
    consumed += len;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  if (last) return { node: last, offset: last.data.length };
  throw new Error("block has no text nodes");
}

export function rangeFromOffsets(block: Element, start: number, end: number): Range {
  const a = locate(block, start);
  const b = locate(block, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

export function offsetsFromRange(block: Element, range: Range): { start: number; end: number } {
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- textOffsets`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/textOffsets.ts packages/annotation-core/test/textOffsets.test.ts
git commit -m "add text offset helpers"
```

---

### Task 6: Create an anchor from a selection

**Files:**
- Create: `packages/annotation-core/src/anchor.ts`
- Test: `packages/annotation-core/test/anchor.test.ts`

**Step 1: Write the failing test**

`packages/annotation-core/test/anchor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assignBlockIds } from "../src/blockId";
import { rangeFromOffsets } from "../src/textOffsets";
import { createAnchor } from "../src/anchor";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(root);
  assignBlockIds(root);
  return root;
}

describe("createAnchor", () => {
  it("captures block id, quote, and position", () => {
    const root = rendered("<section><p>the quick brown fox jumps</p></section>");
    const p = root.querySelector("p")!;
    const range = rangeFromOffsets(p, 4, 9); // "quick"

    const anchor = createAnchor(range, root);

    expect(anchor.blockId).toBe(p.getAttribute("data-orden-block-id"));
    expect(anchor.quote!.exact).toBe("quick");
    expect(anchor.quote!.prefix.endsWith("the ")).toBe(true);
    expect(anchor.quote!.suffix.startsWith(" brown")).toBe(true);
    expect(anchor.position).toEqual({ start: 4, end: 9 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- anchor`
Expected: FAIL, cannot find module `../src/anchor`.

**Step 3: Write minimal implementation**

`packages/annotation-core/src/anchor.ts`:

```ts
import type { Anchor } from "./types";
import { BLOCK_ID_ATTR } from "./blockId";
import { offsetsFromRange } from "./textOffsets";

const QUOTE_CONTEXT = 32;

function closestBlock(node: Node): Element | null {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  while (el && !el.hasAttribute(BLOCK_ID_ATTR)) {
    el = el.parentElement;
  }
  return el;
}

export function createAnchor(range: Range, _root: Element): Anchor {
  const block = closestBlock(range.startContainer);
  if (!block) throw new Error("selection is not inside a stamped block");

  const blockId = block.getAttribute(BLOCK_ID_ATTR)!;
  const text = block.textContent ?? "";
  const { start, end } = offsetsFromRange(block, range);

  return {
    blockId,
    position: { start, end },
    quote: {
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
      suffix: text.slice(end, end + QUOTE_CONTEXT),
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- anchor`
Expected: PASS (1 test).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/anchor.ts packages/annotation-core/test/anchor.test.ts
git commit -m "create anchor from selection"
```

---

### Task 7: Resolve an anchor (happy path)

**Files:**
- Modify: `packages/annotation-core/src/anchor.ts`
- Test: `packages/annotation-core/test/anchor.test.ts`

**Step 1: Write the failing test (append)**

```ts
import { resolveAnchor } from "../src/anchor";

describe("resolveAnchor", () => {
  it("round-trips a selection back to the same text", () => {
    const root = rendered("<section><p>the quick brown fox jumps</p></section>");
    const p = root.querySelector("p")!;
    const range = rangeFromOffsets(p, 4, 9);
    const anchor = createAnchor(range, root);

    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe("quick");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- anchor`
Expected: FAIL, `resolveAnchor` not exported.

**Step 3: Write minimal implementation (append to anchor.ts)**

```ts
import { rangeFromOffsets } from "./textOffsets";
import type { TextQuoteSelector } from "./types";

function findQuoteOffset(haystack: string, quote: TextQuoteSelector): number {
  const withContext = quote.prefix + quote.exact + quote.suffix;
  const ctxIdx = haystack.indexOf(withContext);
  if (ctxIdx !== -1) return ctxIdx + quote.prefix.length;
  return haystack.indexOf(quote.exact);
}

export function resolveAnchor(anchor: Anchor, root: Element): Range | null {
  const block = root.querySelector(
    `[${BLOCK_ID_ATTR}="${anchor.blockId}"]`,
  );
  if (block && anchor.quote) {
    const text = block.textContent ?? "";
    const at = findQuoteOffset(text, anchor.quote);
    if (at !== -1) {
      return rangeFromOffsets(block, at, at + anchor.quote.exact.length);
    }
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- anchor`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/anchor.ts packages/annotation-core/test/anchor.test.ts
git commit -m "resolve anchor happy path"
```

---

### Task 8: Repair across structural change, fail loudly when gone

**Files:**
- Modify: `packages/annotation-core/src/anchor.ts`
- Test: `packages/annotation-core/test/anchor.test.ts`

**Step 1: Write the failing tests (append)**

```ts
describe("resolveAnchor repair", () => {
  it("repairs when the block id no longer matches", () => {
    const root = rendered("<section><p>the quick brown fox jumps</p></section>");
    const p = root.querySelector("p")!;
    const anchor = createAnchor(rangeFromOffsets(p, 4, 9), root);

    // Simulate a re-render where a block was inserted above and ids changed.
    root.innerHTML =
      "<section><p>new intro line</p><p>the quick brown fox jumps</p></section>";
    assignBlockIds(root);

    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe("quick");
  });

  it("returns null when the text is gone (no false match)", () => {
    const root = rendered("<section><p>the quick brown fox jumps</p></section>");
    const p = root.querySelector("p")!;
    const anchor = createAnchor(rangeFromOffsets(p, 4, 9), root);

    root.innerHTML = "<section><p>completely different content</p></section>";
    assignBlockIds(root);

    expect(resolveAnchor(anchor, root)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- anchor`
Expected: FAIL on the repair case (block id lookup misses, no fallback yet).

**Step 3: Update implementation (replace resolveAnchor in anchor.ts)**

```ts
export function resolveAnchor(anchor: Anchor, root: Element): Range | null {
  const block = root.querySelector(
    `[${BLOCK_ID_ATTR}="${anchor.blockId}"]`,
  );

  if (block && anchor.quote) {
    const text = block.textContent ?? "";
    const at = findQuoteOffset(text, anchor.quote);
    if (at !== -1) {
      return rangeFromOffsets(block, at, at + anchor.quote.exact.length);
    }
  }

  // Repair: search every stamped block for the quote.
  if (anchor.quote) {
    const blocks = root.querySelectorAll(`[${BLOCK_ID_ATTR}]`);
    for (const candidate of Array.from(blocks)) {
      const text = candidate.textContent ?? "";
      const at = findQuoteOffset(text, anchor.quote);
      if (at !== -1) {
        return rangeFromOffsets(candidate, at, at + anchor.quote.exact.length);
      }
    }
  }

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- anchor`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/anchor.ts packages/annotation-core/test/anchor.test.ts
git commit -m "anchor repair and loud failure"
```

---

### Task 9: Sink seam and batched send

**Files:**
- Create: `packages/annotation-core/src/sink.ts`
- Test: `packages/annotation-core/test/sink.test.ts`

**Step 1: Write the failing test**

`packages/annotation-core/test/sink.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createAnnotation } from "../src/annotation";
import { MemorySink, sendFeedback } from "../src/sink";

describe("sendFeedback", () => {
  it("delivers a batch to the sink and marks items sent", async () => {
    const sink = new MemorySink();
    const items = [
      createAnnotation({ anchor: { blockId: "b1" }, body: "one" }),
      createAnnotation({ anchor: { blockId: "b2" }, body: "two", target: "human" }),
    ];

    const sent = await sendFeedback(sink, items);

    expect(sink.batches.length).toBe(1);
    expect(sink.batches[0].length).toBe(2);
    expect(sent.every((a) => a.status === "sent")).toBe(true);
    expect(sink.batches[0][1].target).toBe("human");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- sink`
Expected: FAIL, cannot find module `../src/sink`.

**Step 3: Write minimal implementation**

`packages/annotation-core/src/sink.ts`:

```ts
import type { Annotation } from "./types";

export interface SinkAdapter {
  send(batch: Annotation[]): Promise<void>;
}

export class MemorySink implements SinkAdapter {
  batches: Annotation[][] = [];
  async send(batch: Annotation[]): Promise<void> {
    this.batches.push(batch);
  }
}

export async function sendFeedback(
  sink: SinkAdapter,
  items: Annotation[],
): Promise<Annotation[]> {
  const sent = items.map((a) => ({ ...a, status: "sent" as const }));
  await sink.send(sent);
  return sent;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- sink`
Expected: PASS (1 test).

**Step 5: Commit**

```bash
git add packages/annotation-core/src/sink.ts packages/annotation-core/test/sink.test.ts
git commit -m "add sink seam and batched send"
```

---

### Task 10: Public surface and typecheck

**Files:**
- Modify: `packages/annotation-core/src/index.ts`
- Test: re-run the full suite plus typecheck

**Step 1: Write the barrel export**

`packages/annotation-core/src/index.ts`:

```ts
export * from "./types";
export { createAnnotation } from "./annotation";
export { computeBlockId, assignBlockIds, BLOCK_ID_ATTR } from "./blockId";
export { rangeFromOffsets, offsetsFromRange } from "./textOffsets";
export { createAnchor, resolveAnchor } from "./anchor";
export { MemorySink, sendFeedback } from "./sink";
export type { SinkAdapter } from "./sink";
```

**Step 2: Run the whole suite**

Run: `npm test`
Expected: all tests pass.

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

**Step 4: Commit**

```bash
git add packages/annotation-core/src/index.ts
git commit -m "export annotation-core public surface"
```

---

## Done criteria

- `npm test` is green across all files.
- `npm run typecheck` is clean.
- A selection can be turned into an anchor, serialized as plain JSON, and re-resolved after a re-render that changes block ids, with a loud null when the text is truly gone.
- The Sink seam exists so the Orden app can later supply an MCP-backed sink without touching the core.

## Out of scope (later plans)

- Source adapter for live `window.getSelection()` wiring in the app UI.
- The MCP sink that ships batches to a session.
- Rendering md/qmd to HTML with ids injected at render time (this plan stamps an already-rendered tree).
- Annotation thread replies coming back from the agent.

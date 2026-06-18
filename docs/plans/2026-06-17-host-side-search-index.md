# Host-Side Search & Backlink Index Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move page/journal search and backlinks off the browser and onto the host, backed by a real database (SQLite FTS5), so the browser no longer hydrates the entire vault — the prerequisite for large/enterprise vaults.

**Architecture:** A derived SQLite index (`<vaultRoot>/index.db`, via the built-in `node:sqlite`) is maintained host-side. It subscribes to the vault change feed (the single `EmittingVault` chokepoint) and rebuilds from the vault at boot. The web reaches it through a new `SearchService` sub-API on `Host` over the existing RPC. The index is a rebuildable cache; DiskVault JSON stays the source of truth. Link extraction reuses `@orden/outliner` (`extractLinks`/`buildBacklinkIndex`) — no forked logic.

**Tech Stack:** `node:sqlite` (FTS5, no native dep, no cooldown), TypeScript, existing WebSocket JSON-RPC, `@orden/outliner`, vitest.

**Scope:** Single-user now. Multi-user concurrency is **planned, not built** — see "Future: multi-user" at the end. The `SearchService` interface is designed to stay stable when the backing store later swaps to a concurrent DB.

---

## Phase ordering & rationale

Each phase is independently shippable and committed:

- **Phase 0** — Index core (`vaultIndex.ts`) + unit tests. Pure, no wiring.
- **Phase 1** — `SearchService` on `Host`, RPC, NodeHost wiring (boot rebuild + change-feed subscription), BrowserHost fallback.
- **Phase 2** — Web omnisearch calls the host (async command palette).
- **Phase 3** — Backlinks served by the host (journal panel + pages-index counts).
- **Phase 4** — Stop hydrating bodies: lazy per-doc body loads, async editor mount, and move `renamePage` host-side (it currently scans resident bodies). This is the memory payoff and the riskiest phase.

A consumer map (every sync call site that turns async) is in the appendix.

---

## Phase 0 — Index core

### Task 0.1: SQLite index module skeleton + schema

**Files:**
- Create: `apps/host/src/vaultIndex.ts`
- Test: `apps/host/test/vaultIndex.test.ts`

**Schema (created on open if absent):**

```sql
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
-- One FTS row per page/journal entry. ns/created/updated are stored but not tokenized.
CREATE VIRTUAL TABLE IF NOT EXISTS entries
  USING fts5(ns UNINDEXED, name, body, created UNINDEXED, updated UNINDEXED, tokenize='unicode61');
-- One row per outgoing [[link]]; target stored lowercased for case-insensitive backlinks.
CREATE TABLE IF NOT EXISTS links (
  src_ns   TEXT NOT NULL,
  src_name TEXT NOT NULL,
  block_id TEXT NOT NULL,
  text     TEXT NOT NULL,
  target   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_ns, src_name);
```

**Public API (class `VaultIndex`):**

```ts
import { DatabaseSync } from "node:sqlite";
import { fromMarkdown, buildBacklinkIndex } from "@orden/outliner";

export type EntryNs = "pages" | "journal";

export interface SearchHit {
  ns: EntryNs;
  name: string;
  snippet: string;
  score: number; // lower = better (bm25)
}
export interface BacklinkHit {
  pageName: string; // source entry that links to the target
  blockId: string;
  text: string;
}

export class VaultIndex {
  constructor(dbPath: string); // ":memory:" in tests
  upsertEntry(ns: EntryNs, name: string, body: string, created?: string, updated?: string): void;
  removeEntry(ns: EntryNs, name: string): void;
  query(text: string, opts?: { kinds?: EntryNs[]; limit?: number }): SearchHit[];
  backlinks(target: string): BacklinkHit[];
  backlinkCounts(): Record<string, number>; // keyed by lowercased target
  close(): void;
}
```

**Step 1: Write the failing test** (`apps/host/test/vaultIndex.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { VaultIndex } from "../src/vaultIndex";

describe("VaultIndex", () => {
  it("opens an in-memory db and returns no hits for an empty index", () => {
    const idx = new VaultIndex(":memory:");
    expect(idx.query("anything")).toEqual([]);
    idx.close();
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @orden/host exec vitest run test/vaultIndex.test.ts`
Expected: FAIL ("Cannot find module '../src/vaultIndex'").

**Step 3: Minimal implementation** — open `DatabaseSync`, set `db.exec("PRAGMA journal_mode=WAL")`, run the schema DDL, implement `query` returning `[]` for now, `close()`.

**Step 4: Run to verify it passes.**

**Step 5: Commit** — `feat(host): VaultIndex skeleton + sqlite schema`.

---

### Task 0.2: upsert + full-text query

**Step 1: Failing test:**

```ts
it("upserts entries and finds them by body content", () => {
  const idx = new VaultIndex(":memory:");
  idx.upsertEntry("pages", "Design Notes", "- the quick brown fox jumps");
  idx.upsertEntry("pages", "Other", "- nothing relevant here");
  const hits = idx.query("brown");
  expect(hits.map((h) => h.name)).toEqual(["Design Notes"]);
  expect(hits[0].snippet).toContain("brown");
  idx.close();
});

it("matches page names too, and re-upsert replaces the old row", () => {
  const idx = new VaultIndex(":memory:");
  idx.upsertEntry("pages", "Roadmap", "- v1");
  expect(idx.query("roadmap").map((h) => h.name)).toEqual(["Roadmap"]);
  idx.upsertEntry("pages", "Roadmap", "- v2 totally different");
  expect(idx.query("v1")).toEqual([]); // old body gone
  expect(idx.query("different").map((h) => h.name)).toEqual(["Roadmap"]);
  idx.close();
});

it("respects the kinds filter", () => {
  const idx = new VaultIndex(":memory:");
  idx.upsertEntry("pages", "P", "- shared word");
  idx.upsertEntry("journal", "2026-06-17", "- shared word");
  expect(idx.query("shared", { kinds: ["journal"] }).map((h) => h.name)).toEqual(["2026-06-17"]);
  idx.close();
});
```

**Step 3: Implementation notes:**
- `upsertEntry`: in a transaction — `DELETE FROM entries WHERE ns=? AND name=?`, `INSERT INTO entries(...)`, then re-extract links (Task 0.3).
- `query`: build a safe FTS match string — split `text` on whitespace, drop empties, wrap each token in double quotes and append `*` for prefix: `"foo"* "bar"*`. If no tokens, return `[]`.
  - SQL: `SELECT ns, name, snippet(entries, 2, '[', ']', '…', 10) AS snippet, bm25(entries) AS score FROM entries WHERE entries MATCH ? [AND ns IN (...)] ORDER BY score LIMIT ?` (default limit 50).
  - Map rows to `SearchHit`.

**Step 5: Commit** — `feat(host): VaultIndex upsert + FTS query`.

---

### Task 0.3: link extraction + backlinks (reuse @orden/outliner)

**Step 1: Failing test:**

```ts
it("indexes outgoing links and answers backlinks case-insensitively", () => {
  const idx = new VaultIndex(":memory:");
  idx.upsertEntry("pages", "Source", "- see [[Target]] and [[ target ]] again");
  idx.upsertEntry("journal", "2026-06-17", "- jotted [[TARGET]]");
  const bl = idx.backlinks("target");
  const sources = bl.map((b) => b.pageName).sort();
  expect(sources).toEqual(["2026-06-17", "Source"]);
  idx.close();
});

it("backlinkCounts groups by lowercased target", () => {
  const idx = new VaultIndex(":memory:");
  idx.upsertEntry("pages", "A", "- [[Topic]]");
  idx.upsertEntry("pages", "B", "- [[topic]]");
  expect(idx.backlinkCounts()["topic"]).toBe(2);
  idx.close();
});

it("re-upsert refreshes a source's outgoing links", () => {
  const idx = new VaultIndex(":memory:");
  idx.upsertEntry("pages", "S", "- [[Old]]");
  expect(idx.backlinks("old")).toHaveLength(1);
  idx.upsertEntry("pages", "S", "- [[New]] only");
  expect(idx.backlinks("old")).toHaveLength(0);
  expect(idx.backlinks("new")).toHaveLength(1);
  idx.close();
});
```

**Step 3: Implementation** — inside `upsertEntry`, after writing the FTS row:
```ts
this.db.prepare("DELETE FROM links WHERE src_ns=? AND src_name=?").run(ns, name);
const outgoing = buildBacklinkIndex([{ name, root: fromMarkdown(body) }]);
const ins = this.db.prepare(
  "INSERT INTO links(src_ns, src_name, block_id, text, target) VALUES (?,?,?,?,?)",
);
for (const [target, refs] of Object.entries(outgoing)) {
  for (const r of refs) ins.run(ns, name, r.blockId, r.text, target.toLowerCase());
}
```
- `backlinks(target)`: `SELECT src_name AS pageName, block_id AS blockId, text FROM links WHERE target=?` with `target.toLowerCase()`.
- `backlinkCounts()`: `SELECT target, COUNT(*) c FROM links GROUP BY target` → object.
- `removeEntry`: delete from both `entries` and `links`.

**Step 5: Commit** — `feat(host): VaultIndex link indexing + backlinks`.

---

### Task 0.4: rebuild-from-vault + version guard

**Step 1: Failing test** (uses a fake `VaultStore`):

```ts
import type { VaultStore } from "@orden/host-api";

function fakeVault(data: Record<string, Record<string, string>>): VaultStore {
  return {
    async get(ns, key) { return (data[ns]?.[key] as never) ?? null; },
    async set(ns, key, v) { (data[ns] ??= {})[key] = v as string; },
    async list(ns) { return Object.keys(data[ns] ?? {}); },
    async delete(ns, key) { delete data[ns]?.[key]; },
  };
}

it("rebuilds the index from a vault snapshot", async () => {
  const vault = fakeVault({
    pages: { "Design": "- [[Target]] content", "Target": "- hi" },
    journal: { "2026-06-17": "- a day" },
    pagemeta: { Design: JSON.stringify({ created: "2026-06-01T00:00:00Z", updated: "2026-06-10T00:00:00Z" }) },
  });
  const idx = new VaultIndex(":memory:");
  await idx.rebuildFrom(vault);
  expect(idx.query("content").map((h) => h.name)).toEqual(["Design"]);
  expect(idx.query("day", { kinds: ["journal"] }).map((h) => h.name)).toEqual(["2026-06-17"]);
  expect(idx.backlinks("target").map((b) => b.pageName)).toEqual(["Design"]);
  idx.close();
});
```

**Step 3: Implementation** — add `async rebuildFrom(vault: VaultStore): Promise<void>`:
- `DELETE FROM entries; DELETE FROM links;` (wrap whole rebuild in one transaction).
- For `ns of ["pages", "journal"]`: `list(ns)`, for each key `get<string>(ns, key)`, read matching `pagemeta` for created/updated, `upsertEntry`.
- Store `meta` schema version `SCHEMA_VERSION = 1`. On construct, if stored version mismatches (or db newly created), the caller triggers a rebuild. Expose `needsRebuild(): boolean`.

**Step 5: Commit** — `feat(host): VaultIndex.rebuildFrom + schema version`.

---

## Phase 1 — Host wiring (SearchService + RPC + boot)

### Task 1.1: `SearchService` on the Host interface

**Files:**
- Modify: `packages/host-api/src/index.ts`

Add (near `VaultStore`):
```ts
export type SearchEntryNs = "pages" | "journal";
export interface SearchHit { ns: SearchEntryNs; name: string; snippet: string; score: number; }
export interface BacklinkHit { pageName: string; blockId: string; text: string; }
export interface SearchService {
  query(text: string, opts?: { kinds?: SearchEntryNs[]; limit?: number }): Promise<SearchHit[]>;
  backlinks(target: string): Promise<BacklinkHit[]>;
  backlinkCounts(): Promise<Record<string, number>>;
}
```
Add to `Host`: `search?: SearchService;` and to `HostCapabilities`: `search?: boolean;`.

**Test:** `pnpm -r typecheck` (interface-only). **Commit** — `feat(host-api): SearchService interface`.

---

### Task 1.2: register `search` in RPC capabilities

**Files:**
- Modify: `apps/host/src/rpc.ts:26-35` (the `CAPABILITIES` array) — add `"search"`.
- Test: `apps/host/test/rpc.test.ts` (extend existing if present, else create).

**Step 1: Failing test** — dispatch a `["search","query"]` call against a stub host whose `search.query` returns a known array; assert it round-trips. Also assert `["search","query"]` against a host with no `search` throws "unknown capability: search".

**Step 3:** add `"search"` to `CAPABILITIES`. (Dispatch + `capProxy` are already generic — verified.)

**Commit** — `feat(host): expose search over RPC`.

---

### Task 1.3: `NodeSearchService` + boot rebuild + change-feed subscription

**Files:**
- Modify: `apps/host/src/nodeHost.ts` (construct `search`, expose in capabilities)
- Create: `apps/host/src/searchService.ts` (`NodeSearchService` wrapping `VaultIndex` + the indexer subscription)
- Modify: `apps/host/src/serve.ts` (kick off boot rebuild + subscribe — or do it inside NodeHost; see note)
- Test: `apps/host/test/searchService.test.ts`

**Design:**
- `NodeSearchService` holds a `VaultIndex` (at `join(vaultRoot, "index.db")`), implements the async `SearchService` by delegating to the synchronous index methods (wrap in `async`).
- An `attachIndexer(host, index)` helper subscribes: `host.onChange((c) => { if (c.ns !== "pages" && c.ns !== "journal" && c.ns !== "pagemeta") return; ... })`. On a `pages`/`journal` change: read `vault.get(ns,key)`; if null → `removeEntry`, else `upsertEntry` (with timestamps from pagemeta). On a `pagemeta` change: re-`upsertEntry` for the matching entry to refresh `created/updated` (look it up in whichever store holds it).
- Boot: in `serve.ts` after `new NodeHost(...)`, if `index.needsRebuild()` call `await index.rebuildFrom(host.vault)`, then `attachIndexer`. Index writes happen outside any WS origin scope, so they broadcast normally (no self-echo issue — and the index isn't a vault ns, so it produces no `onChange` of its own).

**Step 1: Failing test** (integration over a real `NodeHost` with a temp vault dir + `:memory:`? — use a temp dir db): write two pages via `host.vault.set`, allow the subscription to run, assert `host.search.query` and `host.search.backlinks` reflect them; delete one, assert it drops out.

**Note on async timing:** the indexer runs synchronously inside the `onChange` callback (index methods are sync), so after `await host.vault.set(...)` resolves and the change has fired, the index is current. Confirm `EmittingVault.set` fires `onChange` synchronously after the inner write resolves.

**Commit** — `feat(host): NodeSearchService + live indexer + boot rebuild`.

---

### Task 1.4: BrowserHost fallback

**Files:**
- Modify: `apps/web/src/host/browserHost.ts`
- Test: `apps/web/test/browserHost.test.ts` (extend)

The pure-web host has no Node/SQLite. Implement `LocalSearch` that scans the browser-backed vault on demand (it already has all entries in browser storage; scale isn't a concern there). Reuse `extractLinks`/`buildBacklinkIndex` and a simple substring/snippet match — effectively today's logic behind the new interface. Set `capabilities().search = true` for BrowserHost too (it *can* search, just not via SQLite).

**Step 1: Failing test** — seed the browser vault, assert `host.search.query`/`backlinks` work.

**Commit** — `feat(web): BrowserHost in-memory SearchService fallback`.

---

## Phase 2 — Web omnisearch via host

### Task 2.1: make command-palette sources async

**Files:**
- Modify: `apps/web/src/commandPalette.ts` (the `SearchSource` type + `update()` dispatcher)
- Test: `apps/web/test/commandPalette.test.ts` (extend)

**Changes:**
- `SearchSource.search: (q: string) => PaletteItem[] | Promise<PaletteItem[]>`.
- `update()` becomes async: snapshot a per-keystroke token; `await Promise.all(sources.map(s => Promise.resolve(s.search(q))))`; if the token is stale (a newer keystroke arrived) discard the result; else render. Debounce input ~120ms before dispatching async sources (sync sources can still render immediately for snappy nav — optional: render sync sources first, then fill async).
- Keep a "Searching…" affordance only if results are pending > ~200ms (avoid flicker).

**Step 1: Failing test** — a source returning a Promise resolves into the rendered group; a stale query's late result is ignored.

**Commit** — `feat(web): async command-palette sources`.

---

### Task 2.2: point pages/journal omnisearch at the host

**Files:**
- Modify: `apps/web/src/main.ts:2431-2464` (the `pages` and `journal` `searchSources`)

Replace the body-scan sources with host calls:
```ts
{
  id: "pages", label: "Pages",
  search: async (q) => {
    if (!q) return pagesIndex().map(/* name-only, as today */);
    const hits = await host.search.query(q, { kinds: ["pages"] });
    return hits.map((h) => ({ id: `page:${h.name}`, title: h.name, subtitle: h.snippet, open: () => openPage(h.name) }));
  },
},
// journal source mirrors with kinds: ["journal"]
```
- Empty-query behavior keeps listing names from the (still-resident) name list.
- Remove the now-unused `getPageMarkdown` body scans + client `snippet()` for these sources.

**Manual verify:** rebuild dist, run host, search a word that only appears in a page body — it appears.

**Commit** — `feat(web): omnisearch pages/journal via host`.

---

## Phase 3 — Backlinks via host

### Task 3.1: async `backlinksTo` + count batch

**Files:**
- Modify: `apps/web/src/pages.ts` (`backlinksTo` → async host call; add `backlinkCounts()` passthrough)
- Modify: `apps/web/src/journal.ts` (`renderBacklinks` awaits)
- Modify: `apps/web/src/pagesIndex.ts` (counts via one batch call)
- Test: extend `apps/web/test/pages.test.ts`

**Changes:**
- `export async function backlinksTo(name): Promise<BacklinkHit[]>` → `host.search.backlinks(name)`.
- `renderBacklinks(el, name)` becomes async: render a placeholder, await, then fill. Called from `showPage` (fire-and-forget the fill; don't block page render).
- `renderPagesIndex`: fetch `await host.search.backlinkCounts()` once before the row loop; look up `counts[name.toLowerCase()] ?? 0` per row. Make `renderPagesIndex` async (its callers in `main.ts` are already in async contexts).

**Commit** — `feat(web): backlinks + counts from host`.

---

## Phase 4 — Stop hydrating bodies (memory payoff)

> Riskiest phase. Touches editor mount + the just-shipped rename. Do last; ship Phases 1-3 first.

### Task 4.1: lazy body access

**Files:** `apps/web/src/pages.ts`

- `hydratePages`: load **names + pagemeta only** (drop `loadNs` body reads). Keep `pageNames/pagesIndex/journalDates/journalIndex` synchronous over the name+meta caches.
- Replace `getPageMarkdown(name): string` with `async getPageBody(name): Promise<string>` → `host.vault.get<string>(ns, canonicalKey(name)) ?? ""`. Keep a tiny LRU (e.g. last 8 bodies) so re-render of the open doc doesn't refetch.
- `setPageMarkdown` keeps write-through but also updates name/meta caches + LRU.

### Task 4.2: async editor mount

**Files:** `apps/web/src/outlineEditor.ts`, `apps/web/src/journal.ts`

- `makeOutlineEditor` takes the body as an argument (caller fetches it) **or** becomes async. Prefer: caller awaits `getPageBody(name)` then passes it in — keeps the editor constructor synchronous.
- `journal.showPage` / `dayChunk` (feed) await `getPageBody` before mounting each editor. The feed already lazy-loads in batches of 5; await per chunk.

### Task 4.3: move `renamePage` host-side

**Files:** `packages/host-api/src/index.ts`, `apps/host/src/nodeHost.ts`, `apps/web/src/pages.ts`, `apps/web/src/main.ts`

- The current `renamePage` scans resident bodies — broken once bodies aren't hydrated. Add a host method (e.g. `host.search.rename(oldName, newName)` is the wrong home; use a small `pages` host op or extend the vault). Recommended: a top-level `Host.renamePage?(oldName, newName): Promise<RenameResult>` implemented in NodeHost — it does the re-key + find/replace over the vault **locally** (no per-entry RPC) and the indexer picks up the writes via the change feed.
- Web `renamePage` becomes an async passthrough; the journal title-commit handler awaits it.
- Port the existing rename tests to the host (`apps/host/test/renamePage.test.ts`); keep a thin web test that the title-commit calls the host.

### Task 4.4: drop the now-dead client paths

Remove client `backlinksTo` markdown reconstruction, the body caches, and any now-unused imports. Confirm `pnpm -r typecheck` + full suites pass. Rebuild dist; manual smoke: open a page (loads body), search, backlinks, rename — all work with no full hydration.

**Commit per task** — `feat(web): lazy bodies`, `feat(web): async editor mount`, `feat(host): host-side renamePage`, `chore(web): drop resident body caches`.

---

## Future: multi-user (PLAN ONLY — do not build now)

Recorded so the single-user build doesn't paint us into a corner:

- **Source-of-truth concurrency.** Today DiskVault (JSON files) + one host process is the only writer. Multi-user needs concurrent writers → migrate the vault source of truth to a transactional DB (e.g. Postgres, or SQLite-WAL behind a single server). The `VaultStore` interface already abstracts this; a new implementation swaps in without touching consumers.
- **Tenant/user scoping.** `SearchService` methods will gain a `scope` (user/tenant/workspace) argument and the index gains `tenant` columns + composite keys. Keep the interface small now; add the param when the auth model lands rather than speculatively.
- **Index ownership.** The derived SQLite index stays valid in multi-user as a per-tenant index or a shared index with tenant filters; it remains rebuildable from the source DB.
- **Auth/access control** is a separate workstream, not blocked by this and not addressed here.

The deliberate seam: web depends only on `Host.search` + `Host.vault`; swapping the backing store is a host-internal change.

---

## Appendix: consumer map (sync → async)

Call sites that assume resident bodies / sync access (from the seam analysis):

| File | Site | Today | After |
|---|---|---|---|
| `apps/web/src/main.ts:2431-2464` | omnisearch pages/journal | sync body scan | async `host.search.query` (P2) |
| `apps/web/src/journal.ts` `renderBacklinks` | backlinks panel | sync `backlinksTo` | async host backlinks (P3) |
| `apps/web/src/pagesIndex.ts:59` | per-row backlink count | sync `backlinksTo().length` | batch `backlinkCounts()` (P3) |
| `apps/web/src/outlineEditor.ts:32` | editor init | sync `getPageMarkdown` | awaited body, passed in (P4) |
| `apps/web/src/journal.ts` feed/`showPage` | mount editors | sync bodies | await `getPageBody` (P4) |
| `apps/web/src/pages.ts` `renamePage` | rename scan | sync resident scan | host-side rename (P4) |
| `apps/web/src/pages.ts` `hydratePages` | boot | loads all bodies | names+meta only (P4) |

Sources that stay client-side & sync: `nav`, `projects`, `cards`, `files`, and page/journal **name** listings (names+meta remain cheap and resident).

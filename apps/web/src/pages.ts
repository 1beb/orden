// Page store backed by the host vault. TWO stores, one predicate apart:
// knowledge "pages" (a Confluence-like base of named markdown outlines) live in
// the "pages" ns; personal journal day-pages, keyed by ISO date, live in the
// "journal" ns. `isJournalKey` is the ONLY place the two are told apart — every
// accessor routes through it, so a journal entry can't structurally leak into a
// page listing (and vice versa). [[wiki links]] still cross both for backlinks.
//
// Bodies are NOT hydrated — only the page/journal NAME lists and their sidecar
// metadata stay resident (both cheap), so the browser never holds the whole
// vault. Body content is fetched on demand via the async getPageBody (with a
// small LRU so re-rendering the open doc doesn't refetch); search, backlinks,
// and rename are served host-side. Name/meta accessors stay synchronous.
import type { BacklinkHit, Host, RenameResult } from "@orden/host-api";

export type { RenameResult };

// Per-page timestamps, stored in a sidecar vault ns ("pagemeta") so the page
// value itself stays a plain markdown string (consumed directly by the outliner).
// Shared across both stores — names never collide (a date vs a wiki name).
export interface PageMeta {
  created: string; // ISO
  updated: string; // ISO
}

export interface PageInfo {
  name: string;
  created?: string;
  updated?: string;
}

let host: Host | null = null;
// Resident NAME lists (canonical casing) — not bodies. Drive every listing and
// case-insensitive name resolution.
let pageNameSet = new Set<string>();
let journalNameSet = new Set<string>();
let metaCache: Record<string, PageMeta> = {};

// A tiny LRU of recently-read bodies, keyed by `${ns}:${key}`. Re-rendering the
// open doc (a focus-guarded vault-change refresh, say) reads from here instead
// of round-tripping the host; writes refresh it so it never goes stale.
const BODY_LRU_MAX = 8;
const bodyLru = new Map<string, string>();

function bodyKey(ns: string, key: string): string {
  return `${ns}:${key}`;
}
function lruGet(k: string): string | undefined {
  const v = bodyLru.get(k);
  if (v !== undefined) {
    bodyLru.delete(k); // re-insert to mark most-recently-used
    bodyLru.set(k, v);
  }
  return v;
}
function lruSet(k: string, v: string): void {
  bodyLru.delete(k);
  bodyLru.set(k, v);
  while (bodyLru.size > BODY_LRU_MAX) {
    const oldest = bodyLru.keys().next().value as string;
    bodyLru.delete(oldest);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A journal entry is a day-page keyed by ISO date (e.g. "2026-06-15"). This
// single predicate decides which store a name belongs to.
export function isJournalKey(name: string): boolean {
  return ISO_DATE.test(name);
}

// Journal pages are keyed by their ISO date — use that as a creation fallback for
// pages predating the metadata sidecar (so they still sort sensibly). No "Z": the
// date is meant as that local calendar day, so it must render as the same day in
// the viewer's timezone (a UTC-midnight stamp would slip to the day before).
function dateFallback(name: string): string | undefined {
  return ISO_DATE.test(name) ? `${name}T00:00:00` : undefined;
}

// One-time, idempotent: journal day-pages used to live in the "pages" ns. Move
// any ISO-date keys to the "journal" ns (never clobbering newer journal content)
// so the two stores are physically separate. After the first run "pages" holds
// no date keys, so the loop body is skipped and this is a cheap no-op.
async function migrateJournalOut(h: Host): Promise<void> {
  const names = await h.vault.list("pages");
  for (const n of names) {
    if (!isJournalKey(n)) continue;
    const already = await h.vault.get<string>("journal", n);
    if (already == null) {
      await h.vault.set("journal", n, (await h.vault.get<string>("pages", n)) ?? "");
    }
    await h.vault.delete("pages", n);
  }
}

export async function hydratePages(h: Host): Promise<void> {
  host = h;
  await migrateJournalOut(h);

  // Names + metadata only — bodies stay on the host until requested.
  pageNameSet = new Set(await h.vault.list("pages"));
  journalNameSet = new Set(await h.vault.list("journal"));
  bodyLru.clear();

  const metaNames = await h.vault.list("pagemeta");
  const metaEntries = await Promise.all(
    metaNames.map(async (n) => [n, await h.vault.get<PageMeta>("pagemeta", n)] as const),
  );
  metaCache = Object.fromEntries(metaEntries.filter(([, m]) => m !== null)) as Record<string, PageMeta>;
}

// Page names are case-insensitive for lookup but stored with their canonical
// (first-written) casing, so [[agentnote]] resolves to an existing "AgentNote"
// rather than spawning a duplicate lowercase page. Returns the existing name
// matching `name` case-insensitively, else `name` unchanged. Journal keys are
// exact ISO dates — no casing to resolve, so they pass through.
function canonicalKey(name: string): string {
  if (isJournalKey(name) || pageNameSet.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of pageNameSet) {
    if (key.toLowerCase() === lower) return key;
  }
  return name;
}

// Fetch a page/journal body on demand. Resolves casing like the name accessors,
// routes to the store the name belongs to, and caches the result in the LRU.
export async function getPageBody(name: string): Promise<string> {
  const journal = isJournalKey(name);
  const ns = journal ? "journal" : "pages";
  const key = canonicalKey(name);
  const lk = bodyKey(ns, key);
  const cached = lruGet(lk);
  if (cached !== undefined) return cached;
  const body = (host ? await host.vault.get<string>(ns, key) : null) ?? "";
  lruSet(lk, body);
  return body;
}

export function setPageMarkdown(name: string, markdown: string): void {
  const journal = isJournalKey(name);
  const ns = journal ? "journal" : "pages";
  const names = journal ? journalNameSet : pageNameSet;
  const key = canonicalKey(name);
  const isNew = !names.has(key);
  names.add(key);
  lruSet(bodyKey(ns, key), markdown);
  if (host) void host.vault.set(ns, key, markdown);

  const now = new Date().toISOString();
  const prev = metaCache[key];
  const meta: PageMeta = {
    created: prev?.created ?? dateFallback(key) ?? now,
    updated: now,
  };
  metaCache[key] = meta;
  if (host && (isNew || !prev || prev.updated !== meta.updated)) {
    void host.vault.set("pagemeta", key, meta);
  }
}

// Remove a page (and its sidecar metadata) from the resident name list + LRU and
// write the deletion through to the vault. Resolves casing like the accessors and
// routes to the store the name belongs to.
export function deletePage(name: string): void {
  const journal = isJournalKey(name);
  const ns = journal ? "journal" : "pages";
  const names = journal ? journalNameSet : pageNameSet;
  const key = canonicalKey(name);
  names.delete(key);
  delete metaCache[key];
  bodyLru.delete(bodyKey(ns, key));
  if (host) {
    void host.vault.delete(ns, key);
    void host.vault.delete("pagemeta", key);
  }
}

// Rename a knowledge page and rewrite every [[OldName]] reference (across all
// pages AND journal entries) to [[NewName]]. The vault re-key + backlink rewrite
// runs HOST-SIDE (it can't scan resident bodies any more — they aren't loaded);
// the host's writes don't echo back to this client, so we mirror the rename in
// the resident name/meta caches and drop the body LRU (other entries may have
// had references rewritten) so the next render fetches fresh.
export async function renamePage(oldName: string, newName: string): Promise<RenameResult> {
  if (!host?.renamePage) return { ok: false, reason: "This page can't be renamed." };
  const oldKey = canonicalKey(oldName);
  const trimmed = newName.trim();
  const result = await host.renamePage(oldKey, trimmed);
  if (result.ok && trimmed !== oldKey) {
    pageNameSet.delete(oldKey);
    pageNameSet.add(trimmed);
    const meta = metaCache[oldKey];
    if (meta) {
      delete metaCache[oldKey];
      metaCache[trimmed] = meta;
    }
    bodyLru.clear();
  }
  return result;
}

// Knowledge-page names (excludes journal day-pages, which live in their own
// store — see journalDates).
export function pageNames(): string[] {
  return [...pageNameSet].sort();
}

// Journal day-page keys (ISO dates) — drives the journal feed.
export function journalDates(): string[] {
  return [...journalNameSet].sort();
}

// Derived pages that live in the "pages" ns but aren't standalone wiki pages:
// per-card narratives (`card:<id>`) and project notes (`notes:<id>`). They stay
// readable, [[linkable]], and backlinkable — they're just reached through the
// card modal / project page, so the Pages index omits them as noise.
const INTERNAL_PAGE_PREFIX = /^(card|notes):/;

function toInfo(name: string): PageInfo {
  const m = metaCache[name];
  return {
    name,
    created: m?.created ?? dateFallback(name),
    updated: m?.updated ?? m?.created ?? dateFallback(name),
  };
}

// Knowledge pages with their timestamps, newest activity first (most recently
// updated, then created). Drives the Pages index; excludes the derived
// card:/notes: pages and — by store — all journal day-pages.
export function pagesIndex(): PageInfo[] {
  return [...pageNameSet]
    .filter((name) => !INTERNAL_PAGE_PREFIX.test(name))
    .map(toInfo)
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

// Journal day-pages with their timestamps, newest first. Kept out of the Pages
// index; used for searching the personal journal.
export function journalIndex(): PageInfo[] {
  return [...journalNameSet]
    .map(toInfo)
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

// Which blocks across all pages AND journal entries reference `name`, so jotting
// [[AI Suspects]] in today's journal still backlinks the page. Served by the
// host's link index (case-insensitive) rather than scanning resident bodies.
export async function backlinksTo(name: string): Promise<BacklinkHit[]> {
  // Gate on the CAPABILITY flag, not `host.search` truthiness: the RPC client
  // attaches a `search` proxy for every capability name, so over a NodeHost that
  // lacks search the proxy is present but every call throws "unknown capability:
  // search". capabilities().search is the real contract (host-api index.ts).
  if (!host?.search || !host.capabilities().search) return [];
  return host.search.backlinks(name);
}

// Backlink counts for every linked target (keyed by lowercased target), in one
// host call — the Pages index badges each row from this map instead of a
// per-row scan.
export async function backlinkCounts(): Promise<Record<string, number>> {
  if (!host?.search || !host.capabilities().search) return {};
  return host.search.backlinkCounts();
}

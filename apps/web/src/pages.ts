// Page store backed by the host vault. TWO stores, one predicate apart:
// knowledge "pages" (a Confluence-like base of named markdown outlines) live in
// the "pages" ns; personal journal day-pages, keyed by ISO date, live in the
// "journal" ns. `isJournalKey` is the ONLY place the two are told apart — every
// accessor routes through it, so a journal entry can't structurally leak into a
// page listing (and vice versa). [[wiki links]] still cross both for backlinks.
// Accessors stay synchronous over caches hydrated at boot; writes write through.
import type { BacklinkHit, Host } from "@orden/host-api";

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
let pageCache: Record<string, string> = {};
let journalCache: Record<string, string> = {};
let metaCache: Record<string, PageMeta> = {};

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

  const loadNs = async (ns: string): Promise<Record<string, string>> => {
    const names = await h.vault.list(ns);
    const entries = await Promise.all(
      names.map(async (n) => [n, (await h.vault.get<string>(ns, n)) ?? ""] as const),
    );
    return Object.fromEntries(entries);
  };
  pageCache = await loadNs("pages");
  journalCache = await loadNs("journal");

  const metaNames = await h.vault.list("pagemeta");
  const metaEntries = await Promise.all(
    metaNames.map(async (n) => [n, await h.vault.get<PageMeta>("pagemeta", n)] as const),
  );
  metaCache = Object.fromEntries(metaEntries.filter(([, m]) => m !== null)) as Record<string, PageMeta>;
}

// Page names are case-insensitive for lookup but stored with their canonical
// (first-written) casing, so [[agentnote]] resolves to an existing "AgentNote"
// rather than spawning a duplicate lowercase page. Returns the existing cache
// key matching `name` case-insensitively, else `name` unchanged. Journal keys
// are exact ISO dates — no casing to resolve, so they pass through.
function canonicalKey(name: string): string {
  if (isJournalKey(name) || name in pageCache) return name;
  const lower = name.toLowerCase();
  for (const key of Object.keys(pageCache)) {
    if (key.toLowerCase() === lower) return key;
  }
  return name;
}

export function getPageMarkdown(name: string): string {
  if (isJournalKey(name)) return journalCache[name] ?? "";
  return pageCache[canonicalKey(name)] ?? "";
}

export function setPageMarkdown(name: string, markdown: string): void {
  const journal = isJournalKey(name);
  const ns = journal ? "journal" : "pages";
  const cache = journal ? journalCache : pageCache;
  const key = canonicalKey(name);
  const isNew = !(key in cache);
  cache[key] = markdown;
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

// Remove a page (and its sidecar metadata) from the cache and write the
// deletion through to the vault. Resolves casing like the accessors and routes
// to the store the name belongs to.
export function deletePage(name: string): void {
  const journal = isJournalKey(name);
  const ns = journal ? "journal" : "pages";
  const cache = journal ? journalCache : pageCache;
  const key = canonicalKey(name);
  delete cache[key];
  delete metaCache[key];
  if (host) {
    void host.vault.delete(ns, key);
    void host.vault.delete("pagemeta", key);
  }
}

export type RenameResult = { ok: true } | { ok: false; reason: string };

// Escape a string for literal use inside a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rename a knowledge page and rewrite every [[OldName]] reference (across all
// pages AND journal entries) to [[NewName]]. Vault-side: re-keys the page body +
// metadata and writes back only the entries whose text actually changed, so an
// unrelated journal entry is scanned (cheap, in-memory) but never re-written.
// Knowledge pages only — refuses to turn a page into a journal date or an
// internal card:/notes: key. Collisions are blocked (case-insensitive), but a
// pure re-casing of the page's own name (e.g. "notes" -> "Notes") is allowed.
export function renamePage(oldName: string, newName: string): RenameResult {
  const trimmed = newName.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Name can't be empty." };

  const oldKey = canonicalKey(oldName);
  if (isJournalKey(oldKey) || INTERNAL_PAGE_PREFIX.test(oldKey) || !(oldKey in pageCache)) {
    return { ok: false, reason: "This page can't be renamed." };
  }
  if (isJournalKey(trimmed)) return { ok: false, reason: "A page name can't be a date." };
  if (INTERNAL_PAGE_PREFIX.test(trimmed)) return { ok: false, reason: "That name is reserved." };

  // Exact same key (incl. casing) — nothing to do.
  if (trimmed === oldKey) return { ok: true };

  // Collision: another page already uses this name case-insensitively. A page
  // re-casing its own name (same lowercase) passes through.
  const lower = trimmed.toLowerCase();
  for (const key of Object.keys(pageCache)) {
    if (key === oldKey) continue;
    if (key.toLowerCase() === lower) return { ok: false, reason: `A page named "${key}" already exists.` };
  }

  // Re-key the body + metadata. Metadata is carried unchanged (a rename isn't a
  // content edit, so the page keeps its place in the activity-sorted index).
  const body = pageCache[oldKey] ?? "";
  const meta = metaCache[oldKey];
  delete pageCache[oldKey];
  pageCache[trimmed] = body;
  if (meta) {
    delete metaCache[oldKey];
    metaCache[trimmed] = meta;
  }
  if (host) {
    void host.vault.set("pages", trimmed, body);
    void host.vault.delete("pages", oldKey);
    if (meta) {
      void host.vault.set("pagemeta", trimmed, meta);
      void host.vault.delete("pagemeta", oldKey);
    }
  }

  // Rewrite [[oldKey]] -> [[trimmed]] everywhere, whitespace-tolerant and
  // case-insensitive (so [[ oldname ]] is caught too). Only changed entries are
  // written through; the renamed page's own body (now under trimmed) is included,
  // so a self-reference updates as well.
  const linkRe = new RegExp(`\\[\\[\\s*${escapeRegExp(oldKey)}\\s*\\]\\]`, "gi");
  const replacement = `[[${trimmed}]]`;
  const rewriteStore = (cache: Record<string, string>, ns: string): void => {
    for (const [name, md] of Object.entries(cache)) {
      const next = md.replace(linkRe, replacement);
      if (next !== md) {
        cache[name] = next;
        if (host) void host.vault.set(ns, name, next);
      }
    }
  };
  rewriteStore(pageCache, "pages");
  rewriteStore(journalCache, "journal");

  return { ok: true };
}

// Knowledge-page names (excludes journal day-pages, which live in their own
// store — see journalDates).
export function pageNames(): string[] {
  return Object.keys(pageCache).sort();
}

// Journal day-page keys (ISO dates) — drives the journal feed.
export function journalDates(): string[] {
  return Object.keys(journalCache).sort();
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
  return Object.keys(pageCache)
    .filter((name) => !INTERNAL_PAGE_PREFIX.test(name))
    .map(toInfo)
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

// Journal day-pages with their timestamps, newest first. Kept out of the Pages
// index; used for searching the personal journal.
export function journalIndex(): PageInfo[] {
  return Object.keys(journalCache)
    .map(toInfo)
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

// Which blocks across all pages AND journal entries reference `name`, so jotting
// [[AI Suspects]] in today's journal still backlinks the page. Served by the
// host's link index (case-insensitive) rather than scanning resident bodies.
export async function backlinksTo(name: string): Promise<BacklinkHit[]> {
  if (!host?.search) return [];
  return host.search.backlinks(name);
}

// Backlink counts for every linked target (keyed by lowercased target), in one
// host call — the Pages index badges each row from this map instead of a
// per-row scan.
export async function backlinkCounts(): Promise<Record<string, number>> {
  if (!host?.search) return {};
  return host.search.backlinkCounts();
}

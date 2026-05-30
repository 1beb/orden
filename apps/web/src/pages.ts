// Page store backed by the host vault (ns "pages", one key per page name). A
// page is a named markdown outline; journal pages are keyed by ISO date.
// [[wiki links]] across pages drive navigation + backlinks. Accessors stay
// synchronous over a cache hydrated at boot; setPageMarkdown writes through.
import { fromMarkdown, buildBacklinkIndex, type Page } from "@orden/outliner";
import type { Host } from "@orden/host-api";

// Per-page timestamps, stored in a sidecar vault ns ("pagemeta") so the page
// value itself stays a plain markdown string (consumed directly by the outliner).
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
let cache: Record<string, string> = {};
let metaCache: Record<string, PageMeta> = {};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Journal pages are keyed by their ISO date — use that as a creation fallback for
// pages predating the metadata sidecar (so they still sort sensibly). No "Z": the
// date is meant as that local calendar day, so it must render as the same day in
// the viewer's timezone (a UTC-midnight stamp would slip to the day before).
function dateFallback(name: string): string | undefined {
  return ISO_DATE.test(name) ? `${name}T00:00:00` : undefined;
}

export async function hydratePages(h: Host): Promise<void> {
  host = h;
  const names = await h.vault.list("pages");
  const entries = await Promise.all(
    names.map(async (n) => [n, (await h.vault.get<string>("pages", n)) ?? ""] as const),
  );
  cache = Object.fromEntries(entries);

  const metaNames = await h.vault.list("pagemeta");
  const metaEntries = await Promise.all(
    metaNames.map(async (n) => [n, await h.vault.get<PageMeta>("pagemeta", n)] as const),
  );
  metaCache = Object.fromEntries(metaEntries.filter(([, m]) => m !== null)) as Record<string, PageMeta>;
}

export function getPageMarkdown(name: string): string {
  return cache[name] ?? "";
}

export function setPageMarkdown(name: string, markdown: string): void {
  const isNew = !(name in cache);
  cache[name] = markdown;
  if (host) void host.vault.set("pages", name, markdown);

  const now = new Date().toISOString();
  const prev = metaCache[name];
  const meta: PageMeta = {
    created: prev?.created ?? dateFallback(name) ?? now,
    updated: now,
  };
  metaCache[name] = meta;
  if (host && (isNew || !prev || prev.updated !== meta.updated)) {
    void host.vault.set("pagemeta", name, meta);
  }
}

export function pageNames(): string[] {
  return Object.keys(cache).sort();
}

// All pages with their timestamps, newest activity first (most recently updated,
// then created). Drives the Pages index.
export function pagesIndex(): PageInfo[] {
  return Object.keys(cache)
    .map((name) => {
      const m = metaCache[name];
      return {
        name,
        created: m?.created ?? dateFallback(name),
        updated: m?.updated ?? m?.created ?? dateFallback(name),
      };
    })
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

// Which blocks across all pages reference `name`.
export function backlinksTo(name: string) {
  const pages: Page[] = Object.entries(cache).map(([n, md]) => ({
    name: n,
    root: fromMarkdown(md),
  }));
  return buildBacklinkIndex(pages)[name] ?? [];
}

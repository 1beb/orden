// Page store backed by the host vault (ns "pages", one key per page name). A
// page is a named markdown outline; journal pages are keyed by ISO date.
// [[wiki links]] across pages drive navigation + backlinks. Accessors stay
// synchronous over a cache hydrated at boot; setPageMarkdown writes through.
import { fromMarkdown, buildBacklinkIndex, type Page } from "@orden/outliner";
import type { Host } from "@orden/host-api";

let host: Host | null = null;
let cache: Record<string, string> = {};

export async function hydratePages(h: Host): Promise<void> {
  host = h;
  const names = await h.vault.list("pages");
  const entries = await Promise.all(
    names.map(async (n) => [n, (await h.vault.get<string>("pages", n)) ?? ""] as const),
  );
  cache = Object.fromEntries(entries);
}

export function getPageMarkdown(name: string): string {
  return cache[name] ?? "";
}

export function setPageMarkdown(name: string, markdown: string): void {
  cache[name] = markdown;
  if (host) void host.vault.set("pages", name, markdown);
}

export function pageNames(): string[] {
  return Object.keys(cache).sort();
}

// Which blocks across all pages reference `name`.
export function backlinksTo(name: string) {
  const pages: Page[] = Object.entries(cache).map(([n, md]) => ({
    name: n,
    root: fromMarkdown(md),
  }));
  return buildBacklinkIndex(pages)[name] ?? [];
}

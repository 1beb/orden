// In-memory + localStorage page store (a stand-in for the vault until the host
// backend exists). A page is a named markdown outline; journal pages are keyed
// by ISO date. [[wiki links]] across pages drive navigation + backlinks.
import { fromMarkdown, buildBacklinkIndex, type Page } from "@orden/outliner";

const KEY = "orden:pages";

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(pages: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pages));
  } catch {
    /* ignore */
  }
}

export function getPageMarkdown(name: string): string {
  return load()[name] ?? "";
}

export function setPageMarkdown(name: string, markdown: string): void {
  const pages = load();
  pages[name] = markdown;
  save(pages);
}

export function pageNames(): string[] {
  return Object.keys(load()).sort();
}

// Which blocks across all pages reference `name`.
export function backlinksTo(name: string) {
  const pages: Page[] = Object.entries(load()).map(([n, md]) => ({
    name: n,
    root: fromMarkdown(md),
  }));
  return buildBacklinkIndex(pages)[name] ?? [];
}

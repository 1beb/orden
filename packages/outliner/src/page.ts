import type { Page } from "./types";
import { createRoot } from "./blockTree";

/** Format a Date as an ISO `yyyy-mm-dd` key (UTC). */
export function journalKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The daily journal is just a Page keyed by date. This makes an empty one; the
 * outliner fills its root with bullets as the user types.
 */
export function createJournalPage(date: Date): Page {
  return { name: journalKey(date), root: createRoot() };
}

/** Make a named (non-journal) page, e.g. a project page. */
export function createPage(name: string): Page {
  return { name, root: createRoot() };
}

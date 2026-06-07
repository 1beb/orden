import type { Page } from "./types";
import { createRoot } from "./blockTree";

/**
 * Format a Date as an ISO `yyyy-mm-dd` key in a given IANA time zone.
 *
 * The key decides which day-page an entry is filed under, so it must reflect
 * the user's local calendar day — not UTC. Filing by UTC silently rolls the
 * key forward an evening entry (e.g. 21:00 in America/Toronto is already the
 * next day in UTC), landing it on tomorrow's page. `timeZone` omitted formats
 * in the runtime's own zone, which is the right default for the host process.
 */
export function journalKey(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: "year" | "month" | "day"): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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

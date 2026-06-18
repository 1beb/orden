import { EditorView } from "prosemirror-view";
import { journalKey } from "@orden/outliner";
import { makeOutlineEditor } from "./outlineEditor";
import { backlinksTo, getPageBody, journalDates, type RenameResult } from "./pages";
import { effectiveTimeZone } from "./settings";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Derived pages (per-card narratives, project notes) live in the pages store but
// aren't standalone wiki pages, so their title isn't user-renamable.
const INTERNAL_PAGE_RE = /^(card|notes):/;

// Today's journal key in the user's effective zone (override or host default).
// Centralizes the zone lookup so "today" is consistent across the feed heading,
// the date list, and the public today() accessor.
const todayKey = (): string => journalKey(new Date(), effectiveTimeZone());

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export interface JournalController {
  /** Logseq-style feed: a heading per day, newest first, infinite scroll. */
  showJournal(): void;
  /** A single named page (for opening a specific page from the index). */
  showPage(name: string): void;
  today(): string;
  refresh(): void;
  currentPage(): string | null;
}

export function mountJournal(
  container: HTMLElement,
  onTitle: (title: string) => void,
  // Intercept wiki-link clicks. Return true if handled externally (e.g. a
  // [[Project: X]] link that routes to a project page); false falls back to
  // opening a normal page in the journal.
  onWikiLink?: (target: string) => boolean,
  // Optional callback that returns a DOM element for [[Session: <id>]] links
  // so they render as widget buttons instead of inline [[Session: x]] text.
  widgetForSession?: (sessionId: string) => HTMLElement | null | undefined,
  // Commit a page rename (title edited then clicked away). The owner performs the
  // vault-side rename + backlink rewrite and reports success; on failure the
  // heading reverts to the old name. Absent => titles aren't editable.
  onRename?: (oldName: string, newName: string) => RenameResult | Promise<RenameResult>,
): JournalController {
  let mode: "feed" | "page" = "feed";
  let currentName: string | null = null;
  const editors: EditorView[] = [];
  // Bumped on every clear, so an async editor mount whose body resolves after a
  // newer render started knows to drop itself (mirrors the search stale guard).
  let renderGen = 0;

  function clearEditors(): void {
    renderGen++;
    for (const v of editors) {
      try {
        v.destroy();
      } catch {
        /* ignore */
      }
    }
    editors.length = 0;
  }

  // Bodies are fetched on demand now, so mounting an editor is async: grab the
  // body, then (if this render still stands) build the editor into `host`.
  async function makeEditor(host: HTMLElement, name: string): Promise<void> {
    const gen = renderGen;
    const body = await getPageBody(name);
    if (gen !== renderGen) return; // a newer render superseded this mount
    const view = makeOutlineEditor(host, name, body, (target) => {
      if (onWikiLink?.(target)) return; // handled externally (e.g. [[Project: X]])
      showPage(target);
    }, widgetForSession);
    editors.push(view);
  }

  // One day in the feed: a date heading + its editable outline (mounted async).
  function dayChunk(name: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "journal-day";
    const heading = document.createElement("h2");
    heading.className = "journal-day-head";
    heading.textContent = name === todayKey() ? `${name} · Today` : name;
    const host = document.createElement("div");
    host.className = "journal-editor";
    section.append(heading, host);
    void makeEditor(host, name);
    return section;
  }

  // Days to show: today (always) + existing date pages, newest first.
  function feedDates(): string[] {
    const today = todayKey();
    return [...new Set([today, ...journalDates()])].sort().reverse();
  }

  function showJournal(): void {
    mode = "feed";
    currentName = null;
    clearEditors();
    container.replaceChildren();
    onTitle("Journal");

    const feed = document.createElement("div");
    feed.className = "journal-feed";
    container.append(feed);

    const dates = feedDates();
    const BATCH = 5;
    let loaded = 0;
    const loadMore = (): void => {
      const end = Math.min(loaded + BATCH, dates.length);
      for (; loaded < end; loaded++) feed.append(dayChunk(dates[loaded]));
    };
    loadMore();
    feed.addEventListener("scroll", () => {
      if (loaded < dates.length && feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 240) {
        loadMore();
      }
    });
  }

  function titleFor(name: string): string {
    return DATE_RE.test(name) ? `Journal — ${name}` : `Page — ${name}`;
  }

  // Make a knowledge page's <h1> title editable in place. The edit commits when
  // the user clicks away (blur): the rename + backlink rewrite runs, then the
  // page re-renders under its new name. Enter commits (blurs); Escape cancels.
  // A no-op, empty, or rejected name reverts the heading text.
  function makeTitleEditable(heading: HTMLElement, name: string): void {
    heading.textContent = name;
    heading.classList.add("page-title-edit");
    heading.contentEditable = "plaintext-only";
    heading.spellcheck = false;
    heading.title = "Click to rename";

    let committed = false;
    const commit = async (): Promise<void> => {
      if (committed) return;
      committed = true;
      const next = (heading.textContent ?? "").trim();
      if (next.length === 0 || next === name) {
        showPage(name); // revert any stray whitespace / empty edit
        return;
      }
      const result = await onRename!(name, next);
      if (result.ok) showPage(next);
      else showPage(name); // owner surfaced the reason; restore the old title
    };

    heading.addEventListener("blur", commit);
    heading.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        heading.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        committed = true; // skip the blur-driven commit
        showPage(name);
      }
    });
  }

  function showPage(name: string): void {
    mode = "page";
    currentName = name;
    clearEditors();
    container.replaceChildren();

    const heading = document.createElement("h1");
    heading.className = "journal-date";
    if (DATE_RE.test(name)) {
      const prev = document.createElement("button");
      prev.className = "journal-nav";
      prev.textContent = "‹";
      prev.title = "Previous day";
      prev.addEventListener("click", () => showPage(shiftDate(name, -1)));
      const label = document.createElement("span");
      label.textContent = name;
      const next = document.createElement("button");
      next.className = "journal-nav";
      next.textContent = "›";
      next.title = "Next day";
      next.addEventListener("click", () => showPage(shiftDate(name, 1)));
      heading.append(prev, label, next);
    } else if (onRename && !INTERNAL_PAGE_RE.test(name)) {
      makeTitleEditable(heading, name);
    } else {
      heading.textContent = name;
    }
    const host = document.createElement("div");
    host.className = "journal-editor";
    const backlinksEl = document.createElement("div");
    backlinksEl.className = "backlinks";
    container.append(heading, host, backlinksEl);

    void makeEditor(host, name);
    void renderBacklinks(backlinksEl, name);
    onTitle(titleFor(name));
  }

  // Backlinks come from the host index (async). Fill the panel once they land —
  // the page body already rendered, so this never blocks the editor mount.
  async function renderBacklinks(el: HTMLElement, name: string): Promise<void> {
    const refs = await backlinksTo(name);
    el.replaceChildren();
    if (refs.length === 0) return;
    const title = document.createElement("div");
    title.className = "backlinks-title";
    title.textContent = `Backlinks (${refs.length})`;
    el.append(title);
    for (const r of refs) {
      const a = document.createElement("a");
      a.className = "backlink";
      const where = document.createElement("span");
      where.className = "backlink-page";
      where.textContent = r.pageName;
      const text = document.createElement("span");
      text.className = "backlink-text";
      text.textContent = r.text;
      a.append(where, text);
      a.addEventListener("click", () => showPage(r.pageName));
      el.append(a);
    }
  }

  function refresh(): void {
    // Re-render on remote change, but never while the user is editing.
    if (editors.some((v) => v.hasFocus())) return;
    if (mode === "feed") showJournal();
    else if (currentName) showPage(currentName);
  }

  return {
    showJournal,
    showPage,
    today: todayKey,
    refresh,
    currentPage: () => currentName,
  };
}

import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { journalKey } from "@orden/outliner";
import { schema, markdownParser, markdownSerializer } from "./schema";
import { buildInputRules } from "./inputrules";
import { wikiLinkPlugin } from "./wikilink";
import { getPageMarkdown, setPageMarkdown, backlinksTo, pageNames } from "./pages";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// ProseMirror's markdown serializer escapes "[" / "]"; restore [[wiki links]].
function serializePage(doc: Parameters<typeof markdownSerializer.serialize>[0]): string {
  return markdownSerializer.serialize(doc).replace(/\\\[\\\[(.+?)\\\]\\\]/g, "[[$1]]");
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
): JournalController {
  let mode: "feed" | "page" = "feed";
  let currentName: string | null = null;
  const editors: EditorView[] = [];

  function clearEditors(): void {
    for (const v of editors) {
      try {
        v.destroy();
      } catch {
        /* ignore */
      }
    }
    editors.length = 0;
  }

  function makeEditor(host: HTMLElement, name: string): EditorView {
    const state = EditorState.create({
      doc: markdownParser.parse(getPageMarkdown(name) || "- "),
      schema,
      plugins: [
        buildInputRules(schema),
        history(),
        keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
        keymap({
          Enter: splitListItem(schema.nodes.list_item),
          "Mod-[": liftListItem(schema.nodes.list_item),
          "Mod-]": sinkListItem(schema.nodes.list_item),
          Tab: sinkListItem(schema.nodes.list_item),
          "Shift-Tab": liftListItem(schema.nodes.list_item),
        }),
        keymap(baseKeymap),
        wikiLinkPlugin((target) => showPage(target)),
      ],
    });
    const view = new EditorView(host, {
      state,
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) setPageMarkdown(name, serializePage(view.state.doc));
      },
    });
    editors.push(view);
    return view;
  }

  // One day in the feed: a date heading + its editable outline.
  function dayChunk(name: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "journal-day";
    const heading = document.createElement("h2");
    heading.className = "journal-day-head";
    heading.textContent = name === journalKey(new Date()) ? `${name} · Today` : name;
    const host = document.createElement("div");
    host.className = "journal-editor";
    section.append(heading, host);
    makeEditor(host, name);
    return section;
  }

  // Days to show: today (always) + existing date pages, newest first.
  function feedDates(): string[] {
    const today = journalKey(new Date());
    const dated = pageNames().filter((n) => DATE_RE.test(n));
    return [...new Set([today, ...dated])].sort().reverse();
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
    } else {
      heading.textContent = name;
    }
    const host = document.createElement("div");
    host.className = "journal-editor";
    const backlinksEl = document.createElement("div");
    backlinksEl.className = "backlinks";
    container.append(heading, host, backlinksEl);

    makeEditor(host, name);
    renderBacklinks(backlinksEl, name);
    onTitle(titleFor(name));
  }

  function renderBacklinks(el: HTMLElement, name: string): void {
    const refs = backlinksTo(name);
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
    today: () => journalKey(new Date()),
    refresh,
    currentPage: () => currentName,
  };
}

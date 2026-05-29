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
import { getPageMarkdown, setPageMarkdown, backlinksTo } from "./pages";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ProseMirror's markdown serializer escapes "[" / "]", which would hide
// [[wiki links]] from the link extractor. Restore them so backlinks work.
function serializePage(doc: Parameters<typeof markdownSerializer.serialize>[0]): string {
  return markdownSerializer.serialize(doc).replace(/\\\[\\\[(.+?)\\\]\\\]/g, "[[$1]]");
}

export interface JournalController {
  showPage(name: string): void;
  today(): string;
  /** Re-render the current page from the store (e.g. after a remote change). */
  refresh(): void;
  currentPage(): string | null;
}

// The Journal/Pages view: a Logseq-style outliner for a named page. Today's
// journal is just the page named by today's date. [[wiki links]] navigate to
// other pages (created on demand); a backlinks panel lists references to the
// current page. Pages persist via the page store (vault stand-in).
export function mountJournal(
  container: HTMLElement,
  onTitle: (title: string) => void,
): JournalController {
  let view: EditorView | null = null;
  let currentName: string | null = null;

  function titleFor(name: string): string {
    return DATE_RE.test(name) ? `Journal — ${name}` : `Page — ${name}`;
  }

  function render(name: string): void {
    currentName = name;
    container.replaceChildren();

    const heading = document.createElement("h1");
    heading.className = "journal-date";
    heading.textContent = name;
    const host = document.createElement("div");
    host.className = "journal-editor";
    const backlinksEl = document.createElement("div");
    backlinksEl.className = "backlinks";
    container.append(heading, host, backlinksEl);

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
        wikiLinkPlugin((target) => render(target)),
      ],
    });

    view = new EditorView(host, {
      state,
      dispatchTransaction(tr) {
        const v = view!;
        v.updateState(v.state.apply(tr));
        if (tr.docChanged) {
          setPageMarkdown(name, serializePage(v.state.doc));
        }
      },
    });

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
      a.addEventListener("click", () => render(r.pageName));
      el.append(a);
    }
  }

  function refresh(): void {
    // Re-render the current page from the (re-hydrated) store, but never clobber
    // the user mid-edit — skip while the editor has focus.
    if (currentName === null) return;
    if (view && view.hasFocus()) return;
    render(currentName);
  }

  return {
    showPage: render,
    today: () => journalKey(new Date()),
    refresh,
    currentPage: () => currentName,
  };
}

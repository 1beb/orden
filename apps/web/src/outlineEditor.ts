// A reusable single-page outliner editor (ProseMirror + the @orden/outliner
// markdown schema, list keymaps, input rules and [[wiki link]] plugin), backed
// by the pages store. Extracted from journal.ts so the Journal and the project
// page's notes widget share one editor instead of duplicating the wiring.
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { tableEditing, columnResizing, goToNextCell } from "prosemirror-tables";
import "prosemirror-tables/style/tables.css";
import { schema, markdownParser, markdownSerializer } from "./schema";
import { buildInputRules } from "./inputrules";
import { wikiLinkPlugin } from "./wikilink";
import { setPageMarkdown } from "./pages";

// ProseMirror's markdown serializer escapes "[" / "]"; restore [[wiki links]].
export function serializePage(doc: Parameters<typeof markdownSerializer.serialize>[0]): string {
  return markdownSerializer.serialize(doc).replace(/\\\[\\\[(.+?)\\\]\\\]/g, "[[$1]]");
}

// Mount an editable outline for page `name` into `host`, seeded with `body`
// (the caller fetches it via the async getPageBody, keeping this constructor
// synchronous). Persists through to the pages store on every doc change.
// `onWikiLink(target)` fires on a [[link]] click. `widgetForSession` is an
// optional callback that returns a DOM element for [[Session: <id>]] links so
// they render as widget buttons instead of inline text.
export function makeOutlineEditor(
  host: HTMLElement,
  name: string,
  body: string,
  onWikiLink: (target: string) => void,
  widgetForSession?: (sessionId: string) => HTMLElement | null | undefined,
): EditorView {
  const state = EditorState.create({
    doc: markdownParser.parse(body || "- "),
    schema,
    plugins: [
      buildInputRules(schema),
      history(),
      keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
      keymap({
        Enter: splitListItem(schema.nodes.list_item),
        "Mod-[": liftListItem(schema.nodes.list_item),
        "Mod-]": sinkListItem(schema.nodes.list_item),
        // Inside a table, Tab/Shift-Tab move between cells; everywhere else they
        // indent/outdent the outline. goToNextCell only fires within a table, so
        // the list command runs as the fallback.
        Tab: chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item)),
        "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item)),
      }),
      keymap(baseKeymap),
      wikiLinkPlugin(onWikiLink, widgetForSession),
      columnResizing(),
      tableEditing(),
    ],
  });
  const view = new EditorView(host, {
    state,
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) setPageMarkdown(name, serializePage(view.state.doc));
    },
  });
  return view;
}

import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { journalKey } from "@orden/outliner";
import { schema, markdownParser } from "./schema";
import { buildInputRules } from "./inputrules";

// The Journal view: a ProseMirror outliner for today's date (Logseq-style).
// Reuses the markdown schema + list input rules + list keymap. Per-day content
// is in-memory for now (persistence is a later phase).
export function mountJournal(container: HTMLElement): { title: string } {
  const today = journalKey(new Date());

  const heading = document.createElement("h1");
  heading.className = "journal-date";
  heading.textContent = today;

  const host = document.createElement("div");
  host.className = "journal-editor";
  container.replaceChildren(heading, host);

  const doc = markdownParser.parse("- ");
  const editorState = EditorState.create({
    doc,
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
    ],
  });

  const view: EditorView = new EditorView(host, {
    state: editorState,
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
    },
  });

  return { title: `Journal — ${today}` };
}

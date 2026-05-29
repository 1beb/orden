import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Renders [[wiki links]] in the outliner as clickable spans and routes clicks to
// a navigate callback (Logseq-style page jumps).
const LINK = /\[\[([^[\]]+?)\]\]/g;

export function wikiLinkPlugin(onNavigate: (name: string) => void): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isText || !node.text) return true;
          LINK.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = LINK.exec(node.text)) !== null) {
            const from = pos + m.index;
            decos.push(
              Decoration.inline(from, from + m[0].length, {
                class: "wikilink",
                "data-target": m[1].trim(),
              }),
            );
          }
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const link = (event.target as HTMLElement).closest<HTMLElement>(".wikilink");
        if (link?.dataset.target) {
          onNavigate(link.dataset.target);
          return true;
        }
        return false;
      },
    },
  });
}

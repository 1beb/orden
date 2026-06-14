import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Renders [[wiki links]] in the outliner as clickable spans and routes clicks to
// a navigate callback (Logseq-style page jumps).
const LINK = /\[\[([^[\]]+?)\]\]/g;

// An optional callback that returns a DOM element for [[Session: <id>]] links.
// When provided, Session: links render as widget buttons instead of inline
// spans (the underlying [[Session: <id>]] text is hidden). The element's click
// and the decoration's handleClickOn both route through onNavigate.
export function wikiLinkPlugin(
  onNavigate: (name: string) => void,
  widgetForSession?: (sessionId: string) => HTMLElement | null | undefined,
): Plugin {
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
            const to = from + m[0].length;
            const target = m[1].trim();
            const sessM = /^Session:\s*(.+)$/i.exec(target);
            if (sessM && widgetForSession) {
              const sid = sessM[1].trim();
              const widget = widgetForSession(sid);
              if (widget) {
                widget.setAttribute("data-target", target);
                widget.classList.add("wikilink-widget");
                decos.push(
                  Decoration.widget(from, widget, { side: 0 }),
                  Decoration.inline(from, to, {
                    class: "wikilink-session-hidden",
                  }),
                );
                continue;
              }
            }
            decos.push(
              Decoration.inline(from, to, {
                class: "wikilink",
                "data-target": target,
              }),
            );
          }
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const link = (event.target as HTMLElement).closest<HTMLElement>(
          ".wikilink, .wikilink-widget",
        );
        if (link?.dataset.target) {
          onNavigate(link.dataset.target);
          return true;
        }
        return false;
      },
    },
  });
}

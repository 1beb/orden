// Click-to-toggle for task-list checkboxes. The `checked` attr on `list_item`
// (see schema.ts) carries task state; this turns a click on the rendered
// checkbox into a transaction that flips it.
import type { EditorState, Transaction } from "prosemirror-state";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

// Return a transaction toggling the `checked` attr of the task `list_item`
// containing `pos`, or null if `pos` is not inside a task item.
export function toggleTaskAt(state: EditorState, pos: number): Transaction | null {
  const clamped = Math.min(Math.max(pos, 0), state.doc.content.size);
  const $pos = state.doc.resolve(clamped);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "list_item" && node.attrs.checked !== null) {
      return state.tr.setNodeMarkup($pos.before(d), undefined, {
        ...node.attrs,
        checked: !node.attrs.checked,
      });
    }
  }
  return null;
}

// Plugin: a mousedown on a task checkbox toggles its item instead of moving the
// selection into the (non-editable) checkbox.
export function taskListPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view: EditorView, event: MouseEvent) {
          const target = event.target as HTMLElement | null;
          if (!target || target.tagName !== "INPUT") return false;
          if ((target as HTMLInputElement).type !== "checkbox") return false;
          const pos = view.posAtDOM(target, 0);
          const tr = toggleTaskAt(view.state, pos);
          if (!tr) return false;
          event.preventDefault();
          view.dispatch(tr);
          return true;
        },
      },
    },
  });
}

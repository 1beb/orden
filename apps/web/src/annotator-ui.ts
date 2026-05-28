import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { addAnnotation } from "./annotations";
import type { AnnotationLog } from "./store";

type Mode = "hidden" | "button" | "composer";
type Target = "agent" | "human";

// A floating affordance over the editor: on a non-empty selection it shows an
// "Annotate" pill at the selection; clicking it opens an inline composer anchored
// at the same spot. The selection range is captured up front so the composer can
// apply the mark even after focus leaves the editor.
export function mountAnnotator(
  view: EditorView,
  log: AnnotationLog,
  onChange: () => void,
) {
  const el = document.createElement("div");
  el.className = "annotator";
  el.style.display = "none";
  document.body.appendChild(el);

  let mode: Mode = "hidden";
  let range: { from: number; to: number } | null = null;
  let busy = false;

  function rectFor(from: number, to: number) {
    const a = view.coordsAtPos(from);
    const b = view.coordsAtPos(to);
    return {
      centerX: (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2,
      top: Math.min(a.top, b.top),
      bottom: Math.max(a.bottom, b.bottom),
    };
  }

  function position() {
    if (!range) return;
    const r = rectFor(range.from, range.to);
    el.style.left = `${r.centerX}px`;
    // Open above the selection by default; flip below when there isn't room.
    const below = r.top - el.offsetHeight - 16 < 0;
    el.classList.toggle("below", below);
    el.style.top = below ? `${r.bottom}px` : `${r.top}px`;
  }

  function hide() {
    mode = "hidden";
    range = null;
    el.style.display = "none";
    el.replaceChildren();
  }

  function showButton() {
    mode = "button";
    range = { from: view.state.selection.from, to: view.state.selection.to };
    el.replaceChildren();
    const btn = document.createElement("button");
    btn.className = "annotator-pill";
    btn.textContent = "Annotate";
    // mousedown would blur the editor and collapse the selection — prevent it.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", showComposer);
    el.appendChild(btn);
    el.style.display = "block";
    position();
  }

  function showComposer() {
    if (!range) return;
    mode = "composer";
    let target: Target = "agent";

    const box = document.createElement("div");
    box.className = "annotator-composer";

    const toggle = document.createElement("div");
    toggle.className = "annotator-toggle";
    const agentBtn = document.createElement("button");
    agentBtn.textContent = "To agent";
    agentBtn.className = "is-on";
    const humanBtn = document.createElement("button");
    humanBtn.textContent = "To human";
    const setTarget = (t: Target) => {
      target = t;
      agentBtn.classList.toggle("is-on", t === "agent");
      humanBtn.classList.toggle("is-on", t === "human");
      box.dataset.target = t;
    };
    agentBtn.addEventListener("mousedown", (e) => e.preventDefault());
    humanBtn.addEventListener("mousedown", (e) => e.preventDefault());
    agentBtn.addEventListener("click", () => setTarget("agent"));
    humanBtn.addEventListener("click", () => setTarget("human"));
    toggle.append(agentBtn, humanBtn);

    const ta = document.createElement("textarea");
    ta.className = "annotator-note";
    ta.placeholder = "Add a note…";
    ta.rows = 3;

    const actions = document.createElement("div");
    actions.className = "annotator-actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.className = "ghost";
    const save = document.createElement("button");
    save.textContent = "Comment";
    save.className = "primary";
    cancel.addEventListener("click", () => {
      hide();
      view.focus();
    });
    save.addEventListener("click", () => commit(ta.value, target));
    actions.append(cancel, save);

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(ta.value, target);
      if (e.key === "Escape") {
        hide();
        view.focus();
      }
    });

    box.dataset.target = "agent";
    box.append(toggle, ta, actions);
    el.replaceChildren(box);
    el.style.display = "block";
    position();
    ta.focus();
  }

  function commit(body: string, target: Target) {
    if (range && body.trim()) {
      busy = true;
      addAnnotation(view, log, body.trim(), target, range);
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, range.to, range.to),
        ),
      );
      busy = false;
      onChange();
    }
    hide();
    view.focus();
  }

  // Reposition while the document scrolls so the affordance stays glued.
  document.querySelector("#editor")?.addEventListener("scroll", () => {
    if (mode !== "hidden") position();
  });

  // Click outside dismisses an open composer/button.
  document.addEventListener("mousedown", (e) => {
    if (mode === "hidden") return;
    if (!el.contains(e.target as Node)) hide();
  });

  // Called on every editor update.
  function update() {
    if (busy || mode === "composer") return;
    if (view.state.selection.empty) {
      hide();
      return;
    }
    showButton();
  }

  return { update };
}

// DOM-native selection affordance: mirrors annotator-ui.ts's button -> composer UX
// (and reuses its .annotator/.annotator-* CSS classes) but for a plain DOM root and
// a callback instead of a ProseMirror editor. On a non-empty selection inside `root`
// it floats an "Annotate" pill at the selection; clicking it opens an inline note
// composer; Save invokes onCreate with a CLONED range that survives focus changes.

export interface DomAnnotator {
  destroy(): void;
}

type Mode = "hidden" | "button" | "composer";

export function mountDomAnnotator(opts: {
  root: Element; // the text container to watch for selections
  getSelection: () => Selection | null; // usually () => window.getSelection(); iframe passes its own
  onCreate: (range: Range, note: string) => void; // called on Save with a CLONED range
}): DomAnnotator {
  const { root, getSelection, onCreate } = opts;

  const el = document.createElement("div");
  el.className = "annotator";
  el.style.position = "fixed";
  el.style.display = "none";
  document.body.appendChild(el);

  let mode: Mode = "hidden";
  // Captured up front so the composer can fire onCreate even after the live
  // selection collapses (e.g. focus moves to the textarea).
  let captured: Range | null = null;

  function hide() {
    mode = "hidden";
    captured = null;
    el.style.display = "none";
    el.replaceChildren();
  }

  function position(rect: { left: number; top: number; bottom: number }) {
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    void rect.bottom;
  }

  // Pull the current selection if it is non-empty AND fully inside root.
  function selectionInRoot(): Range | null {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    if (sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    if (!root.contains(range.commonAncestorContainer)) return null;
    if (range.toString().trim() === "") return null;
    return range;
  }

  function showButton() {
    if (!captured) return;
    mode = "button";
    el.replaceChildren();
    const btn = document.createElement("button");
    btn.className = "annotator-pill";
    btn.textContent = "Annotate";
    // mousedown would collapse the selection by blurring — prevent it.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", showComposer);
    el.appendChild(btn);
    el.style.display = "block";
    const rect = captured.getBoundingClientRect();
    position({ left: rect.left, top: rect.top, bottom: rect.bottom });
  }

  function showComposer() {
    if (!captured) return;
    mode = "composer";

    const box = document.createElement("div");
    box.className = "annotator-composer";

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
    save.textContent = "Save";
    save.className = "primary";
    cancel.addEventListener("click", () => hide());
    save.addEventListener("click", () => commit(ta.value));
    actions.append(cancel, save);

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(ta.value);
      if (e.key === "Escape") hide();
    });

    box.append(ta, actions);
    el.replaceChildren(box);
    el.style.display = "block";
    ta.focus();
  }

  function commit(value: string) {
    const note = value.trim();
    if (captured && note) onCreate(captured.cloneRange(), note);
    hide();
  }

  function onMouseUp() {
    if (mode === "composer") return;
    const range = selectionInRoot();
    if (!range) {
      hide();
      return;
    }
    captured = range.cloneRange();
    showButton();
  }

  // Click outside the affordance dismisses an open pill/composer. An in-root
  // mousedown is a selection gesture (e.g. double-click a word) that may be about
  // to show the pill, so while showing only the pill we ignore in-root mousedowns.
  function onDocMouseDown(e: Event) {
    if (mode === "hidden") return;
    const target = e.target as Node;
    if (el.contains(target)) return;
    if (mode === "button" && root.contains(target)) return;
    hide();
  }

  root.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mousedown", onDocMouseDown);

  return {
    destroy() {
      root.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onDocMouseDown);
      el.remove();
    },
  };
}

// DOM-native selection affordance: mirrors annotator-ui.ts's button -> composer UX
// (and reuses its .annotator/.annotator-* CSS classes) but for a plain DOM root and
// a callback instead of a ProseMirror editor. On a non-empty selection inside `root`
// it floats an "Annotate" pill at the selection; clicking it opens an inline note
// composer; Save invokes onCreate with a CLONED range that survives focus changes.

import { buildNoteComposer } from "./noteComposer";

export interface DomAnnotator {
  destroy(): void;
}

type Mode = "hidden" | "button" | "composer";

export function mountDomAnnotator(opts: {
  root: Element; // the text container to watch for selections
  getSelection: () => Selection | null; // usually () => window.getSelection(); iframe passes its own
  onCreate: (range: Range, note: string) => void; // called on Save with a CLONED range
  // A range inside an iframe returns coords relative to the IFRAME viewport, not
  // the parent's. Pass the iframe's top-left (in parent coords) to shift the pill
  // back into parent space. Default 0 (in-page viewer needs no offset).
  rectOffset?: () => { x: number; y: number };
}): DomAnnotator {
  const { root, getSelection, onCreate } = opts;
  const rectOffset = opts.rectOffset ?? (() => ({ x: 0, y: 0 }));

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
    const off = rectOffset();
    el.style.left = `${rect.left + off.x}px`;
    el.style.top = `${rect.top + off.y}px`;
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
    const composer = buildNoteComposer({
      placeholder: "Add a note…",
      onSave: (note) => commit(note),
      onCancel: () => hide(),
    });
    el.replaceChildren(composer.el);
    el.style.display = "block";
    composer.focus();
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

  // Dismissal must listen in the realm where the clicks happen: for an owned-HTML
  // iframe that's the iframe's own document, not the parent. For the in-page code
  // viewer root.ownerDocument IS the parent document, so behaviour is unchanged.
  const clickDoc = root.ownerDocument ?? document;
  root.addEventListener("mouseup", onMouseUp);
  clickDoc.addEventListener("mousedown", onDocMouseDown);

  return {
    destroy() {
      root.removeEventListener("mouseup", onMouseUp);
      clickDoc.removeEventListener("mousedown", onDocMouseDown);
      el.remove();
    },
  };
}

import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { schema, markdownParser } from "./schema";
import { sampleMarkdown } from "./sample";
import { AnnotationLog } from "./store";
import { addAnnotation, scanAnnotations } from "./annotations";
import "./styles.css";

const log = new AnnotationLog();

const state = EditorState.create({
  doc: markdownParser.parse(sampleMarkdown),
  schema,
  plugins: [
    history(),
    keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
    keymap(baseKeymap),
  ],
});

const view = new EditorView(document.querySelector<HTMLElement>("#editor")!, {
  state,
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr));
    onUpdate();
  },
});

const annotateBtn = document.querySelector<HTMLButtonElement>("#annotate-btn")!;
const listEl = document.querySelector<HTMLUListElement>("#annotation-list")!;
const countEl = document.querySelector<HTMLElement>("#count")!;

annotateBtn.addEventListener("click", () => {
  const body = window.prompt("Annotation note:");
  if (body == null || body.trim() === "") return;
  addAnnotation(view, log, body.trim());
  view.focus();
});

function selectRange(from: number, to: number): void {
  const tr = view.state.tr
    .setSelection(TextSelection.create(view.state.doc, from, to))
    .scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

function setActive(id: string | null): void {
  view.dom
    .querySelectorAll(".annotation.is-active")
    .forEach((el) => el.classList.remove("is-active"));
  listEl
    .querySelectorAll("li.is-active")
    .forEach((el) => el.classList.remove("is-active"));
  if (!id) return;
  view.dom
    .querySelectorAll(`.annotation[data-annotation-id="${id}"]`)
    .forEach((el) => el.classList.add("is-active"));
  listEl
    .querySelector(`li[data-annotation-id="${id}"]`)
    ?.classList.add("is-active");
}

function renderPanel(): void {
  const placed = scanAnnotations(view.state.doc);
  countEl.textContent = String(placed.length);
  listEl.replaceChildren();

  for (const p of placed) {
    const record = log.get(p.id);
    const li = document.createElement("li");
    li.dataset.annotationId = p.id;
    li.className = `target-${record?.target ?? "agent"}`;

    const quote = document.createElement("div");
    quote.className = "quote";
    quote.textContent = p.text;

    const note = document.createElement("div");
    note.className = "note";
    note.textContent = record?.body ?? "(no note)";

    li.append(quote, note);
    li.addEventListener("click", () => selectRange(p.from, p.to));
    li.addEventListener("mouseenter", () => setActive(p.id));
    li.addEventListener("mouseleave", () => setActive(null));
    listEl.append(li);
  }
}

// Hovering an annotated span in the document lights up its panel row (and the
// span itself), mirroring the row -> span linking.
view.dom.addEventListener("mouseover", (e) => {
  const span = (e.target as HTMLElement).closest<HTMLElement>(".annotation");
  if (span?.dataset.annotationId) setActive(span.dataset.annotationId);
});
view.dom.addEventListener("mouseout", (e) => {
  const span = (e.target as HTMLElement).closest<HTMLElement>(".annotation");
  if (span) setActive(null);
});

function updateToolbar(): void {
  const empty = view.state.selection.empty;
  annotateBtn.disabled = empty;
}

function onUpdate(): void {
  updateToolbar();
  renderPanel();
}

// Dev seed: apply a few sample annotations on load so the page shows highlights
// and a populated panel immediately. Remove once persistence (Phase 2) lands.
function findPhrase(phrase: string): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (result) return false;
    if (node.isText && node.text && node.text.indexOf(phrase) !== -1) {
      const from = pos + node.text.indexOf(phrase);
      result = { from, to: from + phrase.length };
      return false;
    }
    return true;
  });
  return result;
}

function seedSampleAnnotations(): void {
  const samples: Array<{ phrase: string; body: string; target: "agent" | "human" }> = [
    { phrase: "quick brown fox", body: "Cut this metaphor — say 'dropped inactive rows'.", target: "agent" },
    { phrase: "signup cohort, not at random", body: "Why 80/20? Note the rationale here.", target: "agent" },
    { phrase: "Recall on the smallest plan tier is poor", body: "Share this caveat with the PM before launch.", target: "human" },
  ];
  for (const s of samples) {
    const r = findPhrase(s.phrase);
    if (!r) continue;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r.from, r.to)));
    addAnnotation(view, log, s.body, s.target);
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)));
}

seedSampleAnnotations();
onUpdate();

// Dev handle for inspection / screenshot-driven iteration.
(window as unknown as { orden: unknown }).orden = { view, log, addAnnotation };

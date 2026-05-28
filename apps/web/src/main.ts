import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { schema, markdownParser } from "./schema";
import { sampleMarkdown } from "./sample";
import { AnnotationLog } from "./store";
import { addAnnotation, scanAnnotations } from "./annotations";
import { mountAnnotator } from "./annotator-ui";
import { buildFeedbackPayload, type FeedbackItem } from "./feedback";
import { openPreview } from "./preview";
import "./styles.css";

const DOC_TITLE = "Churn model — review";
const log = new AnnotationLog();
let feedbackTarget: "agent" | "human" = "agent";

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

const app = document.querySelector<HTMLElement>("#app")!;
const listEl = document.querySelector<HTMLUListElement>("#annotation-list")!;
const countEl = document.querySelector<HTMLElement>("#count")!;
const primaryBtn = document.querySelector<HTMLButtonElement>("#primary-action")!;
const copyBtn = document.querySelector<HTMLButtonElement>("#copy-feedback")!;

app.dataset.target = feedbackTarget;

const annotator = mountAnnotator(view, log, () => renderPanel());

// Bottom action bar: target lives here (chosen at the end), and the primary
// action morphs between Approve (clean) and Send feedback (annotations present).
for (const tab of document.querySelectorAll<HTMLButtonElement>(".ab-tab")) {
  tab.addEventListener("click", () => {
    feedbackTarget = tab.dataset.target as "agent" | "human";
    app.dataset.target = feedbackTarget;
    for (const t of document.querySelectorAll(".ab-tab"))
      t.classList.toggle("is-on", t === tab);
  });
}

function feedbackItems(): FeedbackItem[] {
  return scanAnnotations(view.state.doc).map((p) => {
    const quote = log.get(p.id)?.anchor.quote;
    return {
      ref: p.text,
      prefix: quote?.prefix ?? "",
      suffix: quote?.suffix ?? "",
      note: log.get(p.id)?.body ?? "",
    };
  });
}

function previewFeedback(): void {
  const items = feedbackItems();
  if (items.length === 0) return;
  const payload = buildFeedbackPayload({ title: DOC_TITLE, target: feedbackTarget, items });
  openPreview(`Feedback → ${feedbackTarget}`, payload);
}

primaryBtn.addEventListener("click", () => {
  if (primaryBtn.dataset.kind === "send") previewFeedback();
  else {
    primaryBtn.textContent = "Approved ✓";
    window.setTimeout(updateActionBar, 1200);
  }
});

copyBtn.addEventListener("click", previewFeedback);

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

function updateActionBar(): void {
  const n = scanAnnotations(view.state.doc).length;
  if (n > 0) {
    primaryBtn.dataset.kind = "send";
    primaryBtn.textContent = `Send feedback (${n})`;
  } else {
    primaryBtn.dataset.kind = "approve";
    primaryBtn.textContent = "Approve";
  }
  copyBtn.disabled = n === 0;
}

function onUpdate(): void {
  renderPanel();
  annotator.update();
  updateActionBar();
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

import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { schema, markdownParser } from "./schema";
import { buildInputRules } from "./inputrules";
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

// Collapsible sidebars.
document
  .querySelector("#toggle-left")
  ?.addEventListener("click", () => app.classList.toggle("left-closed"));
document
  .querySelector("#toggle-right")
  ?.addEventListener("click", () => app.classList.toggle("right-closed"));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
    e.preventDefault();
    app.classList.toggle("left-closed");
  }
});

const docmap = document.querySelector<HTMLElement>("#docmap")!;
const docmapList = document.querySelector<HTMLUListElement>("#docmap-list")!;
document
  .querySelector("#docmap-toggle")
  ?.addEventListener("click", () => docmap.classList.toggle("collapsed"));

// Document map: an outline built from the headings, kept in sync with the doc.
function renderDocMap(): void {
  docmapList.replaceChildren();
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const li = document.createElement("li");
    li.className = `dm-l${node.attrs.level}`;
    li.textContent = node.textContent || "(untitled)";
    li.addEventListener("click", () => selectRange(pos + 1, pos + 1 + node.content.size));
    docmapList.append(li);
    return false;
  });
}

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
  if (primaryBtn.dataset.kind === "send") {
    for (const p of scanAnnotations(view.state.doc)) {
      if ((log.get(p.id)?.status ?? "open") === "open") log.setStatus(p.id, "sent");
    }
    previewFeedback();
    renderPanel();
    updateActionBar();
  } else {
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

type Status = "open" | "sent" | "resolved" | "orphaned";

const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  sent: "Sent",
  resolved: "Resolved",
  orphaned: "Orphaned",
};

function buildRow(opts: {
  id: string;
  status: Status;
  quote: string;
  note: string;
  range: { from: number; to: number } | null;
}): HTMLLIElement {
  const { id, status, quote, note, range } = opts;
  const li = document.createElement("li");
  li.dataset.annotationId = id;
  li.dataset.status = status;

  const head = document.createElement("div");
  head.className = "row-head";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = STATUS_LABEL[status];
  head.append(chip);

  if (status !== "orphaned") {
    const toggle = document.createElement("button");
    toggle.className = "row-action";
    toggle.textContent = status === "resolved" ? "Reopen" : "Resolve";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      log.setStatus(id, status === "resolved" ? "open" : "resolved");
      renderPanel();
      updateActionBar();
    });
    head.append(toggle);
  }

  const quoteEl = document.createElement("div");
  quoteEl.className = "quote";
  quoteEl.textContent = quote;

  const noteEl = document.createElement("div");
  noteEl.className = "note";
  noteEl.textContent = note;

  li.append(head, quoteEl, noteEl);

  if (range) {
    li.addEventListener("click", () => selectRange(range.from, range.to));
    li.addEventListener("mouseenter", () => setActive(id));
    li.addEventListener("mouseleave", () => setActive(null));
  } else {
    const gone = document.createElement("div");
    gone.className = "orphan-note";
    gone.textContent = "text no longer in the document";
    li.append(gone);
  }
  return li;
}

function syncHighlightStates(placed: { id: string }[]): void {
  view.dom
    .querySelectorAll(".annotation")
    .forEach((el) => el.classList.remove("is-sent", "is-resolved"));
  for (const p of placed) {
    const status = log.get(p.id)?.status;
    if (status === "sent" || status === "resolved") {
      view.dom
        .querySelectorAll(`.annotation[data-annotation-id="${p.id}"]`)
        .forEach((el) => el.classList.add(status === "sent" ? "is-sent" : "is-resolved"));
    }
  }
}

function renderPanel(): void {
  const placed = scanAnnotations(view.state.doc);
  const presentIds = new Set(placed.map((p) => p.id));
  listEl.replaceChildren();

  for (const p of placed) {
    const record = log.get(p.id);
    listEl.append(
      buildRow({
        id: p.id,
        status: (record?.status as Status) ?? "open",
        quote: p.text,
        note: record?.body ?? "(no note)",
        range: { from: p.from, to: p.to },
      }),
    );
  }

  // Records whose mark is no longer in the document are orphaned.
  const orphans = log.all().filter((r) => !presentIds.has(r.id));
  if (orphans.length > 0) {
    const sep = document.createElement("li");
    sep.className = "panel-sep";
    sep.textContent = "Orphaned";
    listEl.append(sep);
    for (const r of orphans) {
      listEl.append(
        buildRow({
          id: r.id,
          status: "orphaned",
          quote: r.anchor.quote?.exact ?? "",
          note: r.body,
          range: null,
        }),
      );
    }
  }

  countEl.textContent = String(placed.length + orphans.length);
  syncHighlightStates(placed);
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
  const placed = scanAnnotations(view.state.doc);
  const open = placed.filter((p) => (log.get(p.id)?.status ?? "open") === "open").length;
  if (open > 0) {
    primaryBtn.dataset.kind = "send";
    primaryBtn.textContent = `Send feedback (${open})`;
  } else {
    primaryBtn.dataset.kind = "approve";
    primaryBtn.textContent = "Approve";
  }
  copyBtn.disabled = placed.length === 0;
}

function onUpdate(): void {
  renderDocMap();
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

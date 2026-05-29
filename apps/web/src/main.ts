import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { sendFeedback } from "@orden/annotation-core";
import { schema, markdownParser, markdownSerializer } from "./schema";
import { buildInputRules } from "./inputrules";
import { reanchorQuote } from "./pm-reanchor";
import { saveState, loadState } from "./persist";
import { LocalStorageSink } from "./sink-local";
import { listFiles } from "./files";
import { sampleMarkdown } from "./sample";
import { AnnotationLog } from "./store";
import { addAnnotation, scanAnnotations } from "./annotations";
import { mountAnnotator } from "./annotator-ui";
import { buildFeedbackPayload, type FeedbackItem } from "./feedback";
import { openPreview } from "./preview";
import { createViewStore, type View } from "./viewState";
import { mountJournal } from "./journal";
import { mountKanban } from "./kanban";
import { loadSettings, saveSettings, type StartupView } from "./settings";
import "./styles.css";

const DOC_TITLE = "Churn model — review";
const log = new AnnotationLog();
const sink = new LocalStorageSink();
let feedbackTarget: "agent" | "human" = "agent";
let currentDocKey = "review:sample";
let currentDocTitle = DOC_TITLE;

function persistReview(): void {
  saveState(currentDocKey, markdownSerializer.serialize(view.state.doc), log.all());
}

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

const leftnav = document.querySelector<HTMLElement>("#leftnav")!;
const navScroll = document.querySelector<HTMLElement>(".nav-scroll")!;
const panel = document.querySelector<HTMLElement>("#panel")!;
const annotationsBlock = document.querySelector<HTMLElement>(".annotations-block")!;
const mobile = window.matchMedia("(max-width: 860px)");

// On mobile the annotations panel is a bottom sheet; tapping its header (but not
// the Send/Copy buttons) collapses/expands it.
annotationsBlock.querySelector("header")?.addEventListener("click", (e) => {
  if (!mobile.matches) return;
  if ((e.target as HTMLElement).closest(".panel-actions")) return;
  panel.classList.toggle("sheet-collapsed");
});

function toggleLeft(): void {
  const opening = app.classList.contains("left-closed");
  app.classList.toggle("left-closed");
  if (opening && mobile.matches) app.classList.add("right-closed"); // one drawer at a time
}
function toggleRight(): void {
  const opening = app.classList.contains("right-closed");
  app.classList.toggle("right-closed");
  if (opening && mobile.matches) app.classList.add("left-closed");
}

document.querySelector("#toggle-left")?.addEventListener("click", toggleLeft);
document.querySelector("#toggle-right")?.addEventListener("click", toggleRight);
document.querySelector("#scrim")?.addEventListener("click", () => {
  app.classList.add("left-closed", "right-closed");
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
    e.preventDefault();
    toggleLeft();
  }
});

// Responsive layout: on mobile the outline moves into the nav drawer, the
// annotations become a collapsed bottom sheet, and both side panes start closed.
function applyLayout(isMobile: boolean): void {
  if (isMobile) {
    app.classList.add("left-closed", "right-closed");
    panel.classList.add("sheet-collapsed");
    if (docmap.parentElement !== navScroll) navScroll.append(docmap);
  } else {
    app.classList.remove("left-closed", "right-closed");
    panel.classList.remove("sheet-collapsed");
    if (docmap.parentElement !== panel) panel.insertBefore(docmap, annotationsBlock);
  }
}
mobile.addEventListener("change", (e) => applyLayout(e.matches));

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

// Bottom action bar: the primary action morphs between Approve (clean) and Send
// (annotations present). Agent/human targeting is deferred — defaults to agent.

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
    // Send the open annotations through the annotation-core sink seam (the
    // LocalStorageSink stands in for an MCP sink later), then mark them sent.
    const openItems = scanAnnotations(view.state.doc)
      .map((p) => log.get(p.id))
      .filter((r): r is NonNullable<typeof r> => !!r && r.status === "open")
      .map((r) => ({ ...r, target: feedbackTarget }));
    previewFeedback();
    void sendFeedback(sink, openItems).then((sent) => {
      sent.forEach((a) => log.add(a));
      persistReview();
      renderPanel();
      updateActionBar();
    });
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
    primaryBtn.textContent = "Send";
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
  persistReview();
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

// --- Center views: review (the locked annotation core) / journal / kanban ---
const viewTitle = document.querySelector<HTMLElement>("#view-title")!;
const viewEls: Record<View, HTMLElement> = {
  review: document.querySelector<HTMLElement>("#main")!,
  journal: document.querySelector<HTMLElement>("#view-journal")!,
  kanban: document.querySelector<HTMLElement>("#view-kanban")!,
};
let journalTitle = "Journal";
const journal = mountJournal(viewEls.journal, (t) => {
  journalTitle = t;
  if (viewStore.get() === "journal") viewTitle.textContent = t;
});
const kanbanInfo = mountKanban(viewEls.kanban);
document.querySelector(".nav-badge")!.textContent = String(kanbanInfo.needsAction);

const viewStore = createViewStore("review");
viewStore.subscribe((v) => {
  for (const name of Object.keys(viewEls) as View[]) {
    viewEls[name].classList.toggle("active", name === v);
  }
  viewTitle.textContent =
    v === "review" ? currentDocTitle : v === "journal" ? journalTitle : "Kanban";
  document.querySelector("#nav-journal")?.classList.toggle("active", v === "journal");
  document.querySelector("#nav-kanban")?.classList.toggle("active", v === "kanban");
  if (mobile.matches) app.classList.add("left-closed"); // close drawer after navigating
});

journal.showPage(journal.today());

document.querySelector("#nav-journal")?.addEventListener("click", () => {
  journal.showPage(journal.today());
  viewStore.set("journal");
});
document.querySelector("#nav-kanban")?.addEventListener("click", () => viewStore.set("kanban"));
for (const el of document.querySelectorAll<HTMLElement>(".nav-sess")) {
  el.addEventListener("click", () => viewStore.set("review"));
}

// --- Settings: cog popover + startup preference ---
const settingsCog = document.querySelector<HTMLElement>("#settings-cog")!;
const settingsPopover = document.querySelector<HTMLElement>("#settings-popover")!;
const settings = loadSettings();
for (const radio of settingsPopover.querySelectorAll<HTMLInputElement>('input[name="startup"]')) {
  radio.checked = radio.value === settings.startup;
  radio.addEventListener("change", () => {
    if (radio.checked) saveSettings({ startup: radio.value as StartupView });
  });
}
settingsCog.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPopover.hidden = !settingsPopover.hidden;
});
document.addEventListener("click", (e) => {
  if (settingsPopover.hidden) return;
  const t = e.target as HTMLElement;
  if (settingsPopover.contains(t) || t.closest("#settings-cog")) return;
  settingsPopover.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") settingsPopover.hidden = true;
});

// --- Open real repo docs in the review editor (dogfooding) ---
// Load a document into the review view: restore its saved markdown + annotations
// (re-anchored by quote) if present, else the file's on-disk content.
function loadReviewDoc(opts: {
  key: string;
  title: string;
  markdown: string;
  seedIfEmpty?: boolean;
}): void {
  currentDocKey = opts.key;
  currentDocTitle = opts.title;
  localStorage.setItem("orden:last-doc", opts.key);

  const saved = loadState(opts.key);
  const parsed = markdownParser.parse(saved?.markdown ?? opts.markdown);
  const records = saved?.records ?? [];

  log.clear();
  records.forEach((r) => log.add(r));

  let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content);
  for (const r of records) {
    const quote = r.anchor?.quote;
    if (!quote) continue;
    const range = reanchorQuote(parsed, quote);
    if (range) {
      tr = tr.addMark(
        range.from,
        range.to,
        schema.marks.annotation.create({ id: r.id, target: r.target }),
      );
    }
  }
  view.dispatch(tr);
  if (!saved && opts.seedIfEmpty) seedSampleAnnotations();
  if (viewStore.get() === "review") viewTitle.textContent = currentDocTitle;
}

const recentList = document.querySelector<HTMLElement>("#recent-list")!;
const repoFiles = listFiles();

function setActiveFile(path: string | null): void {
  recentList.querySelectorAll<HTMLElement>(".nav-file").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === path);
  });
}

for (const f of repoFiles) {
  const a = document.createElement("a");
  a.className = "nav-file";
  a.dataset.path = f.path;
  const name = document.createElement("span");
  name.className = "nav-file-name";
  name.textContent = f.path.split("/").pop() ?? f.path;
  const meta = document.createElement("span");
  meta.className = "nav-file-meta";
  meta.textContent = f.path.includes("/") ? f.path.replace(/\/[^/]+$/, "") : "/";
  a.append(name, meta);
  a.addEventListener("click", () => {
    loadReviewDoc({ key: `review:${f.path}`, title: f.title, markdown: f.content });
    setActiveFile(f.path);
    viewStore.set("review");
  });
  recentList.append(a);
}

// Initial review document: last-opened repo file, else the design doc, else the
// built-in sample (which seeds demo annotations on first run).
const lastKey = localStorage.getItem("orden:last-doc");
const lastFile = repoFiles.find((f) => `review:${f.path}` === lastKey);
const defaultFile =
  lastFile ?? repoFiles.find((f) => f.path.includes("orden-design")) ?? repoFiles[0];
if (defaultFile) {
  loadReviewDoc({
    key: `review:${defaultFile.path}`,
    title: defaultFile.title,
    markdown: defaultFile.content,
  });
  setActiveFile(defaultFile.path);
} else {
  loadReviewDoc({
    key: "review:sample",
    title: DOC_TITLE,
    markdown: sampleMarkdown,
    seedIfEmpty: true,
  });
}

onUpdate();
applyLayout(mobile.matches);

// Route the initial view from the startup preference ("last" -> review).
if (settings.startup === "journal") viewStore.set("journal");
else if (settings.startup === "kanban") viewStore.set("kanban");

// Dev handle for inspection / screenshot-driven iteration.
(window as unknown as { orden: unknown }).orden = { view, log, addAnnotation, viewStore };

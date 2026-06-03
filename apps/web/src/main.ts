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
import { saveState, loadState, hydrateDocs } from "./persist";
import { VaultSink, hydrateOutbox } from "./sink-local";
import {
  listProjects,
  getProject,
  isHostFilesRoot,
  hydrateProjects,
  removeProject,
  ensureDefaultProject,
} from "./projects";
import { openProjectModal } from "./projectModal";
import { hydratePages } from "./pages";
import {
  hydrateCards,
  listItems,
  getItem,
  cardSessionIds,
  itemsByProject,
  setItemProject,
  removeItem,
  type Item,
} from "./cards";
import {
  hydrateSessions,
  reapDeadSessions,
  listSessions,
  getSession,
  createSession,
  archiveSession,
  deleteSession,
  setSessionProject,
  isAbandoned,
  isSessionComplete,
  markSessionTouched,
  type Agent,
} from "./sessions";
import { mountSessionsPanel } from "./sessionsPanel";
import { mountTerminal, updateTerminalFonts } from "./terminalView";
import { createChatMount } from "./chatMount";
import { renderPagesIndex } from "./pagesIndex";
import { renderKanban } from "./kanban";
import { renderProjectPage, projectNotesHasFocus, projectPageHasFocus } from "./projectPage";
import { renderCodeView } from "./codeView";
import { viewerFor } from "./codeHighlight";
import { renderImageView, renderHtmlView } from "./richView";
import {
  hydrateRecentFiles,
  recordRecentFile,
  listRecentFiles,
  SHOW_CAP,
} from "./recentFiles";
import { sampleMarkdown } from "./sample";
import { AnnotationLog } from "./store";
import { addAnnotation, scanAnnotations } from "./annotations";
import { mountAnnotator } from "./annotator-ui";
import { buildFeedbackPayload, type FeedbackItem } from "./feedback";
import { openPreview } from "./preview";
import { createViewStore, type View } from "./viewState";
import { mountJournal } from "./journal";
import {
  hydrateSettings,
  loadSettings,
  saveSettings,
  MIN_PANEL_PCT,
  MAX_PANEL_PCT,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  type StartupView,
} from "./settings";
import { getHost, onVaultChange, onReconnect } from "./host";
import { dispatchPanelIntent, type PanelIntent } from "./panelIntent";
import { openCardModal } from "./cardModal";
import { applyFont, FONT_OPTIONS } from "./fonts";
import "./styles.css";

// H0.3: the app talks to a Host (BrowserHost by default; a NodeHost over
// WebSocket when VITE_ORDEN_HOST is set). Obtain it and hydrate the vault-backed
// stores before the rest of the module runs (top-level await — Vite supports it
// in the entry module).
const host = await getHost();
async function hydrateAll(): Promise<void> {
  await Promise.all([
    hydrateSettings(host),
    hydrateOutbox(host),
    hydratePages(host),
    hydrateProjects(host),
    hydrateDocs(host),
    hydrateCards(host),
    hydrateSessions(host),
    hydrateRecentFiles(host),
  ]);
}
await hydrateAll();
// Sweep dead "Untitled" stub sessions left by prior runs (touched or not) so they
// don't linger in the active list. Boot-only: hydrateAll also runs on reconnect,
// where reaping could nuke a freshly-started, not-yet-titled session.
reapDeadSessions();

// Toast when a session's linked card flips to "blocked" — Claude finished its
// turn and is waiting on you (driven by the Stop hook → host → card state, which
// arrives over the change feed). Seeded from the boot state so pre-existing
// blocked cards don't fire on load.
const cardWaitState = new Map<string, string>(listItems().map((i) => [i.id, i.state]));
function showToast(text: string): void {
  const t = document.createElement("div");
  t.className = "orden-toast";
  t.textContent = text;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 6000);
}
function notifyBlockedTransitions(): void {
  for (const it of listItems()) {
    const prev = cardWaitState.get(it.id);
    if (cardSessionIds(it).length > 0 && it.state === "blocked" && prev !== "blocked") {
      showToast(`${it.title} is waiting for you`);
    }
    cardWaitState.set(it.id, it.state);
  }
}

const DOC_TITLE = "Churn model — review";
const log = new AnnotationLog();
const sink = new VaultSink();
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
const primaryBtn = document.querySelector<HTMLButtonElement>("#primary-action")!;
const copyBtn = document.querySelector<HTMLButtonElement>("#copy-feedback")!;

app.dataset.target = feedbackTarget;

const leftnav = document.querySelector<HTMLElement>("#leftnav")!;
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
  // The outline stays in #panel with the annotations (a sibling unfurlable
  // section) in every layout; on mobile #panel is the scrollable bottom sheet.
  if (isMobile) {
    app.classList.add("left-closed", "right-closed");
    panel.classList.add("sheet-collapsed");
  } else {
    app.classList.remove("left-closed", "right-closed");
    panel.classList.remove("sheet-collapsed");
  }
}
mobile.addEventListener("change", (e) => applyLayout(e.matches));

const docmap = document.querySelector<HTMLElement>("#docmap")!;
const docmapList = document.querySelector<HTMLUListElement>("#docmap-list")!;
// The ▾ button and the label word both furl/unfurl a section.
function wireFurl(section: HTMLElement, ...selectors: string[]): void {
  for (const sel of selectors) {
    section.querySelector(sel)?.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also toggle the mobile bottom sheet
      section.classList.toggle("collapsed");
    });
  }
}
wireFurl(docmap, "#docmap-toggle", ".block-label");
wireFurl(annotationsBlock, "#annotations-toggle", ".block-label");

// Hide/show whole panel sections (outline, annotations). When hidden, a
// "Show X" button surfaces above the settings cog. Works in every layout. When
// both are hidden, the right column collapses so the document reclaims it.
const mainSection = document.querySelector<HTMLElement>("#main")!;
function syncPanelColumn(): void {
  const bothHidden =
    docmap.classList.contains("section-hidden") &&
    annotationsBlock.classList.contains("section-hidden");
  mainSection.classList.toggle("panels-collapsed", bothHidden);
}
function wireHideShow(
  section: HTMLElement,
  hideBtnId: string,
  showBtnId: string,
  onChange?: (hidden: boolean) => void,
): { setHidden: (hidden: boolean) => void; isHidden: () => boolean } {
  const showBtn = document.querySelector<HTMLButtonElement>(showBtnId)!;
  const setHidden = (hidden: boolean) => {
    section.classList.toggle("section-hidden", hidden);
    showBtn.hidden = !hidden;
    syncPanelColumn();
    onChange?.(hidden);
  };
  document.querySelector(hideBtnId)?.addEventListener("click", (e) => {
    e.stopPropagation();
    setHidden(true);
  });
  showBtn.addEventListener("click", () => {
    section.classList.remove("collapsed"); // reopen unfurled, not in a collapsed state
    setHidden(false);
  });
  return { setHidden, isHidden: () => section.classList.contains("section-hidden") };
}
wireHideShow(docmap, "#hide-outline", "#show-outline");
// Annotations auto-reveal: the first annotation pops the panel open if it was
// hidden — UNLESS the user deliberately hid it while it already had annotations.
let prevAnnTotal = 0;
let annHiddenWhilePopulated = false;
const annHideShow = wireHideShow(
  annotationsBlock,
  "#hide-annotations",
  "#show-annotations",
  (hidden) => {
    annHiddenWhilePopulated = hidden ? prevAnnTotal > 0 : false;
  },
);

// Document map: an outline built from the headings, kept in sync with the doc.
function renderDocMap(): void {
  docmapList.replaceChildren();
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const li = document.createElement("li");
    li.className = `dm-l${node.attrs.level}`;
    li.textContent = node.textContent || "(untitled)";
    li.addEventListener("click", () => {
      selectRange(pos + 1, pos + 1 + node.content.size);
      // PM's transaction scrollIntoView doesn't move the #editor scroll
      // container reliably; scroll the heading's DOM node to the top directly.
      const dom = view.nodeDOM(pos);
      if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start", behavior: "smooth" });
    });
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

// Strip every annotation mark carrying this id from the document (only matching
// marks, so overlapping annotations are untouched). Marks don't shift positions,
// so positions gathered from the live doc stay valid across the one transaction.
function removeAnnotationMark(id: string): void {
  let tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const m = node.marks.find((mk) => mk.type.name === "annotation" && mk.attrs.id === id);
    if (m) tr = tr.removeMark(pos, pos + node.nodeSize, m);
    return true;
  });
  if (tr.steps.length) view.dispatch(tr);
}

function deleteAnnotation(id: string): void {
  log.remove(id);
  removeAnnotationMark(id); // dispatches → onUpdate re-renders (no-op for orphans)
  renderPanel();
  updateActionBar();
  persistReview();
}

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

  // Keep the action buttons grouped so row-head's space-between only separates
  // the status chip from the actions — not the buttons from each other.
  const actions = document.createElement("div");
  actions.className = "row-actions";

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
    actions.append(toggle);
  }

  const del = document.createElement("button");
  del.className = "row-action";
  del.textContent = "Delete";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteAnnotation(id);
  });
  actions.append(del);
  head.append(actions);

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

  const total = placed.length + orphans.length;
  annotationsBlock.classList.toggle("empty", total === 0);
  // First annotation (0 → some) reveals a hidden panel, unless the user hid it
  // on purpose while it already held annotations.
  if (prevAnnTotal === 0 && total > 0 && annHideShow.isHidden() && !annHiddenWhilePopulated) {
    annHideShow.setHidden(false);
  }
  prevAnnTotal = total;
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
  code: document.querySelector<HTMLElement>("#view-code")!,
  image: document.querySelector<HTMLElement>("#view-image")!,
  html: document.querySelector<HTMLElement>("#view-html")!,
  journal: document.querySelector<HTMLElement>("#view-journal")!,
  pages: document.querySelector<HTMLElement>("#view-pages")!,
  project: document.querySelector<HTMLElement>("#view-project")!,
  kanban: document.querySelector<HTMLElement>("#view-kanban")!,
};
const navBadge = document.querySelector<HTMLElement>(".nav-badge")!;
let journalTitle = "Journal";
let projectTitle = "Project";
let currentProjectId: string | null = null;

const journal = mountJournal(
  viewEls.journal,
  (t) => {
    journalTitle = t;
    if (viewStore.get() === "journal") viewTitle.textContent = t;
  },
  // [[Project: X]] links jump to project X's home page (case-insensitive match
  // on the project name). Consumed even when no such project exists, so it never
  // falls through to creating a junk "Project: X" page.
  (target) => {
    const m = /^Project:\s*(.+)$/i.exec(target);
    if (!m) return false;
    const name = m[1].trim().toLowerCase();
    const proj = listProjects().find((p) => p.name.toLowerCase() === name);
    if (proj) openProject(proj.id);
    return true;
  },
);

function refreshBoard(): void {
  const count = renderKanban(viewEls.kanban, {
    onStartSession: startSessionForItem,
    onOpenSession: openSessionInPanel,
  });
  navBadge.textContent = String(count);
  navBadge.hidden = count === 0;
}

// Start an agent session for an existing card that has no AI conversation yet:
// create it linked to that card (no duplicate card), scoped to the card's
// project, then reveal + open it in the sessions panel.
function startSessionForItem(item: Item, agent: Agent): void {
  const s = createSession({
    title: item.title,
    agent,
    projectId: item.projectId,
    linkToCardId: item.id,
    // Hand the card's text to the agent the moment its TUI launches.
    initialPrompt: item.title,
  });
  refreshBoard();
  app.classList.remove("right-closed"); // ensure the sessions pane is visible
  sessionsPanel.open(s.id);
}

// Open an existing session (from the project page's sessions widget) in the
// sessions panel, revealing the right pane.
function openSessionInPanel(id: string): void {
  app.classList.remove("right-closed");
  sessionsPanel.open(id);
}

// Start a NEW session scoped to the project currently shown (not tied to a
// card). Drops a fresh linked card via createSession, then opens it.
function startProjectSession(agent: Agent): void {
  const projectId = currentProjectId ?? undefined;
  const s = createSession({ title: "Untitled session", agent, projectId });
  refreshBoard();
  app.classList.remove("right-closed");
  sessionsPanel.open(s.id);
}

// projectPage emits this when a [[wiki link]] is clicked inside the notes
// outline; route it to the journal's page view like any other page open.
document.addEventListener("orden:open-page", (e) => {
  const name = (e as CustomEvent<{ name: string }>).detail?.name;
  if (name) openPage(name);
});

const viewStore = createViewStore("review");
viewStore.subscribe((v) => {
  for (const name of Object.keys(viewEls) as View[]) {
    viewEls[name].classList.toggle("active", name === v);
  }
  const titles: Record<View, string> = {
    review: currentDocTitle,
    code: currentDocTitle,
    image: currentDocTitle,
    html: currentDocTitle,
    journal: journalTitle,
    pages: "Pages",
    project: projectTitle,
    kanban: "Kanban",
  };
  viewTitle.textContent = titles[v];
  document.querySelector("#nav-journal")?.classList.toggle("active", v === "journal");
  document.querySelector("#nav-pages")?.classList.toggle("active", v === "pages");
  document.querySelector("#nav-kanban")?.classList.toggle("active", v === "kanban");
  // The Rendered/Source toggle only belongs to HTML file viewers; hide it when
  // we navigate to a default element (kanban/journal/pages/project).
  if (v !== "html" && v !== "code") htmlToggle.hidden = true;
  if (v === "pages") renderPagesIndex(viewEls.pages, openPage);
  if (v === "kanban") refreshBoard();
  if (mobile.matches) app.classList.add("left-closed"); // close drawer after navigating
});

function openPage(name: string): void {
  journal.showPage(name);
  viewStore.set("journal");
}

function renderProject(projectId: string): void {
  // The host serves files from a single root, which maps to exactly one project
  // (per-project roots come later). Show repo files ONLY on that project; every
  // other project gets an empty list so the host root's files don't leak in.
  const project = getProject(projectId);
  const files =
    project && isHostFilesRoot(project, host.capabilities().filesRoot) ? repoFiles : [];
  renderProjectPage(
    viewEls.project,
    projectId,
    refreshBoard,
    startSessionForItem,
    openSessionInPanel,
    startProjectSession,
    (path) => void openRepoFile(path),
    files,
    onProjectChanged,
    removeProjectWithItems,
  );
}

// A project was renamed / re-pathed in place: refresh the sidebar list and the
// view title so they match. (The page itself updated its own header in place.)
function onProjectChanged(): void {
  renderProjects();
  if (currentProjectId) {
    projectTitle = getProject(currentProjectId)?.name ?? "Project";
    if (viewStore.get() === "project") viewTitle.textContent = projectTitle;
  }
}

// Remove a project, deciding what happens to its cards/sessions. "reassign"
// moves them to the default (Homeroom) project so nothing is orphaned;
// "cascade" deletes the cards and sessions (deleteSession also kills the
// agent). Then drop the project and navigate off its now-dead page.
function removeProjectWithItems(id: string, mode: "reassign" | "cascade"): void {
  const cards = itemsByProject(id);
  const sessions = listSessions(true).filter((s) => s.projectId === id);
  if (mode === "reassign") {
    const home = ensureDefaultProject().id;
    for (const s of sessions) setSessionProject(s.id, home);
    for (const c of cards) setItemProject(c.id, home);
  } else {
    for (const s of sessions) deleteSession(s.id);
    for (const c of cards) removeItem(c.id);
  }
  removeProject(id);
  if (currentProjectId === id) currentProjectId = null;
  renderProjects();
  refreshBoard();
  viewStore.set("kanban");
}

// Re-render the project page on a remote change, but never while the user is
// typing in the embedded notes outline (it would destroy the editor mid-stroke).
function refreshProject(): void {
  if (viewStore.get() !== "project" || !currentProjectId) return;
  if (projectNotesHasFocus()) return;
  // Don't rebuild the page out from under an editable control (e.g. the
  // add-item box) — a live card transition would otherwise wipe in-progress
  // typing. Mirrors the notes-focus guard above.
  if (projectPageHasFocus()) return;
  renderProject(currentProjectId);
}

function openProject(projectId: string): void {
  currentProjectId = projectId;
  projectTitle = getProject(projectId)?.name ?? "Project";
  renderProject(projectId);
  viewStore.set("project");
}
void currentProjectId;

journal.showJournal();
refreshBoard();

document.querySelector("#nav-journal")?.addEventListener("click", () => {
  journal.showJournal();
  viewStore.set("journal");
});
document.querySelector("#nav-pages")?.addEventListener("click", () => viewStore.set("pages"));
document.querySelector("#nav-kanban")?.addEventListener("click", () => viewStore.set("kanban"));

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

// Accent color: drive the --accent CSS var (--accent-soft, selection, hovers
// all derive from it). Apply the saved choice now, then wire the picker.
function applyAccent(color: string): void {
  document.documentElement.style.setProperty("--accent", color);
}
applyAccent(settings.accent);

const accentInput = document.querySelector<HTMLInputElement>("#accent-color")!;
accentInput.value = settings.accent;
accentInput.addEventListener("input", () => {
  applyAccent(accentInput.value);
  void saveSettings({ accent: accentInput.value });
});

// Session panel width: a % of viewport width driving --session-width (vw) on
// :root; #app's --right falls back to the responsive clamp when this is unset.
// The width tracks the viewport live (vw), so it stays at the chosen fraction
// on resize. Apply now, then wire the slider — live preview + persist on input.
const panelWidthInput = document.querySelector<HTMLInputElement>("#panel-width")!;
const panelWidthValue = document.querySelector<HTMLElement>("#panel-width-value")!;
function applyPanelWidth(pct: number): void {
  document.documentElement.style.setProperty("--session-width", `${pct}vw`);
}
function showPanelWidth(pct: number): void {
  const px = Math.round((pct / 100) * window.innerWidth);
  panelWidthValue.textContent = `${pct}% · ${px}px`;
}
applyPanelWidth(settings.sessionPanelPct);

panelWidthInput.min = String(MIN_PANEL_PCT);
panelWidthInput.max = String(MAX_PANEL_PCT);
panelWidthInput.value = String(settings.sessionPanelPct);
showPanelWidth(settings.sessionPanelPct);
panelWidthInput.addEventListener("input", () => {
  const pct = Number(panelWidthInput.value);
  showPanelWidth(pct);
  applyPanelWidth(pct);
  void saveSettings({ sessionPanelPct: pct });
});
// The px half of the readout depends on viewport width; refresh it on resize so
// it's accurate whenever the popover is open.
window.addEventListener("resize", () => showPanelWidth(Number(panelWidthInput.value)));

// Font family + size: apply the saved choice now, then wire the selectors.
applyFont(settings.fontFamily, settings.fontSize);

const fontSelect = document.querySelector<HTMLSelectElement>("#font-family")!;
for (const opt of FONT_OPTIONS) {
  const o = document.createElement("option");
  o.value = opt.id;
  o.textContent = opt.label;
  fontSelect.append(o);
}
fontSelect.value = settings.fontFamily;
fontSelect.addEventListener("change", () => {
  applyFont(fontSelect.value, loadSettings().fontSize);
  void saveSettings({ fontFamily: fontSelect.value });
});

const sizeInput = document.querySelector<HTMLInputElement>("#font-size")!;
const sizeValue = document.querySelector<HTMLElement>("#font-size-value")!;
sizeInput.min = String(MIN_FONT_SIZE);
sizeInput.max = String(MAX_FONT_SIZE);
sizeInput.value = String(settings.fontSize);
sizeValue.textContent = `${settings.fontSize}px`;
sizeInput.addEventListener("input", () => {
  const size = Number(sizeInput.value);
  sizeValue.textContent = `${size}px`;
  applyFont(loadSettings().fontFamily, size);
  updateTerminalFonts();
  void saveSettings({ fontSize: size });
});

// Completed-card fade dwell time: how long a card sits in Complete before it
// drops off the board/lists. Persist on change, then re-render the board so the
// new threshold takes effect immediately.
const fadeSelect = document.querySelector<HTMLSelectElement>("#complete-fade")!;
fadeSelect.value = String(settings.completeFadeHours);
fadeSelect.addEventListener("change", () => {
  void saveSettings({ completeFadeHours: Number(fadeSelect.value) });
  refreshBoard();
});
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
  // Use opts.markdown verbatim, ignoring any saved markdown — for a live reload
  // when the underlying file changed on disk. Saved annotations are still kept
  // and re-anchored onto the new text.
  forceMarkdown?: boolean;
}): void {
  currentDocKey = opts.key;
  currentDocTitle = opts.title;
  void host.vault.set("ui", "last-doc", opts.key);

  const saved = loadState(opts.key);
  const parsed = markdownParser.parse(
    opts.forceMarkdown ? opts.markdown : (saved?.markdown ?? opts.markdown),
  );
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
// Repo docs come through host.files now (path + title); content is read on open.
// Kept in a module variable so the project file explorer (projectPage) can list
// them without re-fetching. The FILES nav itself shows only recently-OPENED files.
const repoFiles = await host.files.list("repo");

function setActiveFile(path: string | null): void {
  recentList.querySelectorAll<HTMLElement>(".nav-file").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === path);
  });
}

// Per-file, session-only override of the HTML render/source choice, keyed by
// repo path. The topbar toggle sets it; it is NOT persisted (the setting is the
// durable default). Effective choice = override if present, else the setting.
const htmlRenderOverride = new Map<string, boolean>();
function effectiveHtmlRender(path: string): boolean {
  return htmlRenderOverride.get(path) ?? loadSettings().htmlRender;
}

// Show/configure the topbar Rendered/Code toggle, but only for HTML files. The
// label names the action (what a click does), not the current state.
const htmlToggle = document.querySelector<HTMLButtonElement>("#html-view-toggle")!;
function updateHtmlToggle(path: string | null): void {
  const ext = path ? (path.split(".").pop() ?? "").toLowerCase() : "";
  const isHtml = ext === "html" || ext === "htm";
  htmlToggle.hidden = !isHtml;
  if (!isHtml || !path) return;
  htmlToggle.textContent = effectiveHtmlRender(path) ? "View source" : "View rendered";
}

// Open a repo file in the right viewer for its type. The single funnel for every
// entry point (FILES nav, project file explorer, boot default-open) so each
// records a recent. Markdown → prose/annotation editor; images → image viewer;
// HTML → rendered (sandboxed iframe) or source per the effective flag; all else
// → read-only code viewer.
async function openRepoFile(path: string): Promise<void> {
  const title = repoFiles.find((f) => f.path === path)?.title ?? (path.split("/").pop() ?? path);
  const kind = viewerFor(path, effectiveHtmlRender(path));
  currentDocKey = `review:${path}`;
  currentDocTitle = title;

  if (kind === "prose") {
    // markdown read happens inside loadReviewDoc's funnel
    const content = await host.files.read("repo", path);
    loadReviewDoc({ key: `review:${path}`, title, markdown: content });
    viewStore.set("review");
  } else {
    void host.vault.set("ui", "last-doc", currentDocKey);
    if (kind === "image") {
      renderImageView(viewEls.image, { title, path, projectId: "repo" }); // bytes load via /repo-file/ — Task 9: real per-file projectId
    } else if (kind === "html") {
      renderHtmlView(viewEls.html, { title, content: await host.files.read("repo", path) });
    } else {
      renderCodeView(viewEls.code, { title, path, content: await host.files.read("repo", path) });
    }
    viewTitle.textContent = title;
    viewStore.set(kind as View);
  }
  updateHtmlToggle(path);
  setActiveFile(path);
  recordRecentFile("repo", path); // Task 9 wires the real per-file projectId
  renderRecentFiles();
}

// Topbar toggle: flip this file's render/source choice for the session, then
// re-open so it routes through the new viewer.
htmlToggle.addEventListener("click", () => {
  const path = currentDocKey.startsWith("review:") ? currentDocKey.slice("review:".length) : null;
  if (!path) return;
  htmlRenderOverride.set(path, !effectiveHtmlRender(path));
  void openRepoFile(path);
});

// FILES nav: the top few most-recently-opened repo files (not the whole repo).
function renderRecentFiles(): void {
  recentList.replaceChildren();
  const recents = listRecentFiles(SHOW_CAP);
  if (recents.length === 0) {
    const hint = document.createElement("p");
    hint.className = "nav-file-empty";
    hint.textContent = "No recent files";
    recentList.append(hint);
    return;
  }
  for (const { path } of recents) {
    const a = document.createElement("a");
    a.className = "nav-file";
    a.dataset.path = path;
    a.title = path;
    const name = document.createElement("span");
    name.className = "nav-file-name";
    name.textContent = path.split("/").pop() ?? path;
    const meta = document.createElement("span");
    meta.className = "nav-file-meta";
    meta.textContent = path.includes("/") ? path.replace(/\/[^/]+$/, "") : "/";
    a.append(name, meta);
    a.addEventListener("click", () => void openRepoFile(path));
    recentList.append(a);
  }
}
renderRecentFiles();

// Initial review document: last-opened repo file, else the design doc, else the
// built-in sample (which seeds demo annotations on first run).
const lastKey = await host.vault.get<string>("ui", "last-doc");
const lastFile = repoFiles.find((f) => `review:${f.path}` === lastKey);
const defaultFile =
  lastFile ?? repoFiles.find((f) => f.path.includes("orden-design")) ?? repoFiles[0];
if (defaultFile) {
  await openRepoFile(defaultFile.path);
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

// --- Projects registry (local/remote file access arrives with the host backend) ---
const projectList = document.querySelector<HTMLElement>("#project-list")!;
const addProjectBtn = document.querySelector<HTMLElement>("#add-project")!;

function renderProjects(): void {
  projectList.replaceChildren();
  for (const p of listProjects()) {
    const item = document.createElement("a");
    item.className = "nav-proj-item";
    item.title =
      p.source.kind === "local" ? `${p.name} — ${p.source.path}` : p.name;
    const name = document.createElement("div");
    name.className = "nav-proj-label";
    name.textContent = p.name;
    // Subtitle: path for local projects, nothing for ephemeral ones (Homeroom) —
    // "ephemeral" is an implementation detail, not worth surfacing.
    const metaText =
      p.source.kind === "local"
        ? p.source.path
        : p.source.kind === "ephemeral"
          ? ""
          : p.source.kind;
    item.append(name);
    if (metaText) {
      const meta = document.createElement("div");
      meta.className = "nav-proj-meta";
      meta.textContent = metaText;
      item.append(meta);
    }
    item.addEventListener("click", () => openProject(p.id));
    projectList.append(item);
  }
}

addProjectBtn.addEventListener("click", () =>
  openProjectModal({
    mode: "create",
    onSaved: (project) => {
      renderProjects();
      openProject(project.id);
    },
  }),
);
renderProjects();

// Right pane: sessions (claude/opencode conversations). Creating one drops a
// linked card into the kanban planning column (separate-but-linked). The session open
// last run is remembered (vault ui/last-session) so a reload reopens it.
const lastSessionId = (await host.vault.get<string>("ui", "last-session")) || null;
// The native Chat tab's mount fn, bound to the host + change feed.
const chatMount = createChatMount(host, onVaultChange);
const sessionsPanel = mountSessionsPanel({
  container: document.querySelector<HTMLElement>("#sessions")!,
  list: () => listSessions(loadSettings().showArchived),
  get: getSession,
  initialOpenId: lastSessionId,
  persistOpen: (id) => void host.vault.set("ui", "last-session", id ?? ""),
  projectName: (id) => getProject(id)?.name ?? "—",
  isComplete: (id) => {
    const s = getSession(id);
    return s ? isSessionComplete(s) : false;
  },
  create: (opts) => {
    // On a project page, scope the new session (and its linked card) to that
    // project; otherwise it falls to the default Homeroom project.
    const projectId =
      viewStore.get() === "project" && currentProjectId ? currentProjectId : undefined;
    const s = createSession({ ...opts, projectId });
    refreshBoard(); // the new linked planning card shows on the board
    refreshProject(); // …and on the project page, if that's the active view
    return s;
  },
  mountTerminal: (container, id) => mountTerminal(container, id, () => markSessionTouched(id)),
  // Native Chat tab: a SEPARATE ChatBackend agent per session (independent of the
  // Terminal's tmux agent — unifying them is future work). Only on hosts that can
  // spawn real agents (NodeHost); the browser host's chat backend throws, so we
  // omit mountChat there and the panel hides the Chat tab.
  mountChat: host.capabilities().spawnSessions
    ? chatMount
    : undefined,
  archive: (id) => {
    archiveSession(id);
    refreshBoard(); // its card moved to Done
    refreshProject(); // reflect the move on the project page too (was board-only)
  },
  remove: (id) => {
    deleteSession(id);
    refreshBoard(); // its card is gone too
    refreshProject();
  },
  cleanup: (id) => {
    const s = getSession(id);
    if (s && isAbandoned(s)) {
      deleteSession(id);
      refreshBoard();
      refreshProject();
    }
  },
  close: () => app.classList.add("right-closed"),
});

// Show archived (Done) sessions in the list.
const showArchivedCb = document.querySelector<HTMLInputElement>("#show-archived");
if (showArchivedCb) {
  showArchivedCb.checked = loadSettings().showArchived;
  showArchivedCb.addEventListener("change", () => {
    void saveSettings({ showArchived: showArchivedCb.checked });
    sessionsPanel.refresh();
  });
}

// When on, the MCP session_create tool launches the agent immediately; when
// off, it only drops a planning card on the board.
const autoLaunchCb = document.querySelector<HTMLInputElement>("#session-autolaunch");
if (autoLaunchCb) {
  autoLaunchCb.checked = loadSettings().sessionAutoLaunch;
  autoLaunchCb.addEventListener("change", () => {
    void saveSettings({ sessionAutoLaunch: autoLaunchCb.checked });
  });
}

// HTML render default: when on, .html files open rendered; off shows source.
// This is the default only — a per-file topbar toggle can override it for the
// session. Changing it re-opens the current file if it's HTML, so the change is
// visible immediately.
const htmlRenderCb = document.querySelector<HTMLInputElement>("#html-render");
if (htmlRenderCb) {
  htmlRenderCb.checked = loadSettings().htmlRender;
  htmlRenderCb.addEventListener("change", async () => {
    await saveSettings({ htmlRender: htmlRenderCb.checked });
    const path = currentDocKey.startsWith("review:")
      ? currentDocKey.slice("review:".length)
      : null;
    const ext = path ? (path.split(".").pop() ?? "").toLowerCase() : "";
    if (path && (ext === "html" || ext === "htm") && !htmlRenderOverride.has(path)) {
      void openRepoFile(path);
    }
  });
}

// Vault location: a read-only path so the user knows where their data lives.
// The in-browser host has no on-disk vault, so it reports browser storage.
const vaultLocationEl = document.querySelector<HTMLElement>("#vault-location");
if (vaultLocationEl) {
  const vaultRoot = host.capabilities().vaultRoot;
  vaultLocationEl.textContent = vaultRoot ?? "Browser storage (in-memory host)";
  if (vaultRoot) vaultLocationEl.title = vaultRoot;
}

// --- Omnisearch: a multi-purpose search field in the topbar. What it searches
// (pages / sessions / files / commands) is still TBD; this wires the UI and a
// single onSearch() seam so the behaviour can drop in later without touching
// markup. Cmd/Ctrl+K focuses it, Enter submits, Escape clears + blurs. ---
const searchForm = document.querySelector<HTMLFormElement>("#omnisearch-form");
const searchInput = document.querySelector<HTMLInputElement>("#omnisearch");

function onSearch(query: string): void {
  // Seam: broadcast the query so a future feature can listen, without committing
  // to a search target yet. Replace with real routing when decided.
  document.dispatchEvent(new CustomEvent("orden:search", { detail: { query } }));
}

if (searchForm && searchInput) {
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    onSearch(searchInput.value.trim());
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      searchInput.blur();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });
}

// Live updates: when the vault changes (e.g. an agent writes over the MCP bus),
// re-load the affected store and re-render only the views that depend on it.
// Editor re-renders are focus-guarded so we never clobber what you're typing.
// No-op on BrowserHost (single writer).
onVaultChange((ns, key) => {
  void (async () => {
    const v = viewStore.get();
    switch (ns) {
      case "files": {
        // A repo file changed on disk. If it's the one we're showing, re-read and
        // re-render so external edits (by an agent, git, or a collaborator) appear
        // live. Non-prose viewers always re-render; the markdown editor reload is
        // guarded so it never clobbers what the user is actively typing.
        if (currentDocKey === `review:${key}`) {
          const kind = viewerFor(key, effectiveHtmlRender(key));
          if (kind === "image") {
            renderImageView(viewEls.image, { title: currentDocTitle, path: key, projectId: "repo" }); // Task 9: real per-file projectId
          } else if (kind === "html") {
            const content = await host.files.read("repo", key);
            renderHtmlView(viewEls.html, { title: currentDocTitle, content });
          } else if (kind === "code") {
            const content = await host.files.read("repo", key);
            renderCodeView(viewEls.code, { title: currentDocTitle, path: key, content });
          } else if (!view.hasFocus()) {
            const markdown = await host.files.read("repo", key);
            loadReviewDoc({ key: currentDocKey, title: currentDocTitle, markdown, forceMarkdown: true });
          }
        }
        break;
      }
      case "pages":
        await hydratePages(host);
        if (v === "pages") renderPagesIndex(viewEls.pages, openPage);
        else if (v === "journal") journal.refresh();
        else if (v === "project") refreshProject(); // notes page may have changed
        break;
      case "cards":
        await hydrateCards(host);
        refreshBoard(); // kanban board + badge count
        notifyBlockedTransitions(); // toast when a session starts waiting on you
        refreshProject();
        break;
      case "projects":
        await hydrateProjects(host);
        renderProjects();
        refreshProject();
        break;
      case "docs": {
        await hydrateDocs(host);
        const saved = loadState(currentDocKey);
        if (v === "review" && saved && !view.hasFocus()) {
          loadReviewDoc({ key: currentDocKey, title: currentDocTitle, markdown: saved.markdown });
        }
        break;
      }
      case "settings": {
        await hydrateSettings(host);
        const s = loadSettings();
        applyAccent(s.accent);
        applyFont(s.fontFamily, s.fontSize);
        sessionsPanel.refresh();
        break;
      }
      case "sessions":
        await hydrateSessions(host);
        sessionsPanel.refresh();
        refreshProject(); // the project page's active-sessions widget
        break;
      case "feedback":
        await hydrateOutbox(host);
        break;
      case "ui": {
        // An agent asked (via the MCP panel_open tool) to steer the main panel.
        if (key !== "panel-intent") break;
        // Don't yank the panel out from under someone who's actively typing.
        if (view.hasFocus()) break;
        const intent = await host.vault.get<PanelIntent>("ui", "panel-intent");
        if (!intent) break;
        dispatchPanelIntent(intent, {
          openRepoFile: (path) => void openRepoFile(path),
          openPage,
          openKanban: () => {
            viewStore.set("kanban");
            refreshBoard();
          },
          resolveCardId: (target) => {
            // Match by id first, then by case-insensitive title.
            if (getItem(target)) return target;
            const lower = target.trim().toLowerCase();
            return listItems().find((i) => i.title.trim().toLowerCase() === lower)?.id;
          },
          openCard: (id) => {
            if (!getItem(id)) return false;
            viewStore.set("kanban");
            refreshBoard();
            openCardModal(id, {
              onStartSession: startSessionForItem,
              onOpenSession: openSessionInPanel,
              onChange: refreshBoard,
            });
            return true;
          },
        });
        break;
      }
    }
  })();
});

// Connection recovered (host restarted / network blip): the socket auto-reopens,
// so re-hydrate every store and re-render the active view to catch any writes we
// missed while disconnected. No-op on BrowserHost.
onReconnect(() => {
  void (async () => {
    await hydrateAll();
    const s = loadSettings();
    applyAccent(s.accent);
    applyFont(s.fontFamily, s.fontSize);
    renderProjects();
    refreshBoard();
    sessionsPanel.refresh();
    const v = viewStore.get();
    if (v === "pages") renderPagesIndex(viewEls.pages, openPage);
    else if (v === "journal") journal.refresh();
    else if (v === "project") refreshProject();
  })();
});

// Dev handle for inspection / screenshot-driven iteration.
(window as unknown as { orden: unknown }).orden = { view, log, addAnnotation, viewStore };

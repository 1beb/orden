import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { sendFeedback, assignBlockIds } from "@orden/annotation-core";
import { schema, markdownParser, markdownSerializer } from "./schema";
import { buildInputRules } from "./inputrules";
import { reanchorQuote } from "./pm-reanchor";
import { saveState, loadState, hydrateDocs } from "./persist";
import { VaultSink, hydrateOutbox } from "./sink-local";
import {
  listProjects,
  getProject,
  hydrateProjects,
  removeProject,
  ensureDefaultProject,
} from "./projects";
import { openProjectModal } from "./projectModal";
import { hydratePages, getPageMarkdown, pagesIndex } from "./pages";
import { listFiles } from "./files";
import { fuzzyRank } from "./fuzzy";
import { createCommandPalette } from "./commandPalette";
import type { SearchSource, Command } from "./commandPalette";
import {
  hydrateCards,
  listItems,
  getItem,
  cardSessionIds,
  itemsByProject,
  setItemProject,
  promptForItem,
  removeItem,
  type Item,
} from "./cards";
import {
  hydrateLearnings,
  openForCard,
  listLearnings,
  setLearningStatus,
  addLearningComment,
} from "./learningsStore";
import { renderLearnings } from "./learningsView";
import { learningsCommentFocused } from "./learningsFocus";
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
import { renderProjectsIndex } from "./projectsIndex";
import { renderKanban } from "./kanban";
import { renderProjectPage, projectPageHasFocus, focusProjectAddItem } from "./projectPage";
import { renderCodeView, assignCodeBlockIds } from "./codeView";
import { AnnotationStore } from "./annotationStore";
import { fileSource } from "./viewerSource";
import { paintHighlights, setActiveHighlight, clearHighlights, ensureHighlightStyles } from "./textOverlay";
import { renderSourcePanel } from "./sourcePanel";
import { toAnnotationSendInput } from "./annotationDeliveryMap";
import { buildTextAnnotation } from "./textAnnotation";
import { mountDomAnnotator } from "./domAnnotator";
import { buildNoteComposer } from "./noteComposer";
import type { Source } from "@orden/annotation-core";
import { viewerFor } from "./codeHighlight";
import { renderImageView, renderHtmlView } from "./richView";
import { normalizeRect, renderRegionBoxes, buildRegionAnnotation } from "./regionOverlay";
import {
  hydrateRecentFiles,
  recordRecentFile,
  listRecentFiles,
  SHOW_CAP,
} from "./recentFiles";
import { AnnotationLog } from "./store";
import { addAnnotation, scanAnnotations } from "./annotations";
import { mountAnnotator } from "./annotator-ui";
import { buildFeedbackPayload, type FeedbackItem } from "./feedback";
import { openPreview } from "./preview";
import { createViewStore, type View } from "./viewState";
import { mountJournal } from "./journal";
import { markFor } from "./agentMarks";
import { buildModeGrid } from "./settingsModeGrid";
import {
  hydrateSettings,
  loadSettings,
  saveSettings,
  MIN_PANEL_PCT,
  MAX_PANEL_PCT,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  TIME_ZONE_OPTIONS,
  DEFAULT_LEARNING_PROMPT,
  type StartupView,
} from "./settings";
import {
  hydrateKeybindings,
  installKeybindings,
  onAction,
  chordsFor,
  formatChord,
  isTypingContext,
} from "./keybindings";
import { renderHelp } from "./helpView";
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
const annotationStore = new AnnotationStore(host.vault);
async function hydrateAll(): Promise<void> {
  await Promise.all([
    hydrateSettings(host),
    hydrateOutbox(host),
    hydratePages(host),
    hydrateProjects(host),
    hydrateDocs(host),
    hydrateCards(host),
    hydrateLearnings(host),
    hydrateSessions(host),
    hydrateRecentFiles(host),
    hydrateKeybindings(host),
    annotationStore.hydrate(),
  ]);
}
await hydrateAll();
// Resolve the current identity once (host is ready post-hydrate). New text
// annotations are stamped with this creator; falls back to a local placeholder.
const meIdentity = await host.identity.me();
const me = { kind: "human" as const, id: meIdentity?.id ?? "me" };
// Sweep dead "Untitled" stub sessions left by prior runs (touched or not) so they
// don't linger in the active list. Boot-only: hydrateAll also runs on reconnect,
// where reaping could nuke a freshly-started, not-yet-titled session.
reapDeadSessions();

// Toast when a session's linked card flips to "blocked" — Claude finished its
// turn and is waiting on you (driven by the Stop hook → host → card state, which
// arrives over the change feed). Seeded from the boot state so pre-existing
// blocked cards don't fire on load.
const cardWaitState = new Map<string, string>(listItems().map((i) => [i.id, i.state]));
function showToast(text: string, duration = 6000): void {
  const t = document.createElement("div");
  t.className = "orden-toast";
  t.textContent = text;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, duration);
}

declare const __BUILD_TIME__: number;

function checkForUpdates(): void {
  const btn = document.querySelector<HTMLButtonElement>("#new-build-available");
  if (!btn) return;
  fetch("/build-info")
    .then((r) => r.json())
    .then((info: { buildTime: number }) => {
      if (info.buildTime > __BUILD_TIME__) {
        btn.hidden = false;
      }
    })
    .catch(() => {}); // silently ignore fetch failures
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

const DOC_TITLE = "Review";
const log = new AnnotationLog();
const sink = new VaultSink();
let feedbackTarget: "agent" | "human" = "agent";
let currentDocKey = "review:default";
let currentDocProjectId = "repo";
let currentDocTitle = DOC_TITLE;
// The repo file currently registered with host.files.watch (or null). Tracked
// separately from currentDoc* because we only re-arm the host watch when the
// actual on-disk file changes, not on every view switch.
let watchedDoc: { projectId: string; path: string } | null = null;
const docAnnotationSessions = new Set<string>();

function persistReview(): void {
  saveState(currentDocKey, markdownSerializer.serialize(view.state.doc), log.all());
}

const state = EditorState.create({
  doc: markdownParser.parse(""),
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
const sourceSendBtn = document.querySelector<HTMLButtonElement>("#source-send")!;

app.dataset.target = feedbackTarget;

const leftnav = document.querySelector<HTMLElement>("#leftnav")!;
const panel = document.querySelector<HTMLElement>("#panel")!;
const annotationsBlock = document.querySelector<HTMLElement>(".annotations-block")!;
const mobile = window.matchMedia("(max-width: 860px)");

// The panel becomes a bottom sheet when the CENTER column can't fit the 320px
// side panel beside a readable document — true on phones, but also in a desktop
// window squeezed by the open session pane. A media query can't see pane state,
// so a ResizeObserver on #view-area decides, and the .panel-sheet class carries
// the sheet styles (see styles.css). Entering sheet mode starts collapsed.
const viewArea = document.querySelector<HTMLElement>("#view-area")!;
// Sheet whenever the document column would end up narrower than the 320px
// panel itself — the annotation rail must never out-width the document.
const PANEL_SHEET_BELOW = 650;
function syncPanelSheet(): void {
  const sheet = viewArea.clientWidth > 0 && viewArea.clientWidth < PANEL_SHEET_BELOW;
  if (sheet === viewArea.classList.contains("panel-sheet")) return;
  viewArea.classList.toggle("panel-sheet", sheet);
  panel.classList.toggle("sheet-collapsed", sheet);
}
new ResizeObserver(syncPanelSheet).observe(viewArea);

// In sheet mode, tapping the annotations header (but not the Send/Copy buttons)
// collapses/expands the sheet.
annotationsBlock.querySelector("header")?.addEventListener("click", (e) => {
  if (!viewArea.classList.contains("panel-sheet")) return;
  if ((e.target as HTMLElement).closest(".panel-actions")) return;
  panel.classList.toggle("sheet-collapsed");
});

function toggleLeft(): void {
  dropFocusSnapshot();
  const opening = app.classList.contains("left-closed");
  app.classList.toggle("left-closed");
  if (opening && mobile.matches) app.classList.add("right-closed"); // one drawer at a time
  syncBottomNavSessions();
}
function toggleRight(): void {
  dropFocusSnapshot();
  const opening = app.classList.contains("right-closed");
  app.classList.toggle("right-closed");
  if (opening && mobile.matches) app.classList.add("left-closed");
  syncBottomNavSessions();
}
function syncBottomNavSessions(): void {
  const open = !app.classList.contains("right-closed");
  document.querySelector("#bn-sessions")?.classList.toggle("active", open);
}

const toggleLeftBtn = document.querySelector<HTMLButtonElement>("#toggle-left");
const toggleRightBtn = document.querySelector<HTMLButtonElement>("#toggle-right");
toggleLeftBtn?.addEventListener("click", toggleLeft);
toggleRightBtn?.addEventListener("click", toggleRight);
document.querySelector("#scrim")?.addEventListener("click", () => {
  app.classList.add("left-closed", "right-closed");
  syncBottomNavSessions();
});
// All shortcuts route through the keybindings dispatcher (vault-backed,
// rebindable in the help view). Actions register where their deps live.
installKeybindings();
onAction("nav.toggle", toggleLeft);
onAction("sessions.toggle", toggleRight);
// Topbar tooltips reflect the (possibly rebound) chord at boot.
if (toggleLeftBtn) toggleLeftBtn.title = `Toggle navigation (${formatChord(chordsFor("nav.toggle")[0])})`;
if (toggleRightBtn) toggleRightBtn.title = `Toggle session (${formatChord(chordsFor("sessions.toggle")[0])})`;

// Responsive layout: on mobile both side panes start closed (they become
// fixed drawers). Sheet mode for #panel is owned by syncPanelSheet above.
function applyLayout(isMobile: boolean): void {
  if (isMobile) {
    app.classList.add("left-closed", "right-closed");
  } else {
    app.classList.remove("left-closed", "right-closed");
  }
  syncBottomNavSessions();
}
mobile.addEventListener("change", (e) => applyLayout(e.matches));

// On mobile the session pane is position:fixed, and the on-screen keyboard
// shrinks only the VISUAL viewport: the browser then scrolls the layout
// viewport to reveal the focused input, carrying the pane's header off-screen.
// Pin the pane to the visual viewport while the keyboard is up so the header
// stays reachable. (interactive-widget=resizes-content in index.html covers
// Chrome/Android; this covers iOS Safari, which ignores that meta.)
const sessionsPane = document.querySelector<HTMLElement>("#sessions");
const vv = window.visualViewport;
if (sessionsPane && vv) {
  const pinSessionsToViewport = (): void => {
    const keyboardOpen = mobile.matches && vv.height < window.innerHeight - 1;
    if (keyboardOpen) {
      sessionsPane.style.top = `${vv.offsetTop}px`;
      sessionsPane.style.height = `${vv.height}px`;
    } else {
      sessionsPane.style.removeProperty("top");
      sessionsPane.style.removeProperty("height");
    }
  };
  vv.addEventListener("resize", pinSessionsToViewport);
  vv.addEventListener("scroll", pinSessionsToViewport);
}

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
// #panel is a persistent sibling of the views inside #view-area; the collapse
// (both sections hidden) is driven by a class on #view-area so it hides the
// panel across every viewer, not just the review view. (viewArea is declared
// with the sheet-mode logic above.)
function syncPanelColumn(): void {
  // The outline counts as "gone" when the user hid it OR when it isn't rendered
  // at all (code/image, or an HTML doc with no extractable outline — in those
  // cases CSS display:none leaves offsetParent null). Otherwise hiding only the
  // annotations on an outline-less view would never collapse the column.
  const outlineGone =
    docmap.classList.contains("section-hidden") || docmap.offsetParent === null;
  const annGone = annotationsBlock.classList.contains("section-hidden");
  viewArea.classList.toggle("panels-collapsed", outlineGone && annGone);
}
function wireHideShow(
  section: HTMLElement,
  hideBtnId: string,
  showBtnId: string,
  onChange?: (hidden: boolean) => void,
): { setHidden: (hidden: boolean) => void; isHidden: () => boolean } {
  const showBtn = document.querySelector<HTMLButtonElement>(showBtnId)!;
  const setHidden = (hidden: boolean) => {
    dropFocusSnapshot(); // a manual pane change exits focus mode
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
const outlineHideShow = wireHideShow(docmap, "#hide-outline", "#show-outline");
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

// One key for the whole context panel: hidden means BOTH sections hidden;
// toggling from any mixed state hides both, toggling from fully-hidden shows both.
function toggleContextPanel(): void {
  const hidden = outlineHideShow.isHidden() && annHideShow.isHidden();
  outlineHideShow.setHidden(!hidden);
  annHideShow.setHidden(!hidden);
}
onAction("context.toggle", toggleContextPanel);

// Focus mode: snapshot which panes are visible, hide them all; the same chord
// restores the snapshot. Any individual pane change in between drops the
// snapshot (via dropFocusSnapshot in the toggles), so focus mode exits
// implicitly rather than fighting the user.
interface FocusSnapshot {
  leftClosed: boolean;
  rightClosed: boolean;
  outlineHidden: boolean;
  annHidden: boolean;
}
let focusSnapshot: FocusSnapshot | null = null;
let applyingFocus = false;
function dropFocusSnapshot(): void {
  if (!applyingFocus) focusSnapshot = null;
}
function toggleFocusMode(): void {
  applyingFocus = true;
  try {
    if (focusSnapshot) {
      const s = focusSnapshot;
      focusSnapshot = null;
      app.classList.toggle("left-closed", s.leftClosed);
      app.classList.toggle("right-closed", s.rightClosed);
      syncBottomNavSessions();
      outlineHideShow.setHidden(s.outlineHidden);
      annHideShow.setHidden(s.annHidden);
    } else {
      focusSnapshot = {
        leftClosed: app.classList.contains("left-closed"),
        rightClosed: app.classList.contains("right-closed"),
        outlineHidden: outlineHideShow.isHidden(),
        annHidden: annHideShow.isHidden(),
      };
      app.classList.add("left-closed", "right-closed");
      syncBottomNavSessions();
      outlineHideShow.setHidden(true);
      annHideShow.setHidden(true);
    }
  } finally {
    applyingFocus = false;
  }
}
onAction("focus.toggle", toggleFocusMode);

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

// Build the outline for a rendered HTML doc from its own h1–h6. Owned HTML is
// same-origin, so we can read the iframe's headings and scroll them into view on
// click — mirroring renderDocMap's behaviour for the review doc. Returns the
// number of headings found so the caller can decide whether to show the outline.
function renderHtmlDocMap(htmlDoc: Document): number {
  docmapList.replaceChildren();
  const headings = htmlDoc.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  headings.forEach((h) => {
    const level = Number(h.tagName.slice(1));
    const li = document.createElement("li");
    li.className = `dm-l${level}`;
    li.textContent = (h.textContent ?? "").trim() || "(untitled)";
    li.addEventListener("click", () => {
      h.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    docmapList.append(li);
  });
  return headings.length;
}

const annotator = mountAnnotator(view, log, () => renderPanel(), (_body) => {
  if (docAnnotationSessions.has(currentDocKey)) return;
  docAnnotationSessions.add(currentDocKey);
  createSession({
    title: `Annotations from ${currentDocTitle}`,
    agent: "opencode",
    projectId: currentDocProjectId,
  });
  refreshBoard();
});

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

// --- Text-annotation wiring for non-prose viewers (code today; html/owned-body
// in Task 8). The code panel reuses the SAME `#annotation-list` element as the
// review panel, so entering review re-runs renderPanel() and leaving a text view
// tears the annotator down to avoid stale highlights/state leaking across views.
// `win` is the realm whose CSS.highlights the active text painted into — the parent
// for the code viewer, the iframe's contentWindow for owned HTML. Teardown clears
// that SAME realm so highlights don't leak across views.
let activeText: { source: Source; root: Element; annotator: { destroy(): void }; win: Window } | null = null;

function teardownActiveText(): void {
  if (!activeText) return;
  activeText.annotator.destroy();
  clearHighlights(activeText.win);
  activeText = null;
  // Only surrender the shared panel state if no image view has already claimed
  // it. On image→code the new opener sets activePanelSource before the
  // view-switch teardown runs; clearing unconditionally would null it out.
  if (!activeImage) {
    activePanelSource = null;
    reRenderActiveSource = () => {};
  }
  refreshSourceSend();
}

// The source-view (code/image/html) Send affordance lives separately from the
// review panel's #primary-action/#copy buttons so it can't tangle their state.
// `activePanelSource` is the source whose annotations the panel currently shows;
// set by the text/image openers' rerender, cleared on their teardown.
let activePanelSource: Source | null = null;

// Show the source Send button only on an annotatable source view (code/image/html)
// when the active source has at least one OPEN annotation. Hidden in review and on
// non-source views, leaving the review Approve/Copy buttons untouched.
function refreshSourceSend(): void {
  const v = viewStore.get();
  const isSourceView = v === "code" || v === "image" || v === "html";
  const open = activePanelSource
    ? annotationStore.forSource(activePanelSource).filter((a) => a["orden:status"] === "open")
    : [];
  sourceSendBtn.hidden = !(isSourceView && activePanelSource !== null && open.length > 0);
}

// Deliver the active source's OPEN annotations to the agent working that plan via
// the host. A not-linked result is a normal outcome (arbitrary files often have no
// session), not an error — surface it as a toast and leave the annotations open.
async function sendSourceAnnotations(): Promise<void> {
  const source = activePanelSource;
  if (!source) return;
  const open = annotationStore.forSource(source).filter((a) => a["orden:status"] === "open");
  if (open.length === 0) return;
  const planDoc = source.kind === "file" ? source.vaultPath : source.url;
  sourceSendBtn.disabled = true;
  try {
    const result = await host.sessions.annotationSend(toAnnotationSendInput(source, open));
    if (result.ok) {
      for (const a of open) {
        annotationStore.replace(source, a.id, { ...a, "orden:status": "sent" });
      }
      // Re-render the live source panel so it reflects the new "sent" status.
      reRenderActiveSource();
      showToast(`Sent ${open.length} annotation${open.length === 1 ? "" : "s"} to ${result.target}`);
    } else {
      showToast(`No agent session linked to ${planDoc} — annotation saved`);
    }
  } catch {
    showToast("Couldn't deliver — saved locally");
  } finally {
    sourceSendBtn.disabled = false;
    refreshSourceSend();
  }
}

// Re-render the live source panel after a status change. Each opener owns its own
// rerender closure; we re-invoke it by re-opening the panel through the stored hook.
let reRenderActiveSource: () => void = () => {};

sourceSendBtn.addEventListener("click", () => void sendSourceAnnotations());

// Wire a rendered text root (code / plain-text / owned-HTML body) to the store,
// panel, overlay, and selection annotator. `getSelection` lets an iframe pass its
// own document's selection (Task 8); the in-page code viewer passes window's.
// `opts.win`/`opts.rectOffset` target an iframe realm: ranges, the Highlight
// constructor, and CSS.highlights all come from `win`, and the pill is shifted by
// `rectOffset` into parent coords. The in-page code viewer passes no opts (parent
// realm, zero offset). `opts.injectStyles` adds the ::highlight rules for an iframe
// document, which doesn't load the app stylesheet.
function openAnnotatableText(
  root: Element,
  source: Source,
  getSelection: () => Selection | null,
  opts?: {
    win?: Window;
    rectOffset?: () => { x: number; y: number };
    injectStyles?: boolean;
  },
): void {
  teardownActiveText();

  const win = opts?.win ?? (window as Window);
  if (opts?.injectStyles && root.ownerDocument) ensureHighlightStyles(root.ownerDocument);

  const rerender = (): void => {
    const anns = annotationStore.forSource(source);
    const placed = paintHighlights(root, anns, win);
    const byId = new Map(placed.map((p) => [p.id, p.range] as const));
    renderSourcePanel(listEl, anns, {
      onSelect: (id) => {
        const r = byId.get(id) ?? null;
        setActiveHighlight(r, win);
        r?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      },
      onDelete: (id) => {
        annotationStore.remove(source, id);
        rerender();
      },
    });
    refreshSourceSend();
  };

  activePanelSource = source;
  reRenderActiveSource = rerender;

  const annotator = mountDomAnnotator({
    root,
    getSelection,
    rectOffset: opts?.rectOffset,
    onCreate: (range, note) => {
      const ann = buildTextAnnotation({ source, range, root, note, creator: me });
      if (!ann) return;
      annotationStore.add(source, ann);
      rerender();
    },
  });

  activeText = { source, root, annotator, win };
  rerender();
}

// Render a repo code/plain-text file and wire it for annotation. Shared by the
// initial open path and the change-feed reload path so both stay in lockstep.
async function showCodeFile(path: string, title: string, content: string): Promise<void> {
  const root = renderCodeView(viewEls.code, { title, path, content });
  assignCodeBlockIds(root);
  const source = await fileSource(path, content, title);
  openAnnotatableText(root, source, () => window.getSelection());
}

// Render an OWNED repo HTML file in a same-origin iframe and wire it for annotation
// against the iframe's document. Shared by the initial open path and the change-feed
// reload path. Owned files come from the repo, so they render with allow-same-origin
// and the parent reaches contentDocument to paint highlights / read selections there.
// NOTE: rendered-DOM text offsets differ from HTML-source offsets, so an annotation
// made here won't resolve if the same file is later opened as source (and vice-versa);
// they coexist in the store and orphan gracefully in the other mode (no mode key yet).
async function showHtmlFile(path: string, title: string, content: string): Promise<void> {
  // Compute the source up front so the async-fired load handler stays synchronous.
  const source = await fileSource(path, content, title);
  const frame = renderHtmlView(viewEls.html, { title, content, owned: true });
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return;
    assignBlockIds(doc.body); // generic core ids — real HTML has block elements
    // Outline from the doc's own headings; only reveal it if there are any.
    const headingCount = renderHtmlDocMap(doc);
    docmap.classList.remove("collapsed");
    viewArea.classList.toggle("has-outline", headingCount > 0);
    syncPanelColumn();
    openAnnotatableText(doc.body, source, () => win.getSelection(), {
      win: win as unknown as Window,
      rectOffset: () => {
        const r = frame.getBoundingClientRect();
        return { x: r.left, y: r.top };
      },
      injectStyles: true, // the iframe doc doesn't load the app stylesheet
    });
  });
}

// --- Image region-annotation wiring (Task 9). Images have no text to select, so
// this is a SEPARATE path from openAnnotatableText: a drag over the image draws a
// rectangle, a small floating composer captures a note, and the region is stored
// as a normalized 0..1 rect that re-paints as an overlay box at any display size.
// Like the text path it shares the single `#annotation-list`; leaving the image
// view tears its drag/resize listeners + boxes down so nothing leaks across views.
let activeImage: { teardown(): void } | null = null;

function teardownActiveImage(): void {
  if (!activeImage) return;
  activeImage.teardown();
  activeImage = null;
  // Symmetric to teardownActiveText: don't clobber the panel source a text
  // opener (code/html) may have just claimed during an image→code/html switch.
  if (!activeText) {
    activePanelSource = null;
    reRenderActiveSource = () => {};
  }
  refreshSourceSend();
}

async function showImageFile(projectId: string, path: string, title: string): Promise<void> {
  const { img, layer, wrap } = renderImageView(viewEls.image, { title, path, projectId });
  const source = await fileSource(path, path); // binary: hash the path (see viewerSource)

  // Switching into a fresh image view tears down any prior text OR image annotator.
  teardownActiveText();
  teardownActiveImage();

  let activeId: string | null = null;

  const displaySize = (): { w: number; h: number } => ({ w: img.clientWidth, h: img.clientHeight });

  const rerender = (): void => {
    const anns = annotationStore.forSource(source);
    renderRegionBoxes(layer, anns, displaySize(), {
      activeId,
      onSelect: (id) => {
        activeId = id;
        rerender();
      },
    });
    renderSourcePanel(listEl, anns, {
      onSelect: (id) => {
        activeId = id;
        rerender();
      },
      onDelete: (id) => {
        annotationStore.remove(source, id);
        if (activeId === id) activeId = null;
        rerender();
      },
    });
    refreshSourceSend();
  };

  activePanelSource = source;
  reRenderActiveSource = rerender;

  // A tiny floating composer anchored near the drag rect: textarea + Save/Cancel.
  let composer: HTMLDivElement | null = null;
  const closeComposer = (): void => {
    composer?.remove();
    composer = null;
  };
  const openComposer = (
    at: { x: number; y: number },
    onSave: (note: string) => void,
  ): void => {
    closeComposer();
    const { el: box, focus } = buildNoteComposer({
      placeholder: "Note for this region…",
      extraClass: "region-composer",
      onSave: (note) => {
        closeComposer();
        if (note) onSave(note);
        else rerender(); // empty note -> drop the draft box
      },
      onCancel: () => {
        closeComposer();
        rerender();
      },
    });
    box.style.position = "absolute";
    box.style.left = `${at.x}px`;
    box.style.top = `${at.y}px`;
    wrap.append(box);
    composer = box;
    focus();
  };

  // Drag-to-create: track from mousedown on the image, draw a draft box, and on
  // mouseup (if the drag is more than a few px) open the composer for a note.
  let dragStart: { x: number; y: number } | null = null;
  let draft: HTMLDivElement | null = null;

  const pointIn = (e: MouseEvent): { x: number; y: number } => {
    const r = img.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if (composer) return; // don't start a new drag while a composer is open
    closeComposer();
    dragStart = pointIn(e);
    draft = document.createElement("div");
    draft.className = "region-box is-draft";
    draft.style.position = "absolute";
    layer.append(draft);
  };
  const onMove = (e: MouseEvent): void => {
    if (!dragStart || !draft) return;
    const p = pointIn(e);
    const left = Math.min(dragStart.x, p.x);
    const top = Math.min(dragStart.y, p.y);
    draft.style.left = `${left}px`;
    draft.style.top = `${top}px`;
    draft.style.width = `${Math.abs(p.x - dragStart.x)}px`;
    draft.style.height = `${Math.abs(p.y - dragStart.y)}px`;
  };
  const onUp = (e: MouseEvent): void => {
    if (!dragStart) return;
    const start = dragStart;
    dragStart = null;
    draft?.remove();
    draft = null;
    const p = pointIn(e);
    const left = Math.min(start.x, p.x);
    const top = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x);
    const h = Math.abs(p.y - start.y);
    if (w < 5 || h < 5) {
      rerender(); // treat as a click — clear any stray draft
      return;
    }
    const size = displaySize();
    const rect = normalizeRect({ x: left, y: top, w, h }, size);
    openComposer({ x: left, y: top + h }, (note) => {
      const ann = buildRegionAnnotation({ source, rect, note, creator: me });
      annotationStore.add(source, ann);
      activeId = ann.id;
      rerender();
    });
  };

  wrap.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  // The displayed image size changes on window resize; re-lay-out the boxes.
  const onResize = (): void => rerender();
  window.addEventListener("resize", onResize);
  // First paint may precede image load (clientWidth = 0); repaint once it loads.
  img.addEventListener("load", onResize);

  activeImage = {
    teardown: () => {
      wrap.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
      img.removeEventListener("load", onResize);
      closeComposer();
      layer.replaceChildren();
    },
  };

  rerender();
}

// --- Center views: review (the locked annotation core) / journal / kanban ---
const breadcrumbEl = document.querySelector<HTMLElement>("#breadcrumb")!;

interface Crumb {
  label: string;
  go?: () => void;
}

// Render the location breadcrumb at the inner top of the main panel. Segments
// are light/muted; the last is the current location, and any with a `go` handler
// is a clickable link (e.g. the project root).
function renderBreadcrumb(crumbs: Crumb[]): void {
  breadcrumbEl.replaceChildren();
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = "/";
      breadcrumbEl.append(sep);
    }
    const el = document.createElement(c.go ? "a" : "span");
    el.className = "breadcrumb-seg";
    el.textContent = c.label;
    if (i === crumbs.length - 1) el.classList.add("current");
    if (c.go) el.addEventListener("click", c.go);
    breadcrumbEl.append(el);
  });
}

// Breadcrumb for a project file (review/code/image/html views): the project
// name (clickable → its page) followed by each path segment, current file last.
function fileCrumbs(): Crumb[] {
  const path = currentDocKey.startsWith("review:")
    ? currentDocKey.slice("review:".length)
    : currentDocKey;
  const projName = getProject(currentDocProjectId)?.name;
  const crumbs: Crumb[] = [];
  if (projName) crumbs.push({ label: projName, go: () => openProject(currentDocProjectId) });
  for (const seg of path.split("/").filter(Boolean)) crumbs.push({ label: seg });
  if (crumbs.length === 0) crumbs.push({ label: currentDocTitle });
  return crumbs;
}

// Recompute the breadcrumb for whatever view is currently active.
function updateBreadcrumb(): void {
  const v = viewStore.get();
  let crumbs: Crumb[];
  switch (v) {
    case "review":
    case "code":
    case "image":
    case "html":
      crumbs = fileCrumbs();
      break;
    case "journal":
      crumbs = journalTitle && journalTitle !== "Journal"
        ? [{ label: "Journal", go: () => { journal.showJournal(); viewStore.set("journal"); } }, { label: journalTitle }]
        : [{ label: "Journal" }];
      break;
    case "pages":
      crumbs = [{ label: "Pages" }];
      break;
    case "projects":
      crumbs = [{ label: "Projects" }];
      break;
    case "project":
      crumbs = [{ label: "Projects", go: () => viewStore.set("projects") }, { label: projectTitle }];
      break;
    case "kanban":
      crumbs = [{ label: "Kanban" }];
      break;
    case "settings":
      crumbs = [{ label: "Settings" }];
      break;
    case "learnings":
      crumbs = [{ label: "Learnings" }];
      break;
    case "help":
      crumbs = [{ label: "Keyboard shortcuts" }];
      break;
  }
  if (crumbs.length <= 1) {
    breadcrumbEl.hidden = true;
  } else {
    breadcrumbEl.hidden = false;
    renderBreadcrumb(crumbs);
  }
}

const viewEls: Record<View, HTMLElement> = {
  review: document.querySelector<HTMLElement>("#main")!,
  code: document.querySelector<HTMLElement>("#view-code")!,
  image: document.querySelector<HTMLElement>("#view-image")!,
  html: document.querySelector<HTMLElement>("#view-html")!,
  journal: document.querySelector<HTMLElement>("#view-journal")!,
  pages: document.querySelector<HTMLElement>("#view-pages")!,
  projects: document.querySelector<HTMLElement>("#view-projects")!,
  project: document.querySelector<HTMLElement>("#view-project")!,
  kanban: document.querySelector<HTMLElement>("#view-kanban")!,
  settings: document.querySelector<HTMLElement>("#view-settings")!,
  learnings: document.querySelector<HTMLElement>("#view-learnings")!,
  help: document.querySelector<HTMLElement>("#view-help")!,
};
const navBadge = document.querySelector<HTMLElement>(".nav-badge")!;
let journalTitle = "Journal";
let projectTitle = "Project";
let currentProjectId: string | null = null;
// Which card's learnings the review stepper is walking. D3 sets this from a board
// click; until then renderLearningsView auto-picks the first card with pending
// learnings so the view is demoable.
let activeLearningsCardId: string | null = null;

// Render the learnings stepper into its view, wiring the store write-throughs as
// deps. Auto-picks a card when none is active so the view is never blank when there
// is review work to do.
function renderLearningsView(): void {
  if (!activeLearningsCardId) {
    // Demo seam: auto-pick the first card with pending learnings and STICK to it
    // until that card's learnings are exhausted (then it shows the empty state) — it
    // does NOT auto-advance across cards. D3 replaces this with an explicit
    // board-click selection.
    const firstPending = listLearnings()
      .filter((l) => l.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    activeLearningsCardId = firstPending?.cardId ?? null;
  }
  renderLearnings(viewEls.learnings, {
    cardId: activeLearningsCardId,
    onReject: (id) => {
      setLearningStatus(id, "rejected");
      renderLearningsView();
    },
    onAccept: async (id) => {
      // Optimistically mark accepted and advance the stepper immediately, so the
      // user sees instant feedback and auto-advances to the next learning. Then
      // write the file to disk (and commit when it's a repo); revert if it fails.
      setLearningStatus(id, "accepted");
      renderLearningsView();
      try {
        if (host.applyLearning) {
          const r = await host.applyLearning(id);
          // Honest toast from the result: warn only when a commit was attempted in
          // a repo and failed (the real problem). Repo-committed and non-repo
          // write-only are both normal — stay silent to avoid noise.
          if (r.isRepo && !r.committed) {
            showToast("Accepted and saved, but the commit failed");
          }
        }
      } catch (err) {
        setLearningStatus(id, "pending");
        renderLearningsView();
        console.error("accept failed", err);
        showToast(`Couldn't accept: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onComment: async (id, text) => {
      // A comment is a revise-signal. Optimistically persist it AND flip the
      // learning to "revising", then re-render — this drops it out of the pending
      // cursor so the stepper advances immediately (the card stays in the Learnings
      // column because openForCard still counts revising). The agent's re-proposal
      // flips it back to pending.
      addLearningComment(id, text, Date.now());
      setLearningStatus(id, "revising");
      renderLearningsView();
      // Deliver the feedback to the proposing agent (relaunching a dead session
      // with it queued). Only a genuine hand-off (queued/relaunched) leaves the
      // learning "revising"; anything else (no agent/browser host, not-linked,
      // failed, threw) means nothing will ever revise it — so REVERT to pending so
      // it resurfaces in the stepper for the user to retry rather than hanging.
      let reached = false;
      try {
        if (host.deliverLearningComment) {
          const r = await host.deliverLearningComment(id, text);
          reached = r.delivered === "queued" || r.delivered === "relaunched";
        }
      } catch (err) {
        console.error("comment delivery failed", err);
      }
      if (reached) {
        showToast("Sent — the agent will revise this learning");
      } else {
        setLearningStatus(id, "pending");
        renderLearningsView();
        showToast("Comment saved, but couldn't reach the agent — left it for you to retry");
      }
    },
  });
}

// Mutable reference so [[Session: <id>]] wiki links in the journal can open
// sessions in the panel, which is created after the journal.
let openSessionFromJournal: ((id: string) => void) | null = null;

const journal = mountJournal(
  viewEls.journal,
  (t) => {
    journalTitle = t;
    if (viewStore.get() === "journal") updateBreadcrumb();
  },
  // [[Project: X]] links jump to project X's home page (case-insensitive match
  // on the project name). Consumed even when no such project exists, so it never
  // falls through to creating a junk "Project: X" page.
  // [[Session: <id>]] links open the session in the sessions panel. The panel is
  // created after the journal, so we capture its open method via a mutable
  // reference assigned below.
  (target) => {
    const projM = /^Project:\s*(.+)$/i.exec(target);
    if (projM) {
      const name = projM[1].trim().toLowerCase();
      const proj = listProjects().find((p) => p.name.toLowerCase() === name);
      if (proj) openProject(proj.id);
      return true;
    }
    const sessM = /^Session:\s*(.+)$/i.exec(target);
    if (sessM) {
      const sid = sessM[1].trim();
      if (openSessionFromJournal) {
        app.classList.remove("right-closed");
        openSessionFromJournal(sid);
      }
      return true;
    }
    return false;
  },
  // Render [[Session: <id>]] links as session-open buttons (agent brand mark
  // if the session is known, otherwise a simple badge). Clicking opens the
  // session in the right pane, same as the wiki-link handler above.
  (sid) => {
    const s = getSession(sid);
    const btn = document.createElement("span");
    btn.className = "wikilink-session-btn";
    if (s) {
      btn.innerHTML = markFor(s.agent);
      btn.title = `Open session (${s.agent})`;
      btn.setAttribute("aria-label", `Open session (${s.agent})`);
    } else {
      btn.textContent = "Session";
      btn.title = "Open session";
    }
    return btn;
  },
);

function refreshBoard(): void {
  const count = renderKanban(viewEls.kanban, {
    onStartSession: startSessionForItem,
    onOpenSession: openSessionInPanel,
    openLearnings: (id) => openForCard(id),
    // Clicking a Learnings-column card opens the review stepper for THAT card.
    // Set the active card first, then switch views — viewStore's subscribe
    // handler calls renderLearningsView() (which now respects the explicit id
    // instead of auto-picking), so no extra render call is needed here.
    onOpenLearnings: (cardId) => {
      activeLearningsCardId = cardId;
      viewStore.set("learnings");
    },
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
    // Hand the card's text (title + description) to the agent the moment its
    // TUI launches.
    initialPrompt: promptForItem(item),
  });
  refreshBoard();
  app.classList.remove("right-closed"); // ensure the sessions pane is visible
  syncBottomNavSessions();
  sessionsPanel.open(s.id);
}

// Open an existing session (from the project page's sessions widget) in the
// sessions panel, revealing the right pane.
function openSessionInPanel(id: string): void {
  app.classList.remove("right-closed");
  syncBottomNavSessions();
  sessionsPanel.open(id);
}

// Start a NEW session scoped to the project currently shown (not tied to a
// card). Drops a fresh linked card via createSession, then opens it.
function startProjectSession(agent: Agent): void {
  const projectId = currentProjectId ?? undefined;
  const s = createSession({ title: "Untitled session", agent, projectId });
  refreshBoard();
  app.classList.remove("right-closed");
  syncBottomNavSessions();
  sessionsPanel.open(s.id);
}

// projectPage emits this when a [[wiki link]] is clicked inside the notes
// outline; route it to the journal's page view like any other page open.
document.addEventListener("orden:open-page", (e) => {
  const name = (e as CustomEvent<{ name: string }>).detail?.name;
  if (name) openPage(name);
});

// Views whose content can carry annotations — the only ones that show the
// annotations panel. Board/index views (journal, kanban, pages, project) aren't
// annotatable surfaces, so the panel hides there instead of sitting empty.
const ANNOTATABLE_VIEWS = new Set<View>(["review", "code", "image", "html"]);

const lastView = (await host.vault.get<string>("ui", "last-view")) as View | null;

const viewStore = createViewStore("review");
viewStore.subscribe((v) => {
  for (const name of Object.keys(viewEls) as View[]) {
    viewEls[name].classList.toggle("active", name === v);
  }
  viewArea.classList.toggle("no-panel", !ANNOTATABLE_VIEWS.has(v));
  // The review Approve/Copy buttons act on the ProseMirror review doc; hide them
  // on the other annotatable viewers (code/image/html) so they can't deliver the
  // wrong (stale review) annotations. The source-view Send button is gated
  // separately by refreshSourceSend().
  viewArea.classList.toggle("source-view", ANNOTATABLE_VIEWS.has(v) && v !== "review");
  // Only the HTML viewer carries its own extracted outline; clear the flag on
  // every transition so a stale one can't leak onto code/image. showHtmlFile
  // re-sets it once the iframe loads and headings are found.
  if (v !== "html") viewArea.classList.remove("has-outline");
  syncPanelColumn();
  updateBreadcrumb();
  document.querySelector("#nav-journal")?.classList.toggle("active", v === "journal");
  document.querySelector("#nav-pages")?.classList.toggle("active", v === "pages");
  document.querySelector("#nav-kanban")?.classList.toggle("active", v === "kanban");
  document.querySelector("#nav-projects")?.classList.toggle("active", v === "projects");
  document.querySelector("#bn-journal")?.classList.toggle("active", v === "journal");
  document.querySelector("#bn-kanban")?.classList.toggle("active", v === "kanban");
  document.querySelector("#bn-pages")?.classList.toggle("active", v === "pages");
  document.querySelector("#bn-projects")?.classList.toggle("active", v === "projects");
  // The Rendered/Source toggle only belongs to HTML file viewers; hide it when
  // we navigate to a default element (kanban/journal/pages/project).
  if (v !== "html" && v !== "code") htmlToggle.hidden = true;
  if (v === "pages") renderPagesIndex(viewEls.pages, openPage);
  if (v === "projects") renderProjectsIndex(viewEls.projects, openProject);
  if (v === "kanban") refreshBoard();
  if (v === "learnings") renderLearningsView();
  if (v === "help") renderHelp(viewEls.help);
  // Text-annotation lifecycle: the code, html, and review views share the single
  // `#annotation-list`. Leaving a text viewer (code or owned-html) tears down its
  // annotator + highlights — clearing the SAME realm it painted into (parent for
  // code, the iframe for html). Entering review re-renders the review panel into
  // the shared list. (A text view's own panel is rendered by openAnnotatableText
  // via showCodeFile/showHtmlFile on open.)
  if (v !== "code" && v !== "html") teardownActiveText();
  if (v !== "image") teardownActiveImage();
  if (v === "review") renderPanel();
  // Hide the source Send button outside source views (and show it when a source
  // view with open annotations is active); never touches the review buttons.
  refreshSourceSend();
  if (mobile.matches) app.classList.add("left-closed"); // close drawer after navigating
});
viewStore.subscribe((v) => {
  void host.vault.set("ui", "last-view", v);
});

function openPage(name: string): void {
  journal.showPage(name);
  viewStore.set("journal");
}

function renderProject(projectId: string): void {
  renderProjectPage(
    viewEls.project,
    projectId,
    refreshBoard,
    startSessionForItem,
    openSessionInPanel,
    startProjectSession,
    (path) => void openRepoFile(projectId, path),
    (id) => host.files.list(id),
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
    if (viewStore.get() === "project") updateBreadcrumb();
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

// Re-render the project page on a remote change.
function refreshProject(): void {
  if (viewStore.get() !== "project" || !currentProjectId) return;
  // Don't rebuild the page out from under an editable control (e.g. the
  // add-item box) — a live card transition would otherwise wipe in-progress
  // typing.
  if (projectPageHasFocus()) return;
  renderProject(currentProjectId);
}

function openProject(projectId: string): void {
  currentProjectId = projectId;
  projectTitle = getProject(projectId)?.name ?? "Project";
  renderProject(projectId);
  viewStore.set("project");
  void host.vault.set("ui", "last-project", projectId);
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
document.querySelector("#nav-projects")?.addEventListener("click", () => viewStore.set("projects"));

// Bottom nav (mobile): always-visible bar of icon buttons.
document.querySelector("#bn-journal")?.addEventListener("click", () => {
  journal.showJournal();
  viewStore.set("journal");
});
document.querySelector("#bn-kanban")?.addEventListener("click", () => viewStore.set("kanban"));
document.querySelector("#bn-pages")?.addEventListener("click", () => viewStore.set("pages"));
document.querySelector("#bn-projects")?.addEventListener("click", () => viewStore.set("projects"));
document.querySelector("#bn-sessions")?.addEventListener("click", toggleRight);

// --- Settings: cog popover + startup preference ---
const settingsCog = document.querySelector<HTMLElement>("#settings-cog")!;
const settingsView = document.querySelector<HTMLElement>("#view-settings")!;
const settings = loadSettings();
for (const radio of settingsView.querySelectorAll<HTMLInputElement>('input[name="startup"]')) {
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
for (const radio of settingsView.querySelectorAll<HTMLInputElement>(
  'input[name="complete-fade"]',
)) {
  radio.checked = Number(radio.value) === settings.completeFadeHours;
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    void saveSettings({ completeFadeHours: Number(radio.value) });
    refreshBoard();
  });
}

// Journal time zone: which calendar day a journal entry files under. "" inherits
// the host's zone (shown in the default option's label); an explicit choice
// overrides it. Changing it re-renders the journal so "today" updates at once.
const tzSelect = document.querySelector<HTMLSelectElement>("#journal-timezone")!;
const hostZone = host.capabilities().timeZone;
const inheritOpt = document.createElement("option");
inheritOpt.value = "";
inheritOpt.textContent = hostZone ? `Inherit from host (${hostZone})` : "Inherit from host";
tzSelect.append(inheritOpt);
for (const [id, label] of TIME_ZONE_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = label;
  tzSelect.append(opt);
}
tzSelect.value = settings.timeZone;
tzSelect.addEventListener("change", () => {
  void saveSettings({ timeZone: tzSelect.value });
  journal.refresh();
});
// Settings now lives as a main-panel view. The cog toggles it: opening it
// remembers the view you came from so the ✕ (and Escape) return you there.
let preSettingsView: View = viewStore.get();
function toggleSettings(): void {
  if (viewStore.get() === "settings") {
    viewStore.set(preSettingsView);
  } else {
    preSettingsView = viewStore.get();
    viewStore.set("settings");
  }
}
settingsCog.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
onAction("settings.toggle", toggleSettings);
document.querySelector<HTMLElement>("#settings-close")?.addEventListener("click", () => {
  viewStore.set(preSettingsView);
});

// Help (?): the keyboard-shortcuts view. Same open/close shape as settings —
// the footer button and chord toggle it, ✕ and Escape return to the prior view.
const helpBtn = document.querySelector<HTMLElement>("#help-btn")!;
let preHelpView: View = viewStore.get();
function toggleHelp(): void {
  if (viewStore.get() === "help") {
    viewStore.set(preHelpView);
  } else {
    preHelpView = viewStore.get();
    viewStore.set("help");
  }
}
helpBtn.addEventListener("click", toggleHelp);
onAction("help.toggle", toggleHelp);
// The ✕ is re-created on every renderHelp, so delegate from the view section.
viewEls.help.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "help-close") viewStore.set(preHelpView);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (viewStore.get() === "settings") viewStore.set(preSettingsView);
  else if (viewStore.get() === "help") viewStore.set(preHelpView);
});

// On a project page, a bare "c" (create) jumps focus to the add-item box — the
// list/board convention (GitHub/Linear "create"). Scoped to the project view
// and skipped while typing, so it never swallows a literal "c" elsewhere.
document.addEventListener("keydown", (e) => {
  if (viewStore.get() !== "project") return;
  if (e.key !== "c" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (isTypingContext(e.target)) return;
  e.preventDefault();
  focusProjectAddItem();
});

// --- Open real repo docs in the review editor (dogfooding) ---
// Load a document into the review view: restore its saved markdown + annotations
// (re-anchored by quote) if present, else the file's on-disk content.
function loadReviewDoc(opts: {
  key: string;
  title: string;
  markdown: string;
  // Use opts.markdown verbatim, ignoring any saved markdown — for a live reload
  // when the underlying file changed on disk. Saved annotations are still kept
  // and re-anchored onto the new text.
  forceMarkdown?: boolean;
}): void {
  currentDocKey = opts.key;
  currentDocTitle = opts.title;

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
    const range = reanchorQuote(parsed, quote, r.anchor?.position);
    if (range) {
      tr = tr.addMark(
        range.from,
        range.to,
        schema.marks.annotation.create({ id: r.id, target: r.target }),
      );
    }
  }
  view.dispatch(tr);
  if (viewStore.get() === "review") updateBreadcrumb();
}

const recentList = document.querySelector<HTMLElement>("#recent-list")!;
// Repo docs come through host.files now, read per project on open. The FILES nav
// shows only recently-OPENED files; the project page lists its own files (Task 10).

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
async function openRepoFile(projectId: string, path: string): Promise<void> {
  const title = path.split("/").pop() ?? path;
  const kind = viewerFor(path, effectiveHtmlRender(path));
  // Watch only the doc that's open: tell the host to start watching this file
  // (so an external edit live-reloads it) and release the previously-open one.
  // The host watches nothing until we ask, so this pairing is what keeps an
  // external edit flowing to the viewer without watching the whole repo.
  if (!watchedDoc || watchedDoc.projectId !== projectId || watchedDoc.path !== path) {
    if (watchedDoc) void host.files.unwatch(watchedDoc.projectId, watchedDoc.path);
    watchedDoc = { projectId, path };
    void host.files.watch(projectId, path);
  }
  currentDocProjectId = projectId;
  currentDocKey = `review:${path}`;
  currentDocTitle = title;

  if (kind === "prose") {
    // markdown read happens inside loadReviewDoc's funnel
    const content = await host.files.read(projectId, path);
    loadReviewDoc({ key: `review:${path}`, title, markdown: content });
    viewStore.set("review");
  } else {
    if (kind === "image") {
      await showImageFile(projectId, path, title); // bytes load via /repo-file/<projectId>/
    } else if (kind === "html") {
      await showHtmlFile(path, title, await host.files.read(projectId, path));
    } else {
      await showCodeFile(path, title, await host.files.read(projectId, path));
    }
    viewStore.set(kind as View);
  }
  updateHtmlToggle(path);
  setActiveFile(path);
  recordRecentFile(projectId, path);
  void host.vault.set("ui", "last-doc", { projectId, path });
  renderRecentFiles();
}

// Topbar toggle: flip this file's render/source choice for the session, then
// re-open so it routes through the new viewer.
htmlToggle.addEventListener("click", () => {
  const path = currentDocKey.startsWith("review:") ? currentDocKey.slice("review:".length) : null;
  if (!path) return;
  htmlRenderOverride.set(path, !effectiveHtmlRender(path));
  void openRepoFile(currentDocProjectId, path);
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
  for (const { projectId, path } of recents) {
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
    a.addEventListener("click", () => void openRepoFile(projectId, path));
    recentList.append(a);
  }
}
renderRecentFiles();

// Initial review document: always the built-in sample (which seeds demo
// annotations on first run). Repo files open per project from the FILES nav /
// project page; boot no longer reopens a single global file.
loadReviewDoc({
  key: "review:default",
  title: DOC_TITLE,
  markdown: "",
});

onUpdate();
applyLayout(mobile.matches);

// Route the initial view from the startup preference.
if (settings.startup === "last") {
  if (lastView === "project") {
    const lastProjId = await host.vault.get<string>("ui", "last-project");
    if (lastProjId) {
      openProject(lastProjId);
    } else {
      const lastDoc = await host.vault.get<{ projectId: string; path: string }>(
        "ui",
        "last-doc",
      );
      if (lastDoc?.projectId) {
        openProject(lastDoc.projectId);
      } else {
        viewStore.set("journal");
      }
    }
  } else if (lastView && !ANNOTATABLE_VIEWS.has(lastView)) {
    viewStore.set(lastView);
  } else {
    const lastDoc = await host.vault.get<{ projectId: string; path: string }>(
      "ui",
      "last-doc",
    );
    if (lastDoc?.projectId && lastDoc?.path) {
      await openRepoFile(lastDoc.projectId, lastDoc.path);
    } else {
      viewStore.set(lastView ?? "journal");
    }
  }
} else if (settings.startup === "journal") {
  viewStore.set("journal");
} else if (settings.startup === "kanban") {
  viewStore.set("kanban");
}

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

// Periodically check for a newer build so the user knows to reload after a rebuild.
setInterval(checkForUpdates, 30_000);
document.querySelector("#new-build-available")?.addEventListener("click", () => location.reload());

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
  close: () => {
    app.classList.add("right-closed");
    syncBottomNavSessions();
  },
});

// Wire [[Session: <id>]] wiki links from the journal to open sessions here.
openSessionFromJournal = (id) => sessionsPanel.open(id);

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

// Worktree isolation: when on (the default), each new session of a local git
// project launches in its own git worktree on an orden/<slug> branch. Read at
// launch time by the host; flipping it affects the NEXT launch only.
const worktreeCb = document.querySelector<HTMLInputElement>("#worktree-isolation");
if (worktreeCb) {
  worktreeCb.checked = loadSettings().worktreeIsolation;
  worktreeCb.addEventListener("change", () => {
    void saveSettings({ worktreeIsolation: worktreeCb.checked });
  });
}

// Worktree auto-trust: pre-accept claude's "do you trust this workspace?" dialog
// for new worktrees of an already-trusted repo. Read at launch time by the host.
const autoTrustCb = document.querySelector<HTMLInputElement>("#worktree-auto-trust");
if (autoTrustCb) {
  autoTrustCb.checked = loadSettings().worktreeAutoTrust;
  autoTrustCb.addEventListener("change", () => {
    void saveSettings({ worktreeAutoTrust: autoTrustCb.checked });
  });
}

// PR forge: how card completion publishes a session branch — auto-infer the
// forge CLI from the remote URL, force one, or push without opening a PR.
const prForgeSel = document.querySelector<HTMLSelectElement>("#pr-forge");
if (prForgeSel) {
  prForgeSel.value = loadSettings().prForge;
  prForgeSel.addEventListener("change", () => {
    const v = prForgeSel.value;
    if (v === "auto" || v === "gh" || v === "glab" || v === "none") {
      void saveSettings({ prForge: v });
    }
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
      void openRepoFile(currentDocProjectId, path);
    }
  });
}

// Scratch terminal: show (or hide) the plain-shell scratch button in the
// session pane. A per-user preference; no other view depends on it live.
const scratchTermCb = document.querySelector<HTMLInputElement>("#show-scratch-terminal");
if (scratchTermCb) {
  scratchTermCb.checked = loadSettings().showScratchTerminal;
  scratchTermCb.addEventListener("change", () => {
    void saveSettings({ showScratchTerminal: scratchTermCb.checked });
  });
}

// Default session mode: one TUI/GUI segmented row per tool (Claude Code,
// opencode) picking which surface a newly spawned session opens in. Selecting
// a segment merges that tool's choice into the stored map.
const modeGridMount = document.querySelector<HTMLElement>("#mode-grid");
if (modeGridMount) {
  modeGridMount.append(
    buildModeGrid(loadSettings().defaultMode, (next) => {
      void saveSettings({ defaultMode: next });
    }),
  );
}

// Vault location: a read-only path so the user knows where their data lives.
// The in-browser host has no on-disk vault, so it reports browser storage.
const vaultLocationEl = document.querySelector<HTMLElement>("#vault-location");
if (vaultLocationEl) {
  const vaultRoot = host.capabilities().vaultRoot;
  vaultLocationEl.textContent = vaultRoot ?? "Browser storage (in-memory host)";
  if (vaultRoot) vaultLocationEl.title = vaultRoot;
}

// Learning prompt: editable system instruction for agents proposing learnings.
const learningPromptTa = document.querySelector<HTMLTextAreaElement>("#learning-prompt");
const learningPromptReset = document.querySelector<HTMLElement>("#learning-prompt-reset");
if (learningPromptTa) {
  learningPromptTa.value = settings.learningPrompt;
  learningPromptTa.addEventListener("input", () => {
    void saveSettings({ learningPrompt: learningPromptTa.value });
  });
  if (learningPromptReset) {
    learningPromptReset.addEventListener("click", () => {
      learningPromptTa.value = DEFAULT_LEARNING_PROMPT;
      void saveSettings({ learningPrompt: DEFAULT_LEARNING_PROMPT });
    });
  }
}

// --- Omnisearch / command palette: one topbar box that fuzzy-finds across the
// high-level nav links, Projects, Pages, Files, and Cards, and runs actions in
// ">" mode. See docs/plans/2026-06-08-omnisearch-command-palette-design.md.
const searchForm = document.querySelector<HTMLFormElement>("#omnisearch-form");
const searchInput = document.querySelector<HTMLInputElement>("#omnisearch");
const paletteMount = document.querySelector<HTMLElement>("#palette-results");

// First doc line containing the query — a result subtitle for body matches.
function snippet(md: string, q: string): string | undefined {
  if (!q) return undefined;
  const line = md.split("\n").find((l) => l.toLowerCase().includes(q.toLowerCase()));
  return line?.trim().slice(0, 80) || undefined;
}

// The high-level destinations (mirrors the nav rail's top links). Surfaced first
// in the palette so a single keystroke jumps there — "j" → Journal, "k" → Kanban.
const navLinks: { id: string; title: string; open: () => void }[] = [
  { id: "journal", title: "Journal", open: () => { journal.showJournal(); viewStore.set("journal"); } },
  { id: "kanban", title: "Kanban", open: () => viewStore.set("kanban") },
  { id: "pages", title: "Pages", open: () => viewStore.set("pages") },
];

// Open a card: reveal its latest linked session if it has one, else the board.
function openCard(item: Item): void {
  const sids = cardSessionIds(item);
  if (sids.length > 0) openSessionInPanel(sids[sids.length - 1]);
  else viewStore.set("kanban");
}

// Group order is deliberate — nav, projects, pages, files, cards.
const searchSources: SearchSource[] = [
  {
    id: "nav",
    label: "Go to",
    search: (q) =>
      fuzzyRank(q, navLinks, (l) => l.title).map(({ item }) => ({
        id: `nav:${item.id}`,
        title: item.title,
        open: item.open,
      })),
  },
  {
    id: "projects",
    label: "Projects",
    search: (q) =>
      fuzzyRank(q, listProjects(), (p) => `${p.name} ${p.source.kind === "local" ? p.source.path : ""}`).map(
        ({ item }) => ({
          id: `project:${item.id}`,
          title: item.name,
          subtitle: item.source.kind === "local" ? item.source.path : item.source.kind,
          open: () => openProject(item.id),
        }),
      ),
  },
  {
    id: "pages",
    label: "Pages",
    search: (q) => {
      const pages = pagesIndex(); // all vault pages, including journal day-pages
      const byName = fuzzyRank(q, pages, (p) => p.name).map((r) => r.item);
      const extra = q === ""
        ? []
        : pages.filter((p) => !byName.includes(p) && getPageMarkdown(p.name).toLowerCase().includes(q.toLowerCase()));
      return [...byName, ...extra].map((p) => ({
        id: `page:${p.name}`,
        title: p.name,
        subtitle: snippet(getPageMarkdown(p.name), q),
        open: () => openPage(p.name),
      }));
    },
  },
  {
    id: "files",
    label: "Files",
    search: (q) =>
      fuzzyRank(q, listFiles(), (f) => f.path).map(({ item }) => ({
        id: `file:${item.path}`,
        title: item.title,
        subtitle: item.path,
        open: () => void openRepoFile("repo", item.path),
      })),
  },
  {
    id: "cards",
    label: "Cards",
    search: (q) =>
      fuzzyRank(q, listItems(), (it) => `${it.title} ${it.state}`).map(({ item }) => ({
        id: `card:${item.id}`,
        title: item.title,
        subtitle: item.state,
        open: () => openCard(item),
      })),
  },
];

const paletteCommands: Command[] = [
  { id: "new-session", title: "New session", run: () => startProjectSession("claude") },
  { id: "toggle-outline", title: "Toggle outline", run: () => outlineHideShow.setHidden(!outlineHideShow.isHidden()) },
  { id: "toggle-annotations", title: "Toggle annotations", run: () => annHideShow.setHidden(!annHideShow.isHidden()) },
  { id: "toggle-nav", title: "Toggle navigation pane", run: () => toggleLeft() },
  { id: "toggle-session", title: "Toggle session pane", run: () => toggleRight() },
  { id: "focus-mode", title: "Focus mode", run: () => toggleFocusMode() },
  { id: "open-help", title: "Keyboard shortcuts", run: () => toggleHelp() },
  { id: "view-journal", title: "Go to Journal", run: () => { journal.showJournal(); viewStore.set("journal"); } },
  { id: "view-pages", title: "Go to Pages", run: () => viewStore.set("pages") },
  { id: "view-kanban", title: "Go to Kanban", run: () => viewStore.set("kanban") },
  { id: "open-settings", title: "Open settings", run: () => settingsCog.click() },
];

if (searchForm && searchInput && paletteMount) {
  const palette = createCommandPalette({
    form: searchForm,
    input: searchInput,
    mount: paletteMount,
    sources: searchSources,
    commands: paletteCommands,
  });

  // ⌘K opens search; ⌘⇧P opens the same palette pre-filtered to commands (">").
  // Both go through the keybindings dispatcher so they're rebindable.
  onAction("search.open", () => {
    palette.open("", true);
    searchInput.select();
  });
  onAction("palette.open", () => {
    palette.open(">", true);
    searchInput.select();
  });

  // Close when focus/click leaves the search pill + dropdown.
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!searchForm.contains(t) && !paletteMount.contains(t)) palette.close();
  });
}

// Live updates: when the vault changes (e.g. an agent writes over the MCP bus),
// re-load the affected store and re-render only the views that depend on it.
// Editor re-renders are focus-guarded so we never clobber what you're typing.
// No-op on BrowserHost (single writer).
onVaultChange((ns, key, projectId) => {
  void (async () => {
    const v = viewStore.get();
    switch (ns) {
      case "files": {
        // A repo file changed on disk. If it's the one we're showing (same project
        // AND path), re-read and re-render so external edits (by an agent, git, or
        // a collaborator) appear live. Non-prose viewers always re-render; the
        // markdown editor reload is guarded so it never clobbers active typing.
        if (currentDocProjectId === projectId && currentDocKey === `review:${key}`) {
          const kind = viewerFor(key, effectiveHtmlRender(key));
          if (kind === "image") {
            await showImageFile(projectId, key, currentDocTitle);
          } else if (kind === "html") {
            const content = await host.files.read(projectId, key);
            await showHtmlFile(key, currentDocTitle, content);
          } else if (kind === "code") {
            const content = await host.files.read(projectId, key);
            await showCodeFile(key, currentDocTitle, content);
          } else if (!view.hasFocus()) {
            const markdown = await host.files.read(projectId, key);
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
      case "learnings":
        await hydrateLearnings(host);
        refreshBoard(); // the derived Learnings column reads openForCard (pending|revising)
        // Refresh the stepper on external changes (e.g. the agent's revision flips
        // revising→pending) — but NOT while the user is mid-typing a comment, since
        // re-rendering would rebuild the DOM and lose their text + focus. The next
        // user interaction (or view switch) will refresh it.
        if (v === "learnings" && !learningsCommentFocused()) renderLearningsView();
        break;
      case "projects":
        await hydrateProjects(host);
        renderProjects();
        if (v === "projects") renderProjectsIndex(viewEls.projects, openProject);
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
        await hydrateKeybindings(host);
        if (v === "help") renderHelp(viewEls.help);
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
          // The MCP panel_open intent carries a bare path; resolve it against the
          // host filesRoot alias ("repo"). Per-project panel intents are future work.
          openRepoFile: (path, pid) => void openRepoFile(pid ?? "repo", path),
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
    else if (v === "projects") renderProjectsIndex(viewEls.projects, openProject);
    else if (v === "journal") journal.refresh();
    else if (v === "project") refreshProject();
  })();
});

// Dev handle for inspection / screenshot-driven iteration.
(window as unknown as { orden: unknown }).orden = { view, log, addAnnotation, viewStore };

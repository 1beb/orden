// Content script: arms/disarms orden "annotation mode" in the page, and — once
// armed — provides the real annotation overlay: select page text to open a
// floating composer; saving paints an orden-styled highlight (CSS Custom
// Highlight API, non-mutating) and adds a card to an annotations rail; clicking
// a card scrolls to and pulses the highlight.
//
// Mounts a Shadow-DOM overlay (so the host page CSS cannot bleed in). The shadow
// host is a fixed, full-viewport, pointer-events:none layer so bare page area
// still receives clicks/drags for text selection; only the banner/rail/composer
// opt back in with pointer-events:auto. Re-injecting this module while already
// mounted toggles OFF instead of stacking, via a window-level flag the SW relies
// on.
//
// Anchoring is computed inline (exact/prefix/suffix from the live Range) and the
// cloned Range is kept in memory for painting + scroll. blockId is assigned later
// by the host against a stored snapshot — not here. No host calls yet; highlights
// live in memory for this arm session only.

const MOUNT_FLAG = "__ordenClipperMounted";
const HOST_ID = "orden-clipper-overlay-host";
const PAGE_STYLE_ID = "orden-clipper-page-style";

// CSS Custom Highlight registry names. We paint every saved mark into one
// registry and the transiently active/hovered/pulsed one into a second so it can
// be styled brighter. Single accent (orden agent purple) for all marks in this
// task — agent vs human colour is a later refinement; the rail still shows the
// audience chip.
const HL_BASE = "orden-clip";
const HL_ACTIVE = "orden-clip-active";

const CONTEXT_LEN = 32;
const MIN_SELECTION = 4;

type Audience = "agent" | "human";

interface ClipperWindow extends Window {
  [MOUNT_FLAG]?: boolean;
}

interface Mark {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  note: string;
  audience: Audience;
  range: Range;
}

const w = window as ClipperWindow;

// ---- module-scope teardown handles ----------------------------------------
let hostEl: HTMLDivElement | null = null;
let pageStyleEl: HTMLStyleElement | null = null;
let onKeydown: ((e: KeyboardEvent) => void) | null = null;
let onMouseup: ((e: MouseEvent) => void) | null = null;
let onMessage:
  | ((msg: { type?: string }, sender: unknown, sendResponse: () => void) => void)
  | null = null;

// ---- overlay state ---------------------------------------------------------
let shadowRoot: ShadowRoot | null = null;
let listEl: HTMLUListElement | null = null;
let annotatorEl: HTMLDivElement | null = null;
let pillEl: HTMLButtonElement | null = null;
let composerEl: HTMLDivElement | null = null;
let noteEl: HTMLTextAreaElement | null = null;
let tAgentBtn: HTMLButtonElement | null = null;
let tHumanBtn: HTMLButtonElement | null = null;

let baseHl: Highlight | null = null;
let activeHl: Highlight | null = null;

const marks = new Map<string, Mark>();
let pendingRange: Range | null = null;
let pendingAnchor: { exact: string; prefix: string; suffix: string } | null = null;
let target: Audience = "agent";
let seq = 0;

function hasHighlightApi(): boolean {
  return typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights;
}

// ---- anchoring: exact / prefix / suffix from a live Range ------------------
// Reads text content around the selection's start/end containers. Robust to
// multi-node selections: at a node boundary we simply take fewer context chars.
function computeAnchor(range: Range): { exact: string; prefix: string; suffix: string } {
  const exact = range.toString();

  let prefix = "";
  const startNode = range.startContainer;
  if (startNode.nodeType === Node.TEXT_NODE) {
    const text = startNode.textContent ?? "";
    prefix = text.slice(Math.max(0, range.startOffset - CONTEXT_LEN), range.startOffset);
  } else {
    const text = startNode.textContent ?? "";
    prefix = text.slice(0, 0); // element container: no reliable inline prefix
  }

  let suffix = "";
  const endNode = range.endContainer;
  if (endNode.nodeType === Node.TEXT_NODE) {
    const text = endNode.textContent ?? "";
    suffix = text.slice(range.endOffset, range.endOffset + CONTEXT_LEN);
  } else {
    suffix = "";
  }

  return { exact, prefix, suffix };
}

// ---- highlight painting ----------------------------------------------------
function repaintBase(): void {
  if (!baseHl || !hasHighlightApi()) return;
  baseHl.clear();
  for (const m of marks.values()) baseHl.add(m.range);
}

function setActive(id: string, on: boolean): void {
  if (!activeHl || !hasHighlightApi()) return;
  const m = marks.get(id);
  if (!m) return;
  if (on) activeHl.add(m.range);
  else activeHl.delete(m.range);
  const row = listEl?.querySelector<HTMLLIElement>(`li[data-id="${id}"]`);
  if (row) row.classList.toggle("is-active", on);
}

function pulse(id: string): void {
  setActive(id, true);
  window.setTimeout(() => setActive(id, false), 1100);
}

// ---- composer --------------------------------------------------------------
function showAnnotatorAt(rect: DOMRect): void {
  if (!annotatorEl || !pillEl || !composerEl) return;
  annotatorEl.hidden = false;
  composerEl.hidden = true;
  pillEl.style.display = "";
  const below = rect.top < 90;
  annotatorEl.classList.toggle("below", below);
  annotatorEl.style.left = rect.left + rect.width / 2 + "px";
  annotatorEl.style.top = (below ? rect.bottom : rect.top) + "px";
}

function hideAnnotator(): void {
  if (annotatorEl) annotatorEl.hidden = true;
  pendingRange = null;
  pendingAnchor = null;
}

function setTarget(t: Audience): void {
  target = t;
  tAgentBtn?.classList.toggle("is-on", t === "agent");
  tHumanBtn?.classList.toggle("is-on", t === "human");
}

function openComposer(): void {
  if (!pillEl || !composerEl || !noteEl) return;
  pillEl.style.display = "none";
  composerEl.hidden = false;
  setTarget(target);
  noteEl.value = "";
  window.setTimeout(() => noteEl?.focus(), 0);
}

function saveAnnotation(): void {
  if (!pendingRange || !pendingAnchor || !noteEl) {
    hideAnnotator();
    return;
  }
  const id = "a" + ++seq;
  const mark: Mark = {
    id,
    exact: pendingAnchor.exact,
    prefix: pendingAnchor.prefix,
    suffix: pendingAnchor.suffix,
    note: noteEl.value.trim(),
    audience: target,
    range: pendingRange.cloneRange(),
  };
  marks.set(id, mark);
  repaintBase();
  addRow(mark);
  window.getSelection()?.removeAllRanges();
  hideAnnotator();
}

// ---- rail ------------------------------------------------------------------
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function refreshEmpty(): void {
  if (!listEl) return;
  let empty = listEl.querySelector<HTMLDivElement>(".empty");
  if (!listEl.querySelector("li")) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No annotations yet. Select text in the page to add one.";
      listEl.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

function deleteMark(id: string): void {
  marks.delete(id);
  repaintBase();
  listEl?.querySelector<HTMLLIElement>(`li[data-id="${id}"]`)?.remove();
  refreshEmpty();
}

function scrollToMark(id: string): void {
  const m = marks.get(id);
  if (!m) return;
  const target =
    m.range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (m.range.startContainer as Element)
      : m.range.startContainer.parentElement;
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  pulse(id);
}

function addRow(m: Mark): void {
  if (!listEl) return;
  const li = document.createElement("li");
  li.dataset.id = m.id;
  li.dataset.t = m.audience;
  li.innerHTML =
    '<div class="row-head">' +
    '<span class="chip" data-t="' +
    m.audience +
    '">' +
    (m.audience === "human" ? "For me" : "To agent") +
    "</span>" +
    '<button class="row-action" type="button">Delete</button>' +
    "</div>" +
    '<div class="quote">' +
    esc(m.exact) +
    "</div>" +
    '<div class="note">' +
    (m.note ? esc(m.note) : '<span style="color:var(--muted)">(no note)</span>') +
    "</div>";
  li.addEventListener("mouseenter", () => setActive(m.id, true));
  li.addEventListener("mouseleave", () => setActive(m.id, false));
  li.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains("row-action")) {
      deleteMark(m.id);
      return;
    }
    scrollToMark(m.id);
  });
  listEl.appendChild(li);
  refreshEmpty();
}

// ---- mount / unmount -------------------------------------------------------
const SHADOW_CSS = `
:host { all: initial; }

/* ===== orden theme variables (copied from apps/web/src/styles.css :root) ===== */
:host {
  --bg: #fbfbfa;
  --ink: #1f2328;
  --muted: #6b7280;
  --line: #e5e7eb;
  --panel-bg: #ffffff;
  --accent: #6d28d9;
  --accent-soft: color-mix(in srgb, var(--accent) 14%, #fff);
  --human: #6366f1;
  --human-soft: #e0e7ff;
  --font-scale: 1;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink);
}
* { box-sizing: border-box; }

/* ===== arm banner (kept from the original arm/disarm behaviour) ===== */
.banner {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: #1f2328; color: #f9fafb;
  font: 13px/1.2 -apple-system, system-ui, sans-serif;
  border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.35);
  pointer-events: auto; z-index: 2;
}
.banner .dot {
  width: 9px; height: 9px; border-radius: 50%; background: #a78bfa;
  box-shadow: 0 0 0 4px color-mix(in srgb, #a78bfa 30%, transparent); flex: 0 0 auto;
}
.banner .label { white-space: nowrap; }
.banner .exit {
  margin-left: 4px; padding: 3px 9px; background: #374151; color: #f9fafb;
  border: 1px solid #4b5563; border-radius: 5px; font: inherit; cursor: pointer;
}
.banner .exit:hover { background: #4b5563; }

/* ===== floating annotator: pill + composer (mirrors .annotator) ===== */
.annotator { position: fixed; z-index: 4; transform: translate(-50%, calc(-100% - 8px)); pointer-events: auto; }
.annotator.below { transform: translate(-50%, 8px); }
.annotator[hidden] { display: none; }
.annotator-pill {
  position: relative; font: inherit; font-size: calc(13px * var(--font-scale)); font-weight: 500;
  padding: 6px 14px; border: none; border-radius: 999px; background: #1f2328; color: #fff;
  cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.18);
}
.annotator-pill::after { content: ""; position: absolute; left: 50%; bottom: -5px; width: 10px; height: 10px;
  background: #1f2328; transform: translateX(-50%) rotate(45deg); }
.annotator.below .annotator-pill::after { bottom: auto; top: -5px; }
.annotator-composer {
  width: 300px; background: #fff; border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.16); padding: 10px; display: flex; flex-direction: column; gap: 8px;
}
.annotator-composer[hidden] { display: none; }
.annotator-toggle { display: flex; gap: 4px; }
.annotator-toggle button { flex: 1; font: inherit; font-size: calc(12px * var(--font-scale));
  padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--muted); cursor: pointer; }
.annotator-toggle button.is-on { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
.annotator-toggle button.is-on[data-t="human"] { border-color: var(--human); background: var(--human-soft); }
.annotator-note { font: inherit; font-size: calc(14px * var(--font-scale)); resize: vertical; min-height: 64px;
  border: 1px solid var(--line); border-radius: 6px; padding: 8px; outline: none; }
.annotator-note:focus { border-color: var(--accent); }
.annotator-actions { display: flex; justify-content: flex-end; gap: 6px; }
.annotator-actions button { font: inherit; font-size: calc(13px * var(--font-scale)); padding: 5px 14px;
  border-radius: 6px; cursor: pointer; border: 1px solid var(--line); }
.annotator-actions .ghost { background: #fff; color: var(--muted); }
.annotator-actions .primary { background: var(--ink); color: #fff; border-color: var(--ink); }

/* ===== annotations rail (mirrors orden #panel / #annotation-list) ===== */
.panel { position: fixed; top: 0; right: 0; bottom: 0; width: 320px;
  border-left: 1px solid var(--line); background: var(--panel-bg);
  display: flex; flex-direction: column; min-height: 0; pointer-events: auto;
  box-shadow: -4px 0 18px rgba(0,0,0,.08); z-index: 3; }
.panel > header { display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--line); font-weight: 600; font-size: calc(14px * var(--font-scale)); }
#annotation-list { list-style: none; margin: 0; padding: 8px; overflow-y: auto; flex: 1; }
#annotation-list li { padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 6px; margin-bottom: 8px; cursor: pointer; }
#annotation-list li[data-t="human"] { border-left-color: var(--human); }
#annotation-list li:hover, #annotation-list li.is-active { background: var(--accent-soft); }
#annotation-list li[data-t="human"]:hover, #annotation-list li[data-t="human"].is-active { background: var(--human-soft); }
#annotation-list .quote { font-size: calc(12px * var(--font-scale)); color: var(--muted); font-style: italic;
  margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#annotation-list .note { font-size: calc(14px * var(--font-scale)); }
.row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; min-height: 18px; }
.chip { font-size: calc(10px * var(--font-scale)); font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; background: #eef0f2; color: var(--muted); }
.chip[data-t="human"] { background: var(--human-soft); color: #4338ca; }
.row-action { font: inherit; font-size: calc(11px * var(--font-scale)); padding: 2px 8px; border: 1px solid var(--line);
  border-radius: 5px; background: #fff; color: var(--muted); cursor: pointer; opacity: 0; }
#annotation-list li:hover .row-action { opacity: 1; }
.empty { color: var(--muted); font-size: calc(13px * var(--font-scale)); padding: 18px 14px; text-align: center; }
`;

// The page-document stylesheet that actually paints the ::highlight() marks.
// Shadow-root styles cannot reach page text, so this must live in the page head.
const PAGE_HL_CSS = `
::highlight(${HL_BASE}) {
  background: color-mix(in srgb, #6d28d9 14%, transparent);
  text-decoration: underline;
  text-decoration-color: #6d28d9;
  text-decoration-thickness: 2px;
}
::highlight(${HL_ACTIVE}) {
  background: color-mix(in srgb, #6d28d9 24%, transparent);
}
`;

function unmount(): void {
  if (onKeydown) {
    document.removeEventListener("keydown", onKeydown, true);
    onKeydown = null;
  }
  if (onMouseup) {
    document.removeEventListener("mouseup", onMouseup, true);
    onMouseup = null;
  }
  if (onMessage && chrome?.runtime?.onMessage) {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // ignore — listener may already be gone
    }
    onMessage = null;
  }

  // tear down CSS highlights + the page-document style so the page is left clean
  if (hasHighlightApi()) {
    CSS.highlights.delete(HL_BASE);
    CSS.highlights.delete(HL_ACTIVE);
  }
  baseHl = null;
  activeHl = null;
  marks.clear();
  seq = 0;

  const existingStyle = pageStyleEl ?? document.getElementById(PAGE_STYLE_ID);
  if (existingStyle && existingStyle.parentNode) existingStyle.parentNode.removeChild(existingStyle);
  pageStyleEl = null;

  const existing = hostEl ?? document.getElementById(HOST_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  hostEl = null;
  shadowRoot = null;
  listEl = null;
  annotatorEl = null;
  pillEl = null;
  composerEl = null;
  noteEl = null;
  tAgentBtn = null;
  tHumanBtn = null;
  pendingRange = null;
  pendingAnchor = null;
  target = "agent";

  w[MOUNT_FLAG] = false;
}

function mount(): void {
  // Full-viewport, click-through host: bare page area keeps receiving selection
  // events; each interactive piece opts back in with pointer-events:auto.
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "2147483647";
  document.documentElement.appendChild(host);
  hostEl = host;

  const shadow = host.attachShadow({ mode: "open" });
  shadowRoot = shadow;

  const style = document.createElement("style");
  style.textContent = SHADOW_CSS;
  shadow.appendChild(style);

  // --- arm banner ---
  const banner = document.createElement("div");
  banner.className = "banner";
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "orden — annotation mode";
  const exit = document.createElement("button");
  exit.className = "exit";
  exit.type = "button";
  exit.textContent = "Exit";
  exit.addEventListener("click", () => unmount());
  banner.append(dot, label, exit);
  shadow.appendChild(banner);

  // --- annotations rail ---
  const panel = document.createElement("aside");
  panel.className = "panel";
  panel.innerHTML =
    "<header><span>Annotations</span></header>" + '<ul id="annotation-list"></ul>';
  shadow.appendChild(panel);
  listEl = panel.querySelector<HTMLUListElement>("#annotation-list");
  refreshEmpty();

  // --- floating composer ---
  const annotator = document.createElement("div");
  annotator.className = "annotator";
  annotator.hidden = true;
  annotator.innerHTML =
    '<button class="annotator-pill" type="button">Annotate</button>' +
    '<div class="annotator-composer" hidden>' +
    '<div class="annotator-toggle">' +
    '<button type="button" data-t="agent" class="is-on">To agent</button>' +
    '<button type="button" data-t="human">For me</button>' +
    "</div>" +
    '<textarea class="annotator-note" placeholder="Your note…"></textarea>' +
    '<div class="annotator-actions">' +
    '<button type="button" class="ghost">Cancel</button>' +
    '<button type="button" class="primary">Save</button>' +
    "</div>" +
    "</div>";
  shadow.appendChild(annotator);
  annotatorEl = annotator;
  pillEl = annotator.querySelector<HTMLButtonElement>(".annotator-pill");
  composerEl = annotator.querySelector<HTMLDivElement>(".annotator-composer");
  noteEl = annotator.querySelector<HTMLTextAreaElement>(".annotator-note");
  const toggles = annotator.querySelectorAll<HTMLButtonElement>(".annotator-toggle button");
  tAgentBtn = toggles[0] ?? null;
  tHumanBtn = toggles[1] ?? null;

  pillEl?.addEventListener("click", openComposer);
  tAgentBtn?.addEventListener("click", () => setTarget("agent"));
  tHumanBtn?.addEventListener("click", () => setTarget("human"));
  annotator.querySelector<HTMLButtonElement>(".ghost")?.addEventListener("click", hideAnnotator);
  annotator.querySelector<HTMLButtonElement>(".primary")?.addEventListener("click", saveAnnotation);

  // --- page-document highlight stylesheet (must NOT live in the shadow root) ---
  const pageStyle = document.createElement("style");
  pageStyle.id = PAGE_STYLE_ID;
  pageStyle.textContent = PAGE_HL_CSS;
  document.head.appendChild(pageStyle);
  pageStyleEl = pageStyle;

  // --- highlight registries ---
  if (hasHighlightApi()) {
    baseHl = new Highlight();
    activeHl = new Highlight();
    CSS.highlights.set(HL_BASE, baseHl);
    CSS.highlights.set(HL_ACTIVE, activeHl);
  }

  // --- selection → composer ---
  onMouseup = (e: MouseEvent) => {
    // Ignore selections/clicks inside our own overlay UI.
    if (e.composedPath().includes(host)) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (text.length < MIN_SELECTION) return;
    const range = sel.getRangeAt(0);
    pendingRange = range.cloneRange();
    pendingAnchor = computeAnchor(range);
    showAnnotatorAt(range.getBoundingClientRect());
  };
  document.addEventListener("mouseup", onMouseup, true);

  // --- Escape: close composer if open, else disarm. Capture phase. ---
  onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (annotatorEl && !annotatorEl.hidden) {
        e.stopPropagation();
        hideAnnotator();
      } else {
        e.stopPropagation();
        unmount();
      }
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  // --- toggle message from the service worker (or a re-trigger) ---
  onMessage = (msg, _sender, sendResponse) => {
    if (msg?.type === "orden-clipper-toggle") {
      unmount();
      sendResponse();
    }
  };
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(onMessage);
  }

  w[MOUNT_FLAG] = true;
}

// Entry: if already mounted (module re-injected), toggle OFF; else mount.
if (w[MOUNT_FLAG]) {
  unmount();
} else {
  mount();
}

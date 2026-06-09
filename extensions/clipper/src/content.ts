// Content script: arms/disarms orden "annotation mode" in the page, and — once
// armed — provides the real annotation overlay: select page text to open a
// floating composer; saving paints an orden-styled highlight (CSS Custom
// Highlight API, non-mutating) and adds a card to a draggable annotations rail;
// clicking a card scrolls to and pulses the highlight.
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
// by the host against a stored snapshot — not here.
//
// Persistence: the serializable parts of each highlight ({id, exact, prefix,
// suffix, note, audience}) are saved to chrome.storage.local keyed by the page
// URL on every add/delete, and restored (re-anchored against the live DOM) on the
// next arm. Disarm only tears down the in-DOM overlay; it never deletes the
// persisted records.

import { Readability } from "@mozilla/readability";
import { assignBlockIds, BLOCK_ID_ATTR } from "@orden/annotation-core";

const MOUNT_FLAG = "__ordenClipperMounted";
const HOST_ID = "orden-clipper-overlay-host";
const PAGE_STYLE_ID = "orden-clipper-page-style";

// CSS Custom Highlight registry names. We paint every saved mark into one
// registry and the transiently active/hovered/pulsed one into a second so it can
// be styled brighter. Single accent (orden agent purple) for all marks.
const HL_BASE = "orden-clip";
const HL_ACTIVE = "orden-clip-active";

const CONTEXT_LEN = 32;
const MIN_SELECTION = 4;

// Persistence key: scoped to the full page URL (hash/query included) for fidelity
// — distinct query/hash states are genuinely different pages for annotation
// purposes, and re-anchoring tolerates the occasional false-negative gracefully.
const CLIP_STORAGE_KEY = "clip:" + location.href;

// Audience is retained in the record so the later host-POST contract still
// carries it, but the UI no longer offers a choice — everything defaults to
// "agent"; the agent-vs-human routing decision moves to orden.
type Audience = "agent" | "human";

interface ClipperWindow extends Window {
  [MOUNT_FLAG]?: boolean;
}

// The serializable shape persisted to chrome.storage.local (no live Range).
interface MarkRecord {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  note: string;
  audience: Audience;
}

interface Mark extends MarkRecord {
  // null when a persisted record could not be re-anchored against the current
  // DOM; the card is still shown (note preserved) but marked unanchored and is
  // not painted / not scrollable.
  range: Range | null;
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
let panelEl: HTMLElement | null = null;
let panelHeaderEl: HTMLElement | null = null;
let statusEl: HTMLDivElement | null = null;

// --- host sync state (auto-detect + debounced auto-submit) ------------------
// A frozen snapshot of the article HTML (Readability, block-ids stamped) built
// ONCE per arm session and reused for every debounced sync, so the host's
// content-hash stays stable and journal/session creation are first-capture-only.
let snapshotHtml: string | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 1000;

let baseHl: Highlight | null = null;
let activeHl: Highlight | null = null;

const marks = new Map<string, Mark>();
let pendingRange: Range | null = null;
let pendingAnchor: { exact: string; prefix: string; suffix: string } | null = null;
let seq = 0;

// drag-state for the floating rail
let dragging = false;
let dragDX = 0;
let dragDY = 0;
let onDragMove: ((e: MouseEvent) => void) | null = null;
let onDragUp: ((e: MouseEvent) => void) | null = null;

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

// ---- persistence (chrome.storage.local, keyed by page URL) -----------------
function toRecord(m: Mark): MarkRecord {
  return {
    id: m.id,
    exact: m.exact,
    prefix: m.prefix,
    suffix: m.suffix,
    note: m.note,
    audience: m.audience,
  };
}

// Persist the current set of marks. Fire-and-forget; log on failure.
function persist(): void {
  if (!chrome?.storage?.local) return;
  const records = Array.from(marks.values()).map(toRecord);
  try {
    const p = chrome.storage.local.set({ [CLIP_STORAGE_KEY]: records });
    if (p && typeof p.catch === "function") {
      p.catch((err: unknown) => console.warn("[orden-clipper] persist failed", err));
    }
  } catch (err) {
    console.warn("[orden-clipper] persist failed", err);
  }
}

async function loadRecords(): Promise<MarkRecord[]> {
  if (!chrome?.storage?.local) return [];
  try {
    const got = await chrome.storage.local.get(CLIP_STORAGE_KEY);
    const recs = got?.[CLIP_STORAGE_KEY];
    return Array.isArray(recs) ? (recs as MarkRecord[]) : [];
  } catch (err) {
    console.warn("[orden-clipper] load failed", err);
    return [];
  }
}

// ---- re-anchor: find a record's `exact` text in the live DOM ----------------
// Walk visible text nodes, find every occurrence of `exact`, and pick the one
// whose surrounding text best matches the stored prefix/suffix. Returns a fresh
// Range, or null if `exact` does not occur in the document.
function reanchor(rec: MarkRecord): Range | null {
  const needle = rec.exact;
  if (!needle) return null;

  // Collect candidate occurrences as (textNode, offset) start points. We only
  // support matches that begin and end within a single text node — multi-node
  // selections are rarer and best left unanchored than mis-anchored.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const candidates: { node: Text; offset: number }[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node.data;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx < 0) break;
      candidates.push({ node, offset: idx });
      from = idx + 1; // allow overlapping occurrences
    }
    node = walker.nextNode() as Text | null;
  }
  if (candidates.length === 0) return null;

  // Score each candidate by how well the chars just before/after the match line
  // up with the stored prefix/suffix (longest common suffix-of-prefix /
  // prefix-of-suffix). Highest score wins; first occurrence breaks ties.
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const before = c.node.data.slice(Math.max(0, c.offset - CONTEXT_LEN), c.offset);
    const after = c.node.data.slice(
      c.offset + needle.length,
      c.offset + needle.length + CONTEXT_LEN,
    );
    const score = commonSuffix(before, rec.prefix) + commonPrefix(after, rec.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  try {
    const range = document.createRange();
    range.setStart(best.node, best.offset);
    range.setEnd(best.node, best.offset + needle.length);
    return range;
  } catch {
    return null;
  }
}

// length of the longest common suffix shared by a and b
function commonSuffix(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// length of the longest common prefix shared by a and b
function commonPrefix(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return i;
}

// ---- snapshot: a frozen, block-id-stamped article HTML (once per arm) -------
// We build this on a CLONE so the live page DOM is never mutated. Order of
// preference: Readability (a cleaned article) → sanitized <body> → documentElement.
// In all cases we stamp data-orden-block-id attrs via annotation-core so each
// highlight can later be resolved to an enclosing block on the host's snapshot.
function buildSnapshotHtml(): string {
  // 1. Readability on a clone of the document.
  try {
    const docClone = document.cloneNode(true) as Document;
    const parsed = new Readability(docClone).parse();
    const content = parsed?.content?.trim();
    if (content) {
      const stamped = stampBlockIds(content);
      if (stamped) return stamped;
    }
  } catch (err) {
    console.warn("[orden-clipper] Readability failed", err);
  }

  // 2. Fallback: a clone of <body>, scripts/styles stripped, stamped.
  try {
    if (document.body) {
      const bodyClone = document.body.cloneNode(true) as HTMLElement;
      bodyClone.querySelectorAll("script,style,noscript,link,iframe").forEach((n) => n.remove());
      assignBlockIds(bodyClone);
      const html = bodyClone.outerHTML;
      if (html && html.trim()) return html;
    }
  } catch (err) {
    console.warn("[orden-clipper] body snapshot failed", err);
  }

  // 3. Last resort: the whole document element, stamped if possible.
  try {
    return stampBlockIds(document.documentElement.outerHTML) ?? document.documentElement.outerHTML;
  } catch {
    return document.documentElement.outerHTML;
  }
}

// Parse an HTML string into a detached document, stamp block-ids on its body, and
// serialize back. Returns null if parsing yields nothing usable.
function stampBlockIds(html: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.body;
    if (!root || !root.firstChild) return null;
    assignBlockIds(root);
    return root.innerHTML;
  } catch {
    return null;
  }
}

// ---- resolve each highlight to a snapshot blockId --------------------------
// The snapshot is a DIFFERENT (cleaned) DOM than the live page, so we re-find the
// highlight's `exact` text inside the snapshot and read its enclosing block's
// data-orden-block-id. prefix/suffix disambiguate repeated occurrences, mirroring
// the live-page re-anchor scoring. Returns "unanchored" when not found.
function resolveBlockIds(rec: MarkRecord[]): string[] {
  let snapDoc: Document | null = null;
  try {
    snapDoc = new DOMParser().parseFromString(snapshotHtml ?? "", "text/html");
  } catch {
    snapDoc = null;
  }
  return rec.map((r) => (snapDoc ? resolveBlockId(snapDoc, r) : "unanchored"));
}

function resolveBlockId(doc: Document, rec: MarkRecord): string {
  const needle = rec.exact;
  if (!needle || !doc.body) return "unanchored";

  // Recursive text walk (avoids the happy-dom-style TreeWalker inline-skip; also
  // keeps a reference to the containing element to read its block id).
  const candidates: { node: Text; offset: number }[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n as Text).data;
      let from = 0;
      for (;;) {
        const idx = text.indexOf(needle, from);
        if (idx < 0) break;
        candidates.push({ node: n as Text, offset: idx });
        from = idx + 1;
      }
      return;
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(doc.body);
  if (candidates.length === 0) return "unanchored";

  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const before = c.node.data.slice(Math.max(0, c.offset - CONTEXT_LEN), c.offset);
    const after = c.node.data.slice(c.offset + needle.length, c.offset + needle.length + CONTEXT_LEN);
    const score = commonSuffix(before, rec.prefix) + commonPrefix(after, rec.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  // Climb to the nearest ancestor carrying a stamped block id.
  let el: Element | null =
    best.node.parentElement ?? (best.node.parentNode as Element | null);
  while (el) {
    const id = el.getAttribute?.(BLOCK_ID_ATTR);
    if (id) return id;
    el = el.parentElement;
  }
  return "unanchored";
}

// ---- host detect + status line ---------------------------------------------
type SyncStatus = "idle" | "ok" | "syncing" | "synced" | "failed" | "nohost";

function setStatus(kind: SyncStatus, text: string): void {
  if (!statusEl) return;
  statusEl.dataset.kind = kind;
  statusEl.innerHTML =
    '<span class="status-dot"></span><span class="status-text">' + esc(text) + "</span>";
  if (kind === "nohost") {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "status-link";
    link.textContent = "Open options";
    link.addEventListener("click", () => {
      try {
        chrome?.runtime?.sendMessage?.({ type: "orden-open-options" });
      } catch {
        // ignore
      }
    });
    statusEl.querySelector(".status-text")?.appendChild(document.createTextNode(" "));
    statusEl.appendChild(link);
  }
}

function detectHost(): void {
  if (!chrome?.runtime?.sendMessage) {
    setStatus("nohost", "Extension messaging unavailable");
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: "orden-detect" }, (resp: { ok?: boolean } | undefined) => {
      // chrome.runtime.lastError set if the SW didn't answer; treat as no host.
      if (chrome.runtime?.lastError || !resp?.ok) {
        setStatus("nohost", "No orden host —");
      } else {
        setStatus("ok", "Connected to orden");
      }
    });
  } catch {
    setStatus("nohost", "No orden host —");
  }
}

// ---- debounced auto-submit -------------------------------------------------
function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSync();
  }, SYNC_DEBOUNCE_MS);
}

function runSync(): void {
  if (!w[MOUNT_FLAG]) return; // disarmed
  if (!chrome?.runtime?.sendMessage) return;

  const records = Array.from(marks.values()).map(toRecord);
  if (records.length === 0) return; // never send empty captures

  if (!snapshotHtml) snapshotHtml = buildSnapshotHtml();
  const blockIds = resolveBlockIds(records);

  const bundle = {
    url: location.href,
    title: document.title,
    snapshotHtml,
    ext: "html" as const,
    highlights: records.map((r, i) => ({
      exact: r.exact,
      prefix: r.prefix,
      suffix: r.suffix,
      blockId: blockIds[i],
      note: r.note,
      audience: r.audience,
    })),
    routing: {},
  };

  setStatus("syncing", "Syncing…");
  try {
    chrome.runtime.sendMessage(
      { type: "orden-capture", bundle },
      (resp: { ok?: boolean; result?: { annotationCount?: number } } | undefined) => {
        if (chrome.runtime?.lastError || !resp?.ok) {
          setStatus("failed", "Sync failed — is orden running?");
          return;
        }
        const n = resp.result?.annotationCount ?? records.length;
        const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setStatus("synced", `Synced to orden ✓ (${n} · ${time})`);
      },
    );
  } catch {
    setStatus("failed", "Sync failed — is orden running?");
  }
}

// ---- highlight painting ----------------------------------------------------
function repaintBase(): void {
  if (!baseHl || !hasHighlightApi()) return;
  baseHl.clear();
  for (const m of marks.values()) if (m.range) baseHl.add(m.range);
}

function setActive(id: string, on: boolean): void {
  if (!activeHl || !hasHighlightApi()) return;
  const m = marks.get(id);
  if (!m || !m.range) return;
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

function openComposer(): void {
  if (!pillEl || !composerEl || !noteEl) return;
  pillEl.style.display = "none";
  composerEl.hidden = false;
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
    audience: "agent", // routing decision moves to orden; default agent for now
    range: pendingRange.cloneRange(),
  };
  marks.set(id, mark);
  repaintBase();
  addRow(mark);
  persist();
  scheduleSync();
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
  persist();
  scheduleSync();
}

function scrollToMark(id: string): void {
  const m = marks.get(id);
  if (!m || !m.range) return; // unanchored cards are not scrollable
  const target =
    m.range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (m.range.startContainer as Element)
      : m.range.startContainer.parentElement;
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  pulse(id);
}

function addRow(m: Mark): void {
  if (!listEl) return;
  const unanchored = !m.range;
  const li = document.createElement("li");
  li.dataset.id = m.id;
  if (unanchored) li.classList.add("unanchored");
  li.innerHTML =
    '<div class="row-head">' +
    (unanchored ? '<span class="chip warn">Unanchored</span>' : "<span></span>") +
    '<button class="row-action" type="button">Delete</button>' +
    "</div>" +
    '<div class="quote">' +
    esc(m.exact) +
    "</div>" +
    '<div class="note">' +
    (m.note ? esc(m.note) : '<span style="color:var(--muted)">(no note)</span>') +
    "</div>";
  if (!unanchored) {
    li.addEventListener("mouseenter", () => setActive(m.id, true));
    li.addEventListener("mouseleave", () => setActive(m.id, false));
  }
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
.annotator-note { font: inherit; font-size: calc(14px * var(--font-scale)); resize: vertical; min-height: 64px;
  border: 1px solid var(--line); border-radius: 6px; padding: 8px; outline: none; }
.annotator-note:focus { border-color: var(--accent); }
.annotator-actions { display: flex; justify-content: flex-end; gap: 6px; }
.annotator-actions button { font: inherit; font-size: calc(13px * var(--font-scale)); padding: 5px 14px;
  border-radius: 6px; cursor: pointer; border: 1px solid var(--line); }
.annotator-actions .ghost { background: #fff; color: var(--muted); }
.annotator-actions .primary { background: var(--ink); color: #fff; border-color: var(--ink); }

/* ===== annotations rail: a FLOATING, DRAGGABLE 30vw window ===== */
.panel { position: fixed; top: 16px; right: 16px; width: 30vw; min-width: 320px; max-height: 80vh;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel-bg);
  display: flex; flex-direction: column; min-height: 0; pointer-events: auto;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); z-index: 3; }
.panel > header { display: flex; align-items: center; gap: 8px;
  padding: 14px 15px; border-bottom: 1px solid var(--line); font-weight: 600;
  font-size: calc(14px * var(--font-scale)); cursor: move; user-select: none;
  border-top-left-radius: 10px; border-top-right-radius: 10px; }
.panel > header .grip { color: var(--muted); font-weight: 700; letter-spacing: -2px; flex: 0 0 auto; }
.panel > header .title { flex: 1 1 auto; }
#annotation-list { list-style: none; margin: 0; padding: 15px; overflow-y: auto; flex: 1; min-height: 0; }
#annotation-list li { padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 6px; margin-bottom: 8px; cursor: pointer; }
#annotation-list li:hover, #annotation-list li.is-active { background: var(--accent-soft); }
#annotation-list li.unanchored { border-left-style: dashed; opacity: .6; cursor: default; }
#annotation-list li.unanchored:hover { background: transparent; }
#annotation-list .quote { font-size: calc(12px * var(--font-scale)); color: var(--muted); font-style: italic;
  margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#annotation-list .note { font-size: calc(14px * var(--font-scale)); }
.row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; min-height: 18px; }
.chip { font-size: calc(10px * var(--font-scale)); font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; background: #eef0f2; color: var(--muted); }
.chip.warn { background: #fef3c7; color: #92400e; }
.row-action { font: inherit; font-size: calc(11px * var(--font-scale)); padding: 2px 8px; border: 1px solid var(--line);
  border-radius: 5px; background: #fff; color: var(--muted); cursor: pointer; opacity: 0; }
#annotation-list li:hover .row-action { opacity: 1; }
.empty { color: var(--muted); font-size: calc(13px * var(--font-scale)); padding: 18px 14px; text-align: center; }

/* ===== sync status line (under the header; auto-detect + auto-submit) ===== */
.sync-status { display: flex; align-items: center; gap: 7px; padding: 8px 15px;
  border-bottom: 1px solid var(--line); font-size: calc(12px * var(--font-scale)); color: var(--muted); }
.sync-status .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: 0 0 auto; }
.sync-status .status-text { flex: 1 1 auto; }
.sync-status[data-kind="ok"] .status-dot,
.sync-status[data-kind="synced"] .status-dot { background: #10b981; }
.sync-status[data-kind="syncing"] .status-dot { background: var(--accent); }
.sync-status[data-kind="failed"] .status-dot,
.sync-status[data-kind="nohost"] .status-dot { background: #ef4444; }
.sync-status .status-link { font: inherit; font-size: inherit; color: var(--accent);
  background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; }
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
  if (onDragMove) {
    document.removeEventListener("mousemove", onDragMove, true);
    onDragMove = null;
  }
  if (onDragUp) {
    document.removeEventListener("mouseup", onDragUp, true);
    onDragUp = null;
  }
  dragging = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  snapshotHtml = null;
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
  panelEl = null;
  panelHeaderEl = null;
  statusEl = null;
  pendingRange = null;
  pendingAnchor = null;

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

  // --- annotations rail (floating, draggable) ---
  const panel = document.createElement("aside");
  panel.className = "panel";
  panel.innerHTML =
    '<header><span class="grip" aria-hidden="true">⋮⋮</span>' +
    '<span class="title">Annotations</span></header>' +
    '<div class="sync-status" data-kind="idle">' +
    '<span class="status-dot"></span><span class="status-text">Checking orden…</span></div>' +
    '<ul id="annotation-list"></ul>';
  shadow.appendChild(panel);
  panelEl = panel;
  listEl = panel.querySelector<HTMLUListElement>("#annotation-list");
  statusEl = panel.querySelector<HTMLDivElement>(".sync-status");
  panelHeaderEl = panel.querySelector<HTMLElement>("header");
  panelHeaderEl?.addEventListener("mousedown", startDrag);
  refreshEmpty();

  // --- floating composer ---
  const annotator = document.createElement("div");
  annotator.className = "annotator";
  annotator.hidden = true;
  annotator.innerHTML =
    '<button class="annotator-pill" type="button">Annotate</button>' +
    '<div class="annotator-composer" hidden>' +
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

  pillEl?.addEventListener("click", openComposer);
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

  // --- build the frozen snapshot ONCE for this arm session (off a clone) ---
  snapshotHtml = buildSnapshotHtml();

  // --- auto-detect the orden host and reflect it in the status line ---
  detectHost();

  // --- restore persisted annotations for this URL ---
  // Re-anchor each saved record against the live DOM. Records that can't be
  // re-anchored still get a (dimmed, dashed, non-scrolling) card so the note
  // isn't lost. Guarded by the mount flag in case disarm raced the async load.
  void restorePersisted();
}

async function restorePersisted(): Promise<void> {
  const records = await loadRecords();
  if (!w[MOUNT_FLAG] || !listEl) return; // disarmed while loading
  for (const rec of records) {
    const range = reanchor(rec);
    const mark: Mark = { ...rec, range };
    marks.set(mark.id, mark);
    addRow(mark);
    // keep the seq counter ahead of restored ids so new ids never collide
    const n = Number.parseInt(mark.id.replace(/^a/, ""), 10);
    if (Number.isFinite(n) && n > seq) seq = n;
  }
  repaintBase();
}

// ---- rail drag -------------------------------------------------------------
// The header is the drag handle. We ignore mousedowns on its buttons (none today,
// but future Submit/Copy live here) so dragging only starts on the bare handle.
function startDrag(e: MouseEvent): void {
  if (!panelEl) return;
  const t = e.target as HTMLElement;
  if (t.closest("button")) return; // let header buttons work normally
  e.preventDefault();
  const rect = panelEl.getBoundingClientRect();
  // Switch from top/right anchoring to left/top on first drag.
  panelEl.style.right = "auto";
  panelEl.style.left = rect.left + "px";
  panelEl.style.top = rect.top + "px";
  dragDX = e.clientX - rect.left;
  dragDY = e.clientY - rect.top;
  dragging = true;

  onDragMove = (ev: MouseEvent) => {
    if (!dragging || !panelEl) return;
    const w0 = panelEl.offsetWidth;
    // Constrain so the header stays on-screen: keep at least a sliver of the
    // window visible on every edge (~40px of header reachable).
    const margin = 40;
    let left = ev.clientX - dragDX;
    let top = ev.clientY - dragDY;
    left = Math.min(window.innerWidth - margin, Math.max(margin - w0, left));
    top = Math.min(window.innerHeight - margin, Math.max(0, top));
    panelEl.style.left = left + "px";
    panelEl.style.top = top + "px";
  };
  onDragUp = () => {
    dragging = false;
    if (onDragMove) {
      document.removeEventListener("mousemove", onDragMove, true);
      onDragMove = null;
    }
    if (onDragUp) {
      document.removeEventListener("mouseup", onDragUp, true);
      onDragUp = null;
    }
  };
  document.addEventListener("mousemove", onDragMove, true);
  document.addEventListener("mouseup", onDragUp, true);
}

// Entry: if already mounted (module re-injected), toggle OFF; else mount.
if (w[MOUNT_FLAG]) {
  unmount();
} else {
  mount();
}

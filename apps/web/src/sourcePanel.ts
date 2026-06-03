// Source-agnostic annotation panel renderer.
//
// Unlike renderPanel() in main.ts (which walks the live ProseMirror doc), this
// lists stored OrdenAnnotation records directly, so the code / image / html
// viewers can show their annotations without a ProseMirror document. It reuses
// the same row markup/classes as buildRow() so the existing #annotation-list
// CSS styles it identically.

import type { OrdenAnnotation, Selector } from "@orden/annotation-core";

interface SourcePanelOpts {
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  sent: "Sent",
  resolved: "Resolved",
};

// target.selector may be a single Selector or an array of fallbacks; pull the
// exact text from the first text-quote selector, or "" for region-only targets.
function quoteText(ann: OrdenAnnotation): string {
  const selectors: Selector[] = Array.isArray(ann.target.selector)
    ? ann.target.selector
    : [ann.target.selector];
  const tq = selectors.find((s) => s.type === "text-quote");
  return tq && tq.type === "text-quote" ? tq.exact : "";
}

function buildRow(ann: OrdenAnnotation, opts: SourcePanelOpts): HTMLLIElement {
  const status = ann["orden:status"] ?? "open";
  const li = document.createElement("li");
  li.dataset.annotationId = ann.id;
  li.dataset.status = status;

  const head = document.createElement("div");
  head.className = "row-head";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = STATUS_LABEL[status] ?? status;
  head.append(chip);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const del = document.createElement("button");
  del.className = "row-action del";
  del.textContent = "Delete";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onDelete?.(ann.id);
  });
  actions.append(del);
  head.append(actions);

  const quoteEl = document.createElement("div");
  quoteEl.className = "quote";
  quoteEl.textContent = quoteText(ann);

  const noteEl = document.createElement("div");
  noteEl.className = "note";
  noteEl.textContent = ann.body?.text ?? "";

  li.append(head, quoteEl, noteEl);
  li.addEventListener("click", () => opts.onSelect?.(ann.id));
  return li;
}

export function renderSourcePanel(
  listEl: HTMLElement,
  anns: OrdenAnnotation[],
  opts: SourcePanelOpts,
): void {
  listEl.replaceChildren();

  if (anns.length === 0) {
    const empty = document.createElement("li");
    empty.className = "panel-empty";
    empty.textContent = "No annotations";
    listEl.append(empty);
    return;
  }

  for (const ann of anns) {
    listEl.append(buildRow(ann, opts));
  }
}

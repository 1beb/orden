import type { Card } from "./types";
import { buildBoard } from "./kanban";

/**
 * Options for the generic board renderer. All orden-specific policy (which lanes
 * exist, their order, their labels, which count as "action") is received here as
 * a parameter — the outliner renders any lane set a caller passes. See
 * docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
 */
export interface RenderBoardOptions<T extends string> {
  /** Lane keys in display order, left to right. */
  states: readonly T[];
  /** Display label per lane key. */
  labels: Record<T, string>;
  /**
   * Lanes that get the `orden-column--action` modifier class and feed the
   * board-level "needs action" badge. Default: none.
   */
  actionStates?: readonly T[];
  /** Board title (header). Default "Board". */
  title?: string;
  /**
   * `doc` defaults to the ambient `document`; pass one explicitly for testing
   * under happy-dom or for server-side rendering.
   */
  doc?: Document;
}

/**
 * Render a Kanban board into a host element as vanilla DOM (framework-agnostic).
 * Columns appear in the caller's chosen order, each with a per-column count
 * badge; the board header carries a global "needs action" badge when any card is
 * in an `actionStates` lane. Generic over the lane key — no lane set is baked in.
 */
export function renderBoard<T extends string>(
  host: HTMLElement,
  cards: Card<T>[],
  opts: RenderBoardOptions<T>,
): void {
  const doc = opts.doc ?? document;
  const actionStates = opts.actionStates ?? [];
  const isAction = (state: T): boolean => actionStates.includes(state);
  const actionCount = cards.filter((c) => isAction(c.state)).length;

  host.replaceChildren();
  host.classList.add("orden-board");

  const header = doc.createElement("div");
  header.className = "orden-board__header";
  const title = doc.createElement("h2");
  title.textContent = opts.title ?? "Board";
  header.appendChild(title);

  if (actionCount > 0) {
    const badge = doc.createElement("span");
    badge.className = "orden-board__needs-action";
    badge.dataset.count = String(actionCount);
    badge.textContent = `${actionCount} needs action`;
    header.appendChild(badge);
  }
  host.appendChild(header);

  const columns = doc.createElement("div");
  columns.className = "orden-board__columns";

  for (const column of buildBoard(cards, opts.states)) {
    const col = doc.createElement("section");
    col.className = "orden-column";
    col.dataset.state = column.state;
    if (isAction(column.state)) col.classList.add("orden-column--action");

    const head = doc.createElement("header");
    head.className = "orden-column__header";
    const label = doc.createElement("span");
    label.className = "orden-column__title";
    label.textContent = opts.labels[column.state];
    const count = doc.createElement("span");
    count.className = "orden-column__count";
    count.textContent = String(column.cards.length);
    head.append(label, count);
    col.appendChild(head);

    const list = doc.createElement("ul");
    list.className = "orden-column__cards";
    for (const card of column.cards) {
      const li = doc.createElement("li");
      li.className = "orden-card";
      li.dataset.cardId = card.id;
      li.textContent = card.title;
      list.appendChild(li);
    }
    col.appendChild(list);
    columns.appendChild(col);
  }

  host.appendChild(columns);
}

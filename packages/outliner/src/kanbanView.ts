import type { Card, CardState } from "./types";
import { buildBoard, needsActionCount, isNeedsAction } from "./kanban";

const STATE_LABELS: Record<CardState, string> = {
  planning: "Planning",
  "in-progress": "In-progress",
  blocked: "Blocked",
  complete: "Complete",
  learnings: "Learnings",
};

/**
 * Render a Kanban board into a host element as vanilla DOM (framework-agnostic).
 * Columns appear in lifecycle order, each with a per-column count badge; the
 * board header carries the global "needs action" badge.
 *
 * `doc` defaults to the ambient `document`; pass one explicitly for testing
 * under happy-dom or for server-side rendering.
 */
export function renderBoard(
  host: HTMLElement,
  cards: Card[],
  doc: Document = document,
): void {
  host.replaceChildren();
  host.classList.add("orden-board");

  const header = doc.createElement("div");
  header.className = "orden-board__header";
  const title = doc.createElement("h2");
  title.textContent = "Kanban";
  header.appendChild(title);

  const action = needsActionCount(cards);
  const badge = doc.createElement("span");
  badge.className = "orden-board__needs-action";
  badge.dataset.count = String(action);
  badge.textContent = `${action} needs action`;
  header.appendChild(badge);
  host.appendChild(header);

  const columns = doc.createElement("div");
  columns.className = "orden-board__columns";

  for (const column of buildBoard(cards)) {
    const col = doc.createElement("section");
    col.className = "orden-column";
    col.dataset.state = column.state;
    if (isNeedsAction(column.state)) col.classList.add("orden-column--action");

    const head = doc.createElement("header");
    head.className = "orden-column__header";
    const label = doc.createElement("span");
    label.className = "orden-column__title";
    label.textContent = STATE_LABELS[column.state];
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

import { LIFECYCLE_ORDER, isNeedsAction, type CardState } from "@orden/outliner";
import { listItems, setItemState } from "./cards";
import { getProject } from "./projects";

const STATES: CardState[] = [...LIFECYCLE_ORDER, "broken"];

// The board is the cross-cutting view of all projects' items. Rendered in-app
// (not via the package's read-only renderBoard) so cards are clickable (→ their
// project page) and draggable between columns (→ change state).
export function renderKanban(
  container: HTMLElement,
  onOpenProject: (projectId: string) => void,
): number {
  const items = listItems();
  const needs = items.filter((i) => isNeedsAction(i.state)).length;

  container.replaceChildren();
  container.classList.add("orden-board");

  const header = document.createElement("div");
  header.className = "orden-board__header";
  const h2 = document.createElement("h2");
  h2.textContent = "Kanban";
  header.append(h2);
  if (needs > 0) {
    const badge = document.createElement("span");
    badge.className = "orden-board__needs-action";
    badge.textContent = `${needs} needs action`;
    header.append(badge);
  }
  container.append(header);

  const columns = document.createElement("div");
  columns.className = "orden-board__columns";
  for (const state of STATES) {
    const colItems = items.filter((i) => i.state === state);
    const col = document.createElement("div");
    col.className = "orden-column";
    col.dataset.state = state;
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drop-target");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-target"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop-target");
      const id = e.dataTransfer?.getData("text/plain");
      if (id) {
        setItemState(id, state);
        renderKanban(container, onOpenProject);
      }
    });

    const colHead = document.createElement("div");
    colHead.className = "orden-column__header";
    colHead.innerHTML = `<span class="orden-column__title">${state}</span><span class="orden-column__count">${colItems.length}</span>`;
    col.append(colHead);

    const cardsEl = document.createElement("div");
    cardsEl.className = "orden-column__cards";
    for (const item of colItems) {
      const card = document.createElement("div");
      card.className = "orden-card";
      card.draggable = true;
      card.dataset.itemId = item.id;
      const title = document.createElement("div");
      title.className = "orden-card__title";
      title.textContent = item.title;
      const proj = document.createElement("div");
      proj.className = "orden-card__project";
      proj.textContent = getProject(item.projectId)?.name ?? "—";
      card.append(title, proj);
      card.addEventListener("click", () => onOpenProject(item.projectId));
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", item.id);
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      cardsEl.append(card);
    }
    col.append(cardsEl);
    columns.append(col);
  }
  container.append(columns);
  return needs;
}

import { LIFECYCLE_ORDER, isNeedsAction, type CardState } from "@orden/outliner";
import { listItems, setItemState, setItemProject, cardSessionIds, type Item } from "./cards";
import { listProjects } from "./projects";
import { agentLauncher } from "./agentMarks";
import { setSessionProject, type Agent } from "./sessions";
import { openCardModal } from "./cardModal";

const STATES: CardState[] = [...LIFECYCLE_ORDER];

// Capitalized column titles; the stored state stays lowercase.
const STATE_LABELS: Record<CardState, string> = {
  planning: "Planning",
  "in-progress": "In-progress",
  blocked: "Blocked",
  complete: "Complete",
};

// Board filters live at module scope so they survive the full re-render that
// every board mutation triggers (renderKanban rebuilds the container each call).
interface BoardFilters {
  dueOnly: boolean; // only cards that have a due date
  noSessions: boolean; // only cards with zero linked sessions
  projectId: string; // "" = all projects
}
const filters: BoardFilters = { dueOnly: false, noSessions: false, projectId: "" };

export interface KanbanDeps {
  onStartSession: (item: Item, agent: Agent) => void;
  onOpenSession: (sessionId: string) => void;
}

function todayISO(): string {
  // Local-date yyyy-mm-dd (matches the <input type=date> value the user picks).
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function passesFilters(item: Item): boolean {
  if (filters.dueOnly && !item.dueDate) return false;
  if (filters.noSessions && cardSessionIds(item).length > 0) return false;
  if (filters.projectId && item.projectId !== filters.projectId) return false;
  return true;
}

// The board is the cross-cutting view of all projects' items. Rendered in-app
// (not via the package's read-only renderBoard) so cards are clickable (→ open a
// detail modal) and draggable between columns (→ change state).
export function renderKanban(container: HTMLElement, deps: KanbanDeps): number {
  const allItems = listItems();
  const items = allItems.filter(passesFilters);
  const needs = allItems.filter((i) => isNeedsAction(i.state)).length;

  const rerender = (): number => renderKanban(container, deps);

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

  // Filter bar: two toggle chips + a project picker. Toggling re-renders.
  const bar = document.createElement("div");
  bar.className = "orden-board__filters";

  const dueChip = filterChip("Has due date", filters.dueOnly, () => {
    filters.dueOnly = !filters.dueOnly;
    rerender();
  });
  const noSessChip = filterChip("No sessions", filters.noSessions, () => {
    filters.noSessions = !filters.noSessions;
    rerender();
  });
  bar.append(dueChip, noSessChip);

  const projSel = document.createElement("select");
  projSel.className = "orden-board__filter-project";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All projects";
  allOpt.selected = filters.projectId === "";
  projSel.append(allOpt);
  for (const p of listProjects()) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    opt.selected = p.id === filters.projectId;
    projSel.append(opt);
  }
  projSel.addEventListener("change", () => {
    filters.projectId = projSel.value;
    rerender();
  });
  bar.append(projSel);

  if (filters.dueOnly || filters.noSessions || filters.projectId) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "orden-board__filter-clear";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      filters.dueOnly = false;
      filters.noSessions = false;
      filters.projectId = "";
      rerender();
    });
    bar.append(clear);
  }
  container.append(bar);

  const today = todayISO();
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
        rerender();
      }
    });

    const colHead = document.createElement("div");
    colHead.className = "orden-column__header";
    colHead.innerHTML = `<span class="orden-column__title">${STATE_LABELS[state]}</span><span class="orden-column__count">${colItems.length}</span>`;
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
      // Project shown in small caps under the title, as a select so the card can
      // be reassigned to another project inline. Pointer events are stopped so
      // using it neither opens the modal (card click) nor starts a drag.
      const proj = document.createElement("select");
      proj.className = "orden-card__project";
      proj.title = "Project";
      for (const p of listProjects()) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        opt.selected = p.id === item.projectId;
        proj.append(opt);
      }
      proj.addEventListener("mousedown", (e) => e.stopPropagation());
      proj.addEventListener("click", (e) => e.stopPropagation());
      proj.addEventListener("change", (e) => {
        e.stopPropagation();
        setItemProject(item.id, proj.value);
        // Keep linked sessions on the same project so they don't strand under
        // Homeroom's "Active sessions" while their card moved away.
        for (const sid of cardSessionIds(item)) setSessionProject(sid, proj.value);
        rerender();
      });
      card.append(title, proj);

      // Footer line: due-date badge (overdue when past today and not complete)
      // and a session-count badge.
      const sessionIds = cardSessionIds(item);
      if (item.dueDate || sessionIds.length > 0) {
        const footer = document.createElement("div");
        footer.className = "orden-card__footer";
        if (item.dueDate) {
          const due = document.createElement("span");
          due.className = "orden-card__due";
          if (item.dueDate < today && item.state !== "complete") due.classList.add("is-overdue");
          due.textContent = `Due ${item.dueDate}`;
          footer.append(due);
        }
        if (sessionIds.length > 0) {
          const sess = document.createElement("span");
          sess.className = "orden-card__sesscount";
          sess.textContent = `${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"}`;
          // A single session opens directly on click (stop the event so it
          // doesn't also bubble to the card → modal). With multiple sessions
          // there's no obvious target, so let the click fall through to the
          // modal where they're listed.
          if (sessionIds.length === 1) {
            sess.classList.add("is-clickable");
            sess.title = "Open session";
            sess.addEventListener("click", (e) => {
              e.stopPropagation();
              deps.onOpenSession(sessionIds[0]);
            });
          }
          footer.append(sess);
        }
        card.append(footer);
      }

      // No AI conversation yet → offer to start one (Claude / opencode) right
      // from the card; the new session links to this card (no duplicate).
      if (sessionIds.length === 0) {
        card.append(agentLauncher((agent) => deps.onStartSession(item, agent)));
      }
      card.addEventListener("click", () =>
        openCardModal(item.id, {
          onStartSession: deps.onStartSession,
          onOpenSession: deps.onOpenSession,
          onChange: rerender,
        }),
      );
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

// A pill toggle used in the filter bar.
function filterChip(label: string, active: boolean, onToggle: () => void): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "orden-board__filter-chip";
  chip.classList.toggle("is-active", active);
  chip.setAttribute("aria-pressed", String(active));
  chip.textContent = label;
  chip.addEventListener("click", onToggle);
  return chip;
}

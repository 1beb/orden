import {
  LIFECYCLE_ORDER,
  isNeedsAction,
  isExpiredComplete,
  type CardState,
} from "@orden/outliner";
import { listItems, setItemState, setItemProject, cardSessionIds, type Item } from "./cards";
import { listProjects } from "./projects";
import { agentLauncher, markFor } from "./agentMarks";
import { getSession, setSessionProject, type Agent } from "./sessions";
import { openCardModal } from "./cardModal";
import { renderIssueGroups } from "./issueList";
import { loadSettings, saveSettings, type KanbanView } from "./settings";

const STATES: CardState[] = [...LIFECYCLE_ORDER];

// A one-shot timer that re-renders the board the moment the soonest completed
// card crosses its TTL and falls off the Complete column (the board otherwise
// only redraws on a mutation, so a card finished while the board sits open
// would linger). Module-scoped so it survives the full re-render each call performs.
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

// Capitalized column titles; the stored state stays lowercase. "Learnings" is a
// derived column (no card is stored in that state — see columnFor below).
const STATE_LABELS: Record<CardState, string> = {
  planning: "Planning",
  "in-progress": "In-progress",
  blocked: "Blocked",
  complete: "Complete",
  learnings: "Learnings",
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
  // Count of a card's still-pending learnings. Injected (rather than importing
  // learningsStore here) so this render module stays store-agnostic; main.ts
  // wires it to learningsStore.pendingForCard. Drives the derived Learnings
  // column: a complete card with >0 pending learnings buckets there.
  pendingLearnings: (cardId: string) => number;
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

  const nowMs = Date.now();
  // Configurable dwell time before a completed card falls off the board.
  const ttlMs = loadSettings().completeFadeHours * 60 * 60 * 1000;
  if (fadeTimer !== undefined) {
    clearTimeout(fadeTimer);
    fadeTimer = undefined;
  }

  container.replaceChildren();
  container.classList.add("orden-board");

  const view = loadSettings().kanbanView;

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
  // Segmented Board | List toggle, pinned to the header's right. The choice is
  // persisted so the tab reopens in the same layout.
  const toggle = document.createElement("div");
  toggle.className = "orden-board__view-toggle";
  toggle.setAttribute("role", "group");
  const mkView = (label: string, mode: KanbanView): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "orden-board__view-btn";
    b.classList.toggle("is-active", view === mode);
    b.setAttribute("aria-pressed", String(view === mode));
    b.textContent = label;
    b.addEventListener("click", () => {
      if (view === mode) return;
      void saveSettings({ kanbanView: mode });
      rerender();
    });
    return b;
  };
  toggle.append(mkView("Board", "board"), mkView("List", "list"));
  header.append(toggle);
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

  // Schedule a single re-render at the soonest moment a still-visible completed
  // card crosses its TTL and falls off, so an idle board drops it without
  // waiting for the next interaction. Each render reschedules for the next.
  const scheduleFade = (): void => {
    let soonestFade = Infinity;
    for (const i of items) {
      if (i.state !== "complete" || typeof i.completedAt !== "number") continue;
      const fadeAt = i.completedAt + ttlMs;
      if (fadeAt > nowMs && fadeAt < soonestFade) soonestFade = fadeAt;
    }
    if (soonestFade !== Infinity) {
      fadeTimer = setTimeout(rerender, soonestFade - nowMs + 50);
    }
  };

  if (view === "list") {
    // Same grouped issue list as the project page, but across all projects
    // (honoring the board's filters and lifecycle group order). Completed cards
    // age off after the configured dwell time, mirroring the Complete column.
    const visible = items.filter((i) => !isExpiredComplete(i, nowMs, ttlMs));
    const list = document.createElement("div");
    list.className = "issue-list orden-board__list";
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "project-widget-empty";
      empty.textContent = "No cards match the current filters.";
      list.append(empty);
    } else {
      renderIssueGroups(list, visible, {
        states: STATES,
        onMutate: rerender,
        onStartSession: deps.onStartSession,
        onOpenSession: deps.onOpenSession,
      });
    }
    container.append(list);
    scheduleFade();
    return needs;
  }

  // The column an item buckets into. Cards live in their stored `state`'s
  // column, EXCEPT a complete card with pending learnings, which is derived into
  // the rightmost "learnings" column instead (and falls back to "complete" once
  // it has none). No card is ever stored in state "learnings".
  const columnFor = (i: Item): CardState =>
    i.state === "complete" && deps.pendingLearnings(i.id) > 0 ? "learnings" : i.state;

  const columns = document.createElement("div");
  columns.className = "orden-board__columns";
  for (const state of STATES) {
    // Completed cards fall off the board after the configured dwell time, so
    // the Complete column shows only recently-finished work. The fade applies
    // only to the Complete column — a card diverted to Learnings stays put until
    // its pending learnings are resolved, so one can't silently age off.
    const colItems = items.filter((i) => {
      if (columnFor(i) !== state) return false;
      if (state === "complete" && isExpiredComplete(i, nowMs, ttlMs)) return false;
      return true;
    });
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
          // An explicit Resume button reopens the session's EXISTING conversation
          // (the host resumes via the agent's saved id) — including sessions that
          // were killed when the card was completed. Distinct from the new-session
          // launcher shown only when a card has no sessions yet. Opens the latest
          // session; the modal lists them all. stopPropagation so the click doesn't
          // also bubble to the card → modal.
          const latest = sessionIds[sessionIds.length - 1];
          const resume = document.createElement("button");
          resume.type = "button";
          resume.className = "orden-card__resume";
          const agent = getSession(latest)?.agent;
          if (agent) resume.innerHTML = markFor(agent); // author-controlled SVG
          const label = document.createElement("span");
          label.textContent = "Resume";
          resume.append(label);
          resume.title = sessionIds.length === 1 ? "Resume session" : "Resume latest session";
          resume.addEventListener("mousedown", (e) => e.stopPropagation());
          resume.addEventListener("click", (e) => {
            e.stopPropagation();
            deps.onOpenSession(latest);
          });
          footer.append(resume);
          if (sessionIds.length > 1) {
            const count = document.createElement("span");
            count.className = "orden-card__sesscount";
            count.textContent = `${sessionIds.length} sessions`;
            footer.append(count);
          }
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

  scheduleFade();
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

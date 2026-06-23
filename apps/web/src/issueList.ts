// The grouped issue-list view: items bucketed by state into furl-able groups,
// each row a leading session control + title, and (kanban list view only)
// inline state/project pickers. Shared by the project page's "Items by state"
// widget and the kanban board's list view so the two stay visually and
// behaviorally aligned (same markup, same classes); the project page opts out
// of the inline pickers via showMeta:false (state lives in the headers, the
// project is fixed, and both are editable on the card modal).

import { LANE_LABELS } from "./lifecycle";
import { setItemProject, cardSessionIds, type Item } from "./cards";
import { listProjects, getProject } from "./projects";
import { agentLauncher, markFor } from "./agentMarks";
import {
  sessionsForCard,
  setSessionProject,
  isSessionComplete,
  type Agent,
} from "./sessions";
import { openCardModal } from "./cardModal";

// A list group key: any lifecycle lane plus the web-local DERIVED group
// "learnings" (mirrors the kanban board's derived Learnings column — see
// kanban.ts). No card is ever stored in state "learnings"; a complete card with
// open learnings is bucketed there at render time when the caller opts in. Kept
// as `string` because the lifecycle lane set is open (a workflow may add lanes).
type GroupKey = string;

// Capitalized labels for group headers and the state picker, read from the
// lifecycle config (single source of truth) plus the derived "learnings" label.
export const STATE_LABELS: Record<string, string> = {
  ...LANE_LABELS,
  learnings: "Learnings",
};

export interface IssueGroupDeps {
  // Group order; only states with items get a group. Open string set (lanes are
  // extensible by a workflow); values come from the lifecycle config.
  states: readonly string[];
  // Re-render after a state/project change (or a card-modal mutation).
  onMutate: () => void;
  onStartSession?: (item: Item, agent: Agent) => void;
  onOpenSession?: (id: string) => void;
  // Open an associated document in the main panel (card modal Documents list).
  onOpenDoc?: (path: string, projectId: string) => void;
  // Show the per-row inline state + project pickers. Default true (the kanban
  // list view). The project page passes false: state is already conveyed by the
  // group headers and every row shares the page's project, so changing either
  // belongs on the card (the title opens the card modal, which owns both).
  showMeta?: boolean;
  // Optional derived "Learnings" group — mirrors the kanban board's Learnings
  // column. When provided, a COMPLETE card with >0 open learnings is pulled out
  // of its Complete group into a trailing "Learnings" group, and clicking such a
  // row opens the learnings review view (onOpen) instead of the card modal. The
  // project-page widget omits this (it has no learnings concept).
  learnings?: {
    openFor: (cardId: string) => number;
    onOpen: (cardId: string) => void;
  };
}

// A leading control for an item row. If the item has linked session(s), render
// one brand-mark button per session that opens it directly (the active-session
// affordance, folded onto the row). Otherwise render the Claude/opencode
// launcher to start a session on it.
function rowLeader(
  item: Item,
  onStartSession?: (item: Item, agent: Agent) => void,
  onOpenSession?: (id: string) => void,
): HTMLElement {
  const lead = document.createElement("span");
  lead.className = "issue-row-lead";
  const sessions = sessionsForCard(item);
  if (sessions.length > 0) {
    for (const s of sessions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "issue-sess-open";
      if (isSessionComplete(s)) b.classList.add("is-complete");
      b.innerHTML = markFor(s.agent); // static, author-controlled brand SVG
      b.title = `Open ${s.agent} session: ${s.title}`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenSession?.(s.id);
      });
      lead.append(b);
    }
  } else if (onStartSession) {
    lead.append(
      agentLauncher((agent) => onStartSession(item, agent), getProject(item.projectId)?.defaultAgent),
    );
  }
  return lead;
}

// Render the grouped issue list into `list` (which should carry .issue-list).
// Clears `list` first; the caller owns the empty state (the message differs by
// context) and any TTL/fade filtering of `items`.
export function renderIssueGroups(list: HTMLElement, items: Item[], deps: IssueGroupDeps): void {
  list.replaceChildren();
  // The group a card buckets into. Same rule as the board's columnFor: a
  // complete card with open learnings is diverted to the derived "learnings"
  // group (only when the caller opts in), otherwise it sits in its stored state.
  const lrn = deps.learnings;
  const bucketOf = (i: Item): GroupKey =>
    lrn && i.state === "complete" && lrn.openFor(i.id) > 0 ? "learnings" : i.state;
  // Render the lifecycle groups in order, then the derived Learnings group last.
  const order: GroupKey[] = lrn ? [...deps.states, "learnings"] : [...deps.states];
  for (const key of order) {
    const group = items.filter((i) => bucketOf(i) === key);
    if (group.length === 0) continue;
    const isLearnings = key === "learnings";
    const details = document.createElement("details");
    details.className = "issue-group";
    // Completed cards can pile up; show the group but keep it furled until the
    // user opens it. Every other group (including Learnings, which needs the
    // user's attention) defaults open.
    details.open = key !== "complete";
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="issue-group-state" data-state="${key}">${STATE_LABELS[key]}</span> <span class="issue-group-count">${group.length}</span>`;
    details.append(summary);
    for (const item of group) {
      const row = document.createElement("div");
      row.className = "issue-row";
      // Leading control: open the linked session(s) directly, or — if none —
      // launch one. This is what folds Active sessions into the row.
      const lead = rowLeader(item, deps.onStartSession, deps.onOpenSession);
      // Click the title to open the card's detail modal (the same modal the
      // kanban board opens). A row in the derived Learnings group instead opens
      // the learnings review view for that card, matching the board column.
      const title = document.createElement("button");
      title.type = "button";
      title.className = "issue-title";
      title.textContent = item.title;
      title.addEventListener("click", () => {
        if (isLearnings) {
          lrn!.onOpen(item.id);
          return;
        }
        openCardModal(item.id, {
          onStartSession: (it, agent) => deps.onStartSession?.(it, agent),
          onOpenSession: (id) => deps.onOpenSession?.(id),
          onOpenDoc: (path, projectId) => deps.onOpenDoc?.(path, projectId),
          onChange: deps.onMutate,
        });
      });
      row.append(lead, title);
      // Inline project picker — kanban list view only. The state is conveyed by
      // the group headers (no status dropdown needed); the project page
      // (showMeta === false) drops the picker too, since its rows share one
      // project and reassignment lives on the card modal.
      if (deps.showMeta !== false) {
        // Move the card to another project (it then leaves this list).
        const projSel = document.createElement("select");
        projSel.className = "issue-project";
        projSel.title = "Project";
        for (const p of listProjects()) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name;
          opt.selected = p.id === item.projectId;
          projSel.append(opt);
        }
        projSel.addEventListener("change", () => {
          setItemProject(item.id, projSel.value);
          // Move the linked sessions too, so they follow the card instead of
          // stranding under its old project.
          for (const sid of cardSessionIds(item)) setSessionProject(sid, projSel.value);
          deps.onMutate();
        });
        // Status + project pickers ride in their own cluster so they sit at the
        // row's right on desktop but drop onto a line under the title on mobile.
        const meta = document.createElement("div");
        meta.className = "issue-row-meta";
        meta.append(projSel);
        row.append(meta);
      }
      details.append(row);
    }
    list.append(details);
  }
}

// The card detail modal: opens when a kanban card is clicked. Shows the card's
// state/project/due-date and its linked AI sessions, with create/remove and an
// editable per-session summary. A card may have zero sessions (cards are
// first-class and outlive their sessions).
import { LIFECYCLE_ORDER, type CardState } from "@orden/outliner";
import {
  getItem,
  setItemState,
  setItemTitle,
  setItemProject,
  setItemDueDate,
  removeItem,
  type Item,
} from "./cards";
import { listProjects } from "./projects";
import { confirmDialog } from "./modal";
import { agentLauncher, markFor } from "./agentMarks";
import {
  sessionsForCard,
  deleteSession,
  ensureSummary,
  setSessionSummary,
  setSessionProject,
  type Agent,
} from "./sessions";

const STATE_LABELS: Record<CardState, string> = {
  planning: "Planning",
  "in-progress": "In-progress",
  blocked: "Blocked",
  complete: "Complete",
  // Label only — "learnings" is a derived board column, never a selectable card
  // state; it's filtered out of the state dropdown below.
  learnings: "Learnings",
};

export interface CardModalDeps {
  // Start a new agent session linked to this card (creates + opens it).
  onStartSession: (item: Item, agent: Agent) => void;
  // Open an existing session in the sessions panel.
  onOpenSession: (sessionId: string) => void;
  // Re-render the board after any mutation.
  onChange: () => void;
}

export function openCardModal(itemId: string, deps: CardModalDeps): void {
  const overlay = document.createElement("div");
  overlay.className = "preview-overlay card-modal-overlay";

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    deps.onChange();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  const modal = document.createElement("div");
  modal.className = "preview-modal card-modal";
  overlay.append(modal);

  const render = (): void => {
    const item = getItem(itemId);
    if (!item) {
      close();
      return;
    }
    modal.replaceChildren();

    // Header: editable title + close. The title is an input so an untitled card
    // (one whose session never self-titled) can be named here.
    const header = document.createElement("header");
    header.className = "card-modal__header";
    const h = document.createElement("input");
    h.className = "card-modal__title";
    h.value = item.title;
    h.placeholder = "Card title…";
    h.setAttribute("aria-label", "Card title");
    const commitTitle = (): void => {
      if (h.value.trim() && h.value.trim() !== item.title) {
        setItemTitle(item.id, h.value);
        deps.onChange();
        render(); // refresh the modal's captured item (e.g. so delete-confirm is current)
      } else {
        h.value = item.title; // restore on empty/no-op so the field never blanks
      }
    };
    h.addEventListener("change", commitTitle);
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter") h.blur();
    });
    const x = document.createElement("button");
    x.className = "card-modal__close";
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.textContent = "✕";
    x.addEventListener("click", close);
    header.append(h, x);
    modal.append(header);

    const bodyEl = document.createElement("div");
    bodyEl.className = "card-modal__body";

    // Meta row: state, project, due date.
    const meta = document.createElement("div");
    meta.className = "card-modal__meta";

    const stateSel = labelled("State", document.createElement("select"));
    const stateInput = stateSel.field as HTMLSelectElement;
    // "learnings" is a derived column, not a real state — keep it out of the
    // selectable options so a user can't set a card to it.
    for (const s of LIFECYCLE_ORDER) {
      if (s === "learnings") continue;
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = STATE_LABELS[s];
      opt.selected = s === item.state;
      stateInput.append(opt);
    }
    stateInput.addEventListener("change", () => {
      setItemState(item.id, stateInput.value as CardState);
      deps.onChange();
      render();
    });

    const projSel = labelled("Project", document.createElement("select"));
    const projInput = projSel.field as HTMLSelectElement;
    for (const p of listProjects()) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      opt.selected = p.id === item.projectId;
      projInput.append(opt);
    }
    projInput.addEventListener("change", () => {
      setItemProject(item.id, projInput.value);
      for (const s of sessionsForCard(item)) setSessionProject(s.id, projInput.value);
      deps.onChange();
      render();
    });

    const dueSel = labelled("Due", document.createElement("input"));
    const dueInput = dueSel.field as HTMLInputElement;
    dueInput.type = "date";
    dueInput.value = item.dueDate ?? "";
    dueInput.addEventListener("change", () => {
      setItemDueDate(item.id, dueInput.value || undefined);
      deps.onChange();
    });

    meta.append(stateSel.wrap, projSel.wrap, dueSel.wrap);
    bodyEl.append(meta);

    // Sessions.
    const sessHead = document.createElement("div");
    sessHead.className = "card-modal__section-head";
    sessHead.textContent = "Sessions";
    bodyEl.append(sessHead);

    const sessions = sessionsForCard(item);
    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "card-modal__empty";
      empty.textContent = "No sessions yet.";
      bodyEl.append(empty);
    }
    for (const s of sessions) {
      ensureSummary(s, item.state); // fill a digest if complete / aged
      const row = document.createElement("div");
      row.className = "card-modal__sess";

      const top = document.createElement("div");
      top.className = "card-modal__sess-top";
      const mark = document.createElement("span");
      mark.className = "card-modal__sess-mark";
      mark.innerHTML = markFor(s.agent); // static, author-controlled brand SVG
      mark.title = s.agent;
      const title = document.createElement("span");
      title.className = "card-modal__sess-title";
      title.textContent = s.title;
      // Resume reopens the EXISTING conversation (host resumes via the agent's
      // saved id) — distinct from the "New session" launcher below, which spawns
      // a fresh agent. Killed-on-complete sessions are resumed, not recreated.
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "card-modal__sess-resume";
      resume.title = "Resume session";
      resume.textContent = "Resume";
      resume.addEventListener("click", () => {
        close();
        deps.onOpenSession(s.id);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "card-modal__sess-remove";
      remove.title = "Remove session";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        deleteSession(s.id);
        deps.onChange();
        render();
      });
      top.append(mark, title, resume, remove);
      row.append(top);

      // Summary: shown once a session is complete / aged. Editable.
      if (s.summary !== undefined) {
        const summary = document.createElement("textarea");
        summary.className = "card-modal__sess-summary";
        summary.rows = 4;
        summary.placeholder = "Summary…";
        summary.value = s.summary;
        summary.addEventListener("change", () => setSessionSummary(s.id, summary.value));
        row.append(summary);
      }
      bodyEl.append(row);
    }

    // Add a session (claude / opencode), linked to this card.
    const add = document.createElement("div");
    add.className = "card-modal__sess-new";
    const addLabel = document.createElement("span");
    addLabel.className = "card-modal__sess-new-label";
    addLabel.textContent = "New session";
    add.append(
      addLabel,
      agentLauncher((agent) => {
        close();
        deps.onStartSession(item, agent);
      }),
    );
    bodyEl.append(add);

    // Footer: delete the whole card (and its sessions). Cards outlive their
    // sessions, so this is the only path to remove a session-less card.
    const footer = document.createElement("div");
    footer.className = "card-modal__footer";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "card-modal__delete";
    del.textContent = "Delete card";
    del.addEventListener("click", () => {
      const n = sessionsForCard(item).length;
      void confirmDialog({
        title: "Delete card",
        message: `Delete "${item.title}"${n ? ` and its ${n} session(s)` : ""}? This cannot be undone.`,
        confirmLabel: "Delete card",
      }).then((ok) => {
        if (!ok) return;
        for (const s of sessionsForCard(item)) deleteSession(s.id);
        removeItem(item.id);
        close();
      });
    });
    footer.append(del);
    bodyEl.append(footer);

    modal.append(bodyEl);
  };

  render();
  document.body.append(overlay);
}

// A labelled form field: a small caption above the control.
function labelled(text: string, field: HTMLElement): { wrap: HTMLElement; field: HTMLElement } {
  const wrap = document.createElement("label");
  wrap.className = "card-modal__field";
  const cap = document.createElement("span");
  cap.className = "card-modal__field-label";
  cap.textContent = text;
  field.classList.add("card-modal__field-input");
  wrap.append(cap, field);
  return { wrap, field };
}

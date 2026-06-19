// The card detail modal: opens when a kanban card is clicked. Shows the card's
// state/project/due-date and its linked AI sessions, with create/remove and an
// editable per-session summary. A card may have zero sessions (cards are
// first-class and outlive their sessions).
import type { SessionState } from "@orden/host-api";
import { LANE_ORDER, LANE_LABELS } from "./lifecycle";
import {
  getItem,
  setItemState,
  setItemTitle,
  setItemProject,
  setItemDueDate,
  setItemDescription,
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

    // Description: free text handed to the agent with the title when a session
    // starts on this card. Mirrors the new-card modal's layout (description
    // above, meta below).
    const descHead = document.createElement("div");
    descHead.className = "card-modal__section-head";
    descHead.textContent = "Description";
    const desc = document.createElement("textarea");
    desc.className = "card-modal__desc";
    desc.placeholder = "Description…";
    desc.value = item.description ?? "";
    desc.addEventListener("change", () => {
      setItemDescription(item.id, desc.value);
      deps.onChange();
    });
    bodyEl.append(descHead, desc);

    // Meta row: state, project, due date.
    const meta = document.createElement("div");
    meta.className = "card-modal__meta card-modal__meta--bottom";

    const stateSel = labelled("State", document.createElement("select"));
    const stateInput = stateSel.field as HTMLSelectElement;
    for (const s of LANE_ORDER) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = LANE_LABELS[s] ?? s;
      opt.selected = s === item.state;
      stateInput.append(opt);
    }
    stateInput.addEventListener("change", () => {
      setItemState(item.id, stateInput.value as SessionState);
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

    // Integration: how the session branch left the system at completion
    // (stamped by the host's publish step). Read-only; absent until published.
    const integration = integrationRow(item);
    if (integration) bodyEl.append(integration);

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

// The integration row: the card's branch and where it went (PR / pushed /
// not published). Null when the card carries no publish stamp.
function integrationRow(item: Item): HTMLElement | null {
  if (!item.publishState) return null;
  const wrap = document.createElement("div");
  wrap.className = "card-modal__integration";
  const cap = document.createElement("span");
  cap.className = "card-modal__field-label";
  cap.textContent = "Integration";
  wrap.append(cap, " ");
  const branch = document.createElement("code");
  branch.textContent = item.branch ?? "";
  if (item.branch) wrap.append(branch, " — ");
  const link = (href: string, label: string): HTMLAnchorElement => {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    return a;
  };
  switch (item.publishState) {
    case "pr-opened":
      wrap.append(item.prUrl ? link(item.prUrl, "Pull request") : "PR opened");
      break;
    case "pushed":
      wrap.append("pushed");
      if (item.compareUrl) wrap.append(" · ", link(item.compareUrl, "compare"));
      break;
    case "dirty":
      wrap.append("not published — uncommitted work in the session worktree");
      break;
    case "no-remote":
      wrap.append("local branch only (no remote to push to)");
      break;
    case "push-failed":
      wrap.append(`push failed${item.publishError ? `: ${item.publishError}` : ""}`);
      break;
    default:
      wrap.append(item.publishState);
  }
  return wrap;
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

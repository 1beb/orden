// The new-card modal: pops from the project-page add bar when a typed thought
// crosses its first sentence (see thoughtSplit.ts). Pre-filled with the split —
// first sentence as the title, the rest as the description, cursor continuing
// in the description — so the split is visible and correctable before the card
// exists. Reuses the card-detail modal's dress (.preview-modal.card-modal).
//
// Dismissal is lossless: Escape / backdrop / ✕ hand the joined text back to the
// caller (onDismiss) to restore into the add input. Cancel discards. Add creates
// the card; an agent mark creates it AND starts a session on it.
import type { SessionState } from "@orden/host-api";
import { LANE_ORDER, LANE_LABELS } from "./lifecycle";
import { addItem, setItemState, setItemDueDate, type Item } from "./cards";
import { listProjects, getProject } from "./projects";
import { agentLauncher } from "./agentMarks";
import type { Agent } from "./sessions";

export interface NewCardSeed {
  projectId: string;
  title: string;
  description: string;
}

export interface NewCardModalDeps {
  // Start an agent session on the just-created card.
  onStartSession: (item: Item, agent: Agent) => void;
  // Re-render lists after a card is created.
  onChange: () => void;
  // Dismissed without creating (Escape/backdrop/✕): restore this text to the bar.
  onDismiss?: (restoredText: string) => void;
  // The add-bar row the thought was typed into. When present (and measurable),
  // the form grows in-situ out of it instead of opening as a centered modal.
  anchor?: HTMLElement;
}

export function openNewCardModal(seed: NewCardSeed, deps: NewCardModalDeps): void {
  const overlay = document.createElement("div");
  overlay.className = "preview-overlay card-modal-overlay";

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  // Esc/backdrop/✕ give the (possibly edited) text back so nothing is lost.
  const dismiss = (): void => {
    const t = title.value.trim();
    const d = desc.value.trim();
    close();
    deps.onDismiss?.(d ? `${t}. ${d}` : t);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dismiss();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener("keydown", onKey);

  const modal = document.createElement("div");
  modal.className = "preview-modal card-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  overlay.append(modal);

  // Header: the split-off title, editable like the detail modal's.
  const header = document.createElement("header");
  header.className = "card-modal__header";
  const title = document.createElement("input");
  title.className = "card-modal__title";
  title.value = seed.title;
  title.placeholder = "Card title…";
  title.setAttribute("aria-label", "Card title");
  const x = document.createElement("button");
  x.className = "card-modal__close";
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.textContent = "✕";
  x.addEventListener("click", dismiss);
  header.append(title, x);
  modal.append(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "card-modal__body";

  // Description first; the meta row sits at the bottom.
  const descHead = document.createElement("div");
  descHead.className = "card-modal__section-head";
  descHead.textContent = "Description";
  const desc = document.createElement("textarea");
  desc.className = "card-modal__desc";
  desc.placeholder = "Description…";
  desc.value = seed.description;
  const hint = document.createElement("p");
  hint.className = "card-modal__hint";
  hint.textContent = "Sent to the agent with the title when a session starts on this card.";
  bodyEl.append(descHead, desc, hint);

  const meta = document.createElement("div");
  meta.className = "card-modal__meta card-modal__meta--bottom";

  const stateSel = labelled("State", document.createElement("select"));
  const stateInput = stateSel.field as HTMLSelectElement;
  for (const s of LANE_ORDER) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = LANE_LABELS[s] ?? s;
    opt.selected = s === "planning";
    stateInput.append(opt);
  }

  const projSel = labelled("Project", document.createElement("select"));
  const projInput = projSel.field as HTMLSelectElement;
  for (const p of listProjects()) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    opt.selected = p.id === seed.projectId;
    projInput.append(opt);
  }

  const dueSel = labelled("Due", document.createElement("input"));
  const dueInput = dueSel.field as HTMLInputElement;
  dueInput.type = "date";

  meta.append(stateSel.wrap, projSel.wrap, dueSel.wrap);
  bodyEl.append(meta);
  modal.append(bodyEl);

  // Create the card from the current field values. Returns null when the title
  // emptied out (nothing sensible to create).
  const create = (): Item | null => {
    const t = title.value.trim();
    if (!t) {
      title.focus();
      return null;
    }
    const projectId = projInput.value || seed.projectId;
    const item = addItem(projectId, t, { description: desc.value });
    const state = stateInput.value as SessionState;
    if (state !== "planning") setItemState(item.id, state);
    if (dueInput.value) setItemDueDate(item.id, dueInput.value);
    close();
    deps.onChange();
    return item;
  };

  const actions = document.createElement("div");
  actions.className = "dialog__actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dialog__btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "dialog__btn dialog__btn--primary";
  add.textContent = "Add";
  add.addEventListener("click", () => void create());
  actions.append(cancel, add);
  actions.append(
    agentLauncher((agent) => {
      const item = create();
      if (item) deps.onStartSession(item, agent);
    }, getProject(seed.projectId)?.defaultAgent),
  );
  modal.append(actions);

  document.body.append(overlay);
  if (deps.anchor) anchorInSitu(overlay, modal, deps.anchor, desc, header);

  // Continue typing where the thought left off: cursor at the end of the
  // description.
  desc.focus();
  desc.setSelectionRange(desc.value.length, desc.value.length);
}

// In-situ growth: the description textarea lands EXACTLY on the add input —
// same box, the typed text stays put — and the rest of the form grows around
// it: the panel is rendered at full size but clipped to the input's box, then
// the clip expands outward while the title row rises out of the input into
// the header. An in-place expansion that overlays the content below, like a
// modal but not centered. Falls back to the centered modal when the anchor
// can't be measured (e.g. headless tests).
function anchorInSitu(
  overlay: HTMLElement,
  modal: HTMLElement,
  anchor: HTMLElement,
  desc: HTMLElement,
  header: HTMLElement,
): void {
  const r = anchor.getBoundingClientRect();
  if (!r.width || !r.height) return;
  overlay.classList.add("card-modal-overlay--insitu");
  modal.classList.add("card-modal--insitu");
  // Make the description exactly as wide as the input (the chrome around it —
  // body padding, borders — is width-independent), then shift the panel so the
  // description's box sits on the input's.
  const chrome = modal.offsetWidth - desc.offsetWidth;
  modal.style.width = `${r.width + chrome}px`;
  const top = r.top - desc.offsetTop;
  modal.style.left = `${r.left - desc.offsetLeft}px`;
  modal.style.top = `${top}px`;
  // Natural height, capped to the viewport (the body scrolls past the cap).
  modal.style.maxHeight = `${window.innerHeight - top - 24}px`;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    modal.classList.add("is-grown");
    return;
  }
  // Start clipped to the input's box; grow the visible window around it.
  const clipTop = desc.offsetTop;
  const clipLeft = desc.offsetLeft;
  const clipRight = Math.max(modal.offsetWidth - (clipLeft + desc.offsetWidth), 0);
  const clipBottom = Math.max(modal.offsetHeight - (clipTop + r.height), 0);
  modal.style.clipPath = `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px round 8px)`;
  // The title rises from the input's position up into the header.
  header.style.transform = `translateY(${clipTop - header.offsetTop}px)`;
  requestAnimationFrame(() => {
    modal.classList.add("is-grown");
    modal.style.clipPath = "inset(0 0 0 0 round 12px)";
    header.style.transform = "translateY(0)";
  });
  modal.addEventListener("transitionend", (e) => {
    if (e.target === modal && e.propertyName === "clip-path") modal.style.clipPath = "none";
  });
}

// A labelled form field: a small caption above the control (as in cardModal).
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

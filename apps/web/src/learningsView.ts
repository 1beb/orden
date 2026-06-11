// Learnings review stepper — the main-panel surface that walks the user through a
// completing card's proposed README/ADR/AGENTS.md/skill changes one at a time. Each
// step shows the proposed file change as a plain diff, a "why this" recap, and an
// accept / reject / comment action bar. Accept/reject flip status away from "pending"
// so the cursor auto-advances; a comment sends the learning to the agent to revise
// and flips it pending→revising — which also drops it out of the pending cursor, so
// the stepper advances to the next pending learning while the agent re-iterates. The
// revised proposal flips revising→pending and resurfaces. Input is cleared on send.
// Ported from docs/mockups/learnings-review.html onto orden's real tokens.
//
// Progress is over the card's FULL learning list (all statuses), not the pending
// queue: the dot strip is a fixed N = total learnings, partitioned into done /
// current / remaining, and the counter denominator never shrinks. The cursor is the
// FIRST still-pending learning, derived purely from status — so an action that flips
// a status (and triggers a re-render) auto-advances the cursor with no module state.
import type { Learning, LearningType } from "@orden/host-api";
import { learningsForCard } from "./learningsStore";

export interface LearningsDeps {
  cardId: string | null;
  onReject(id: string): void;
  onAccept(id: string): void;
  onComment(id: string, text: string): void;
}

const TYPE_LABEL: Record<LearningType, string> = {
  readme: "README",
  adr: "ADR",
  agents: "AGENTS.md",
  skill: "skill",
};

export interface DiffRow {
  gutter: "+" | "-" | " ";
  text: string;
}

const CONTEXT = 3;

// A small, readable line diff — NOT a full Myers diff. For a create (no base),
// every proposed line is an addition. For an edit, find the first and last
// differing region, then show only that region surrounded by a small context
// window (3 lines above/below) with an omission marker (...) when lines are
// skipped. Plain ink text; the gutter alone signals add/remove (no color).
export function diffLines(base: string | undefined, proposed: string): DiffRow[] {
  const add = (text: string): DiffRow => ({ gutter: "+", text });
  if (base === undefined) {
    return proposed.split("\n").map(add);
  }
  const baseL = base.split("\n");
  const propL = proposed.split("\n");

  let start = 0;
  while (start < baseL.length && start < propL.length && baseL[start] === propL[start]) start++;

  let endB = baseL.length;
  let endP = propL.length;
  while (endB > start && endP > start && baseL[endB - 1] === propL[endP - 1]) {
    endB--;
    endP--;
  }

  const rows: DiffRow[] = [];
  const ctxStart = Math.max(0, start - CONTEXT);
  const ctxEndB = Math.min(baseL.length, endB + CONTEXT);
  const ctxEndP = Math.min(propL.length, endP + CONTEXT);

  if (ctxStart > 0) rows.push({ gutter: " ", text: "..." });
  for (let i = ctxStart; i < start; i++) rows.push({ gutter: " ", text: baseL[i] });
  for (let i = start; i < endB; i++) rows.push({ gutter: "-", text: baseL[i] });
  for (let i = start; i < endP; i++) rows.push({ gutter: "+", text: propL[i] });
  for (let i = endB; i < ctxEndB; i++) rows.push({ gutter: " ", text: baseL[i] });
  if (ctxEndB < baseL.length) rows.push({ gutter: " ", text: "..." });
  return rows;
}

function kindLine(l: Learning): string {
  const verb = l.op === "create" ? "New file" : "Update";
  return `${verb} · ${TYPE_LABEL[l.type]}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderEmpty(container: HTMLElement, hasCard: boolean): void {
  container.replaceChildren();
  const wrap = el("div", "lr lr-empty");
  const inner = el("div", "lr-empty-inner");
  inner.append(
    el("div", "lr-empty-title", hasCard ? "All learnings reviewed" : "No learnings to review"),
    el(
      "div",
      "lr-empty-note",
      hasCard
        ? "Nothing left to accept, reject, or comment on for this card."
        : "Open a completed card with proposed learnings to review them here.",
    ),
  );
  wrap.append(inner);
  container.append(wrap);
}

// Nothing pending, but N learnings are mid-revision (the user commented and the
// agent is re-iterating before re-proposing). Reads as in-progress, not done —
// the agent's revision will flip one back to pending and resurface the stepper.
function renderWaiting(container: HTMLElement, revisingCount: number): void {
  container.replaceChildren();
  const wrap = el("div", "lr lr-waiting");
  const inner = el("div", "lr-empty-inner");
  const noun = revisingCount === 1 ? "learning" : "learnings";
  inner.append(
    el("div", "lr-empty-title", `Waiting for the agent to revise ${revisingCount} ${noun}…`),
    el(
      "div",
      "lr-empty-note",
      "Your comment was sent. The revised proposal will resurface here for re-review.",
    ),
  );
  wrap.append(inner);
  container.append(wrap);
}

export function renderLearnings(container: HTMLElement, deps: LearningsDeps): void {
  if (!deps.cardId) {
    renderEmpty(container, false);
    return;
  }

  // Full ordered list (all statuses, createdAt-asc) drives a FIXED-width progress
  // strip and a non-shrinking denominator.
  const all = learningsForCard(deps.cardId);
  const total = all.length;
  // The cursor is the first still-pending learning. `revising` is skipped, so a
  // comment (which flips pending→revising) auto-advances the cursor to the next
  // pending learning.
  const currentIndex = all.findIndex((l) => l.status === "pending");
  if (currentIndex === -1) {
    // Nothing pending. If any learning is mid-revision, show the in-progress
    // waiting state (the agent's re-proposal will flip it back to pending and
    // resurface the stepper); otherwise every learning is resolved → reviewed.
    const revisingCount = all.filter((l) => l.status === "revising").length;
    if (revisingCount > 0) renderWaiting(container, revisingCount);
    else renderEmpty(container, true);
    return;
  }
  const learning = all[currentIndex];

  container.replaceChildren();
  const lr = el("div", "lr");

  // Head: eyebrow (name + count), progress dots, title, kind line.
  const head = el("div", "lr-head");
  const headInner = el("div", "lr-head-inner");
  const eyebrow = el("div", "lr-eyebrow");
  eyebrow.append(el("span", "name", "Learnings"), el("span", "lr-count", `${currentIndex + 1} / ${total}`));
  const dots = el("div", "dots");
  dots.setAttribute("role", "progressbar");
  dots.setAttribute("aria-valuenow", String(currentIndex + 1));
  dots.setAttribute("aria-valuemin", "1");
  dots.setAttribute("aria-valuemax", String(total));
  dots.setAttribute("aria-label", `Learning ${currentIndex + 1} of ${total}`);
  // One dot per learning, by status: accepted/rejected → done (dimmed, resolved);
  // revising → revising (in-flight, the user commented and the agent is re-iterating);
  // the cursor (first pending) → cur (solid); any other pending ahead → remaining
  // (base). Drive off status so the four states read distinctly even when interleaved.
  for (let i = 0; i < total; i++) {
    const dot = el("span", "dot");
    const status = all[i].status;
    if (status === "accepted" || status === "rejected") dot.classList.add("done");
    else if (status === "revising") dot.classList.add("revising");
    else if (i === currentIndex) dot.classList.add("cur");
    dots.append(dot);
  }
  headInner.append(eyebrow, dots, el("h1", "lr-title", learning.title), el("div", "lr-kind", kindLine(learning)));
  head.append(headInner);

  // Body: change label, file path, recap (why), diff.
  const body = el("div", "lr-body");
  const inner = el("div", "lr-inner");
  inner.append(
    el("p", "change-label", learning.op === "create" ? "Proposed new file" : "Proposed change"),
    el("div", "filepath", learning.targetPath),
  );

  const recap = el("div", "recap");
  recap.append(el("div", "recap-head", "Why this"));
  const recapBody = el("div", "recap-body");
  recapBody.append(el("p", undefined, learning.recap));
  recap.append(recapBody);
  inner.append(recap);

  const diff = el("div", "diff");
  for (const row of diffLines(learning.baseContent, learning.proposedContent)) {
    const r = el("div", "row");
    r.append(el("span", "gutter", row.gutter));
    r.append(document.createTextNode(row.text));
    diff.append(r);
  }
  inner.append(diff);

  body.append(inner);

  // Action bar: verdict row (reject / accept) then comment row (input + send).
  const actions = el("div", "lr-actions");
  const verdict = el("div", "verdict");
  const reject = el("button", "btn reject");
  reject.setAttribute("aria-label", "Reject");
  const rejectIc = el("span", "ic", "✕");
  rejectIc.setAttribute("aria-hidden", "true");
  reject.append(rejectIc, document.createTextNode("Reject"));
  reject.addEventListener("click", () => deps.onReject(learning.id));
  const accept = el("button", "btn accept");
  accept.setAttribute("aria-label", "Accept");
  const acceptIc = el("span", "ic", "✓");
  acceptIc.setAttribute("aria-hidden", "true");
  accept.append(acceptIc, document.createTextNode("Accept"));
  accept.addEventListener("click", () => deps.onAccept(learning.id));
  verdict.append(reject, accept);

  const commentRow = el("div", "comment-row");
  const input = el("input");
  input.type = "text";
  input.placeholder = "Comment…";
  input.setAttribute("aria-label", "Comment");
  const send = el("button", "send", "Send");
  send.setAttribute("aria-label", "Send comment");
  const submitComment = () => {
    const text = input.value.trim();
    if (!text) return; // no-op on empty/whitespace
    deps.onComment(learning.id, text);
    // Clear immediately so the field is empty even if no re-render lands. The
    // re-render rebuilds the input empty anyway (the cursor advances past this
    // now-revising learning); this just makes the cleared state independent of it.
    input.value = "";
  };
  send.addEventListener("click", submitComment);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitComment();
    }
  });
  commentRow.append(input, send);

  actions.append(verdict, commentRow);

  lr.append(head, body, actions);
  container.append(lr);
}

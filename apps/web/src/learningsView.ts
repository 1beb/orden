// Learnings review stepper — the main-panel surface that walks the user through a
// completing card's proposed README/ADR/AGENTS.md/skill changes one at a time. Each
// step shows the proposed file change as a plain diff, a "why this" recap, and an
// accept / reject / comment action bar. Any action auto-advances to the next pending
// learning. Ported from docs/mockups/learnings-review.html onto orden's real tokens.
import type { Learning, LearningType } from "@orden/host-api";
import { learningsForCard } from "./learningsStore";

export interface LearningsDeps {
  cardId: string | null;
  onReject(id: string): void;
  onAccept(id: string): void;
  onComment(id: string, text: string): void;
}

// The current step index within the active card's pending queue. Module-scoped so
// it survives the re-render each action triggers. Reset when the active card
// changes (so a fresh card starts at step 0).
let stepIndex = 0;
let stepCardId: string | null = null;

/** Test/seam hook: clear step state between cases. */
export function resetLearningsStep(): void {
  stepIndex = 0;
  stepCardId = null;
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

// A small, readable line diff — NOT a full Myers diff. For a create (no base),
// every proposed line is an addition. For an edit, trim a common prefix/suffix of
// identical lines, then show the remaining base lines as removals (-) followed by
// the remaining proposed lines as additions (+). Plain ink text; the gutter alone
// signals add/remove (no color).
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
  for (let i = 0; i < start; i++) rows.push({ gutter: " ", text: baseL[i] });
  for (let i = start; i < endB; i++) rows.push({ gutter: "-", text: baseL[i] });
  for (let i = start; i < endP; i++) rows.push({ gutter: "+", text: propL[i] });
  for (let i = endB; i < baseL.length; i++) rows.push({ gutter: " ", text: baseL[i] });
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

export function renderLearnings(container: HTMLElement, deps: LearningsDeps): void {
  // Reset the step cursor whenever the active card changes.
  if (deps.cardId !== stepCardId) {
    stepCardId = deps.cardId;
    stepIndex = 0;
  }

  if (!deps.cardId) {
    renderEmpty(container, false);
    return;
  }

  const queue = learningsForCard(deps.cardId).filter((l) => l.status === "pending");
  if (queue.length === 0) {
    renderEmpty(container, true);
    return;
  }

  // Clamp the index — an accepted/rejected item drops out of the queue, so the
  // same index now points at the next pending learning (auto-advance).
  if (stepIndex >= queue.length) stepIndex = queue.length - 1;
  if (stepIndex < 0) stepIndex = 0;
  const learning = queue[stepIndex];
  const total = queue.length;

  container.replaceChildren();
  const lr = el("div", "lr");

  // Head: eyebrow (name + count), progress dots, title, kind line.
  const head = el("div", "lr-head");
  const headInner = el("div", "lr-head-inner");
  const eyebrow = el("div", "lr-eyebrow");
  eyebrow.append(el("span", "name", "Learnings"), el("span", "lr-count", `${stepIndex + 1} / ${total}`));
  const dots = el("div", "dots");
  for (let i = 0; i < total; i++) {
    const dot = el("span", "dot");
    if (i < stepIndex) dot.classList.add("done");
    else if (i === stepIndex) dot.classList.add("cur");
    dots.append(dot);
  }
  headInner.append(eyebrow, dots, el("h1", "lr-title", learning.title), el("div", "lr-kind", kindLine(learning)));
  head.append(headInner);

  // Body: change label, file path, diff, recap.
  const body = el("div", "lr-body");
  const inner = el("div", "lr-inner");
  inner.append(
    el("p", "change-label", learning.op === "create" ? "Proposed new file" : "Proposed change"),
    el("div", "filepath", learning.targetPath),
  );

  const diff = el("div", "diff");
  for (const row of diffLines(learning.baseContent, learning.proposedContent)) {
    const r = el("div", "row");
    r.append(el("span", "gutter", row.gutter === " " ? " " : row.gutter));
    r.append(document.createTextNode(row.text));
    diff.append(r);
  }
  inner.append(diff);

  const recap = el("div", "recap");
  recap.append(el("div", "recap-head", "Why this"));
  const recapBody = el("div", "recap-body");
  recapBody.append(el("p", undefined, learning.recap));
  recap.append(recapBody);
  inner.append(recap);

  body.append(inner);

  // Action bar: verdict row (reject / accept) then comment row (input + send).
  const actions = el("div", "lr-actions");
  const verdict = el("div", "verdict");
  const reject = el("button", "btn reject");
  reject.append(el("span", "ic", "✕"), document.createTextNode("Reject"));
  reject.addEventListener("click", () => deps.onReject(learning.id));
  const accept = el("button", "btn accept");
  accept.append(el("span", "ic", "✓"), document.createTextNode("Accept"));
  accept.addEventListener("click", () => deps.onAccept(learning.id));
  verdict.append(reject, accept);

  const commentRow = el("div", "comment-row");
  const input = el("input");
  input.type = "text";
  input.placeholder = "Comment…";
  const send = el("button", "send", "Send");
  const submitComment = () => {
    const text = input.value.trim();
    if (text) deps.onComment(learning.id, text);
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

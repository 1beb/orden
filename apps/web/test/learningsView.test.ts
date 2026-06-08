import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Learning } from "@orden/host-api";
import { BrowserHost } from "../src/host/browserHost";
import { addLearningComment, getLearning, hydrateLearnings, setLearningStatus } from "../src/learningsStore";
import { renderLearnings, diffLines } from "../src/learningsView";
import { learningsCommentFocused } from "../src/learningsFocus";

function mk(over: Partial<Learning> & Pick<Learning, "id" | "cardId">): Learning {
  return {
    projectId: "p1",
    type: "agents",
    title: over.id,
    recap: "recap text",
    targetPath: "AGENTS.md",
    op: "edit",
    proposedContent: "content",
    status: "pending",
    createdAt: 1,
    ...over,
  };
}

async function seed(host: BrowserHost, items: Learning[]): Promise<void> {
  for (const it of items) await host.vault.set("learnings", it.id, it);
}

function noopDeps(cardId: string | null) {
  return {
    cardId,
    onReject: vi.fn(),
    onAccept: vi.fn(),
    onComment: vi.fn(),
  };
}

describe("diffLines helper", () => {
  it("create: every proposed line gets a + gutter", () => {
    const rows = diffLines(undefined, "a\nb\nc");
    expect(rows.every((r) => r.gutter === "+")).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("edit: removed base lines as -, added proposed lines as +", () => {
    const rows = diffLines("old line", "new line");
    expect(rows.some((r) => r.gutter === "-")).toBe(true);
    expect(rows.some((r) => r.gutter === "+")).toBe(true);
  });
});

describe("learnings stepper view", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the first learning: title, progress 1 / 2, diff, recap, controls", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10, title: "First learning", recap: "first recap" }),
      mk({ id: "l2", cardId: "c1", createdAt: 20, title: "Second learning", op: "create", baseContent: undefined, proposedContent: "x\ny" }),
    ]);
    await hydrateLearnings(host);

    const container = document.createElement("div");
    renderLearnings(container, noopDeps("c1"));

    expect(container.querySelector(".lr-title")?.textContent).toBe("First learning");
    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    // Fixed strip of 2 dots: one current, one remaining, zero done.
    expect(container.querySelectorAll(".dots .dot").length).toBe(2);
    expect(container.querySelectorAll(".dots .dot.cur").length).toBe(1);
    expect(container.querySelectorAll(".dots .dot.done").length).toBe(0);
    expect(container.querySelectorAll(".diff .row").length).toBeGreaterThan(0);
    expect(container.querySelector(".recap-body")?.textContent).toContain("first recap");
    expect([...container.querySelectorAll("button")].some((b) => /Reject/.test(b.textContent ?? ""))).toBe(true);
    expect([...container.querySelectorAll("button")].some((b) => /Accept/.test(b.textContent ?? ""))).toBe(true);
    expect([...container.querySelectorAll("button")].some((b) => /Send/.test(b.textContent ?? ""))).toBe(true);
  });

  it("Accept advances the cursor over a FIXED total, the resolved item becomes a done dot, then empties", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10 }),
      mk({ id: "l2", cardId: "c1", createdAt: 20 }),
    ]);
    await hydrateLearnings(host);

    const container = document.createElement("div");
    const deps = noopDeps("c1");
    // make onAccept flip the status the way main.ts would, then the view re-renders
    deps.onAccept.mockImplementation((id: string) => {
      setLearningStatus(id, "accepted");
      renderLearnings(container, deps);
    });
    renderLearnings(container, deps);

    // Two learnings, both pending: starts at "1 / 2", l1 is current; strip of 2,
    // one current, no done yet.
    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l1");
    expect(container.querySelectorAll(".dots .dot").length).toBe(2);
    expect(container.querySelectorAll(".dots .dot.done").length).toBe(0);

    const accept = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Accept/.test(b.textContent ?? ""))!;
    accept.click();
    expect(deps.onAccept).toHaveBeenCalledWith("l1");
    // l1 is now accepted; the cursor (first pending) lands on l2. Denominator stays
    // FIXED at 2 (does not shrink) and the counter reads "2 / 2".
    expect(container.querySelector(".lr-count")?.textContent).toBe("2 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l2");
    // The dot strip stays 2 wide; the resolved l1 is now a done (dimmed) dot — proving
    // the done branch is reachable — and l2 is current.
    expect(container.querySelectorAll(".dots .dot").length).toBe(2);
    expect(container.querySelectorAll(".dots .dot.done").length).toBe(1);
    expect(container.querySelectorAll(".dots .dot.cur").length).toBe(1);

    const accept2 = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Accept/.test(b.textContent ?? ""))!;
    accept2.click();
    expect(deps.onAccept).toHaveBeenCalledWith("l2");
    expect(container.querySelector(".lr-empty")).not.toBeNull();
  });

  it("Reject calls onReject with the current learning id", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" })]);
    await hydrateLearnings(host);
    const container = document.createElement("div");
    const deps = noopDeps("c1");
    renderLearnings(container, deps);
    const reject = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Reject/.test(b.textContent ?? ""))!;
    reject.click();
    expect(deps.onReject).toHaveBeenCalledWith("l1");
  });

  it("Reject advances the cursor to the next pending learning over a FIXED total", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10 }),
      mk({ id: "l2", cardId: "c1", createdAt: 20 }),
    ]);
    await hydrateLearnings(host);

    const container = document.createElement("div");
    const deps = noopDeps("c1");
    // onReject flips status the way main.ts would, then re-renders.
    deps.onReject.mockImplementation((id: string) => {
      setLearningStatus(id, "rejected");
      renderLearnings(container, deps);
    });
    renderLearnings(container, deps);

    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l1");

    const reject = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Reject/.test(b.textContent ?? ""))!;
    reject.click();
    expect(deps.onReject).toHaveBeenCalledWith("l1");
    // l1 is rejected; cursor lands on l2. Denominator stays FIXED at 2.
    expect(container.querySelector(".lr-count")?.textContent).toBe("2 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l2");
    expect(container.querySelectorAll(".dots .dot").length).toBe(2);
    expect(container.querySelectorAll(".dots .dot.done").length).toBe(1);
    expect(container.querySelectorAll(".dots .dot.cur").length).toBe(1);
  });

  it("Comment stays on the current learning (status pending) and clears the input", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10 }),
      mk({ id: "l2", cardId: "c1", createdAt: 20 }),
    ]);
    await hydrateLearnings(host);

    const container = document.createElement("div");
    const deps = noopDeps("c1");
    // onComment records the comment the way main.ts would, then re-renders.
    deps.onComment.mockImplementation((id: string, text: string) => {
      addLearningComment(id, text, 123);
      renderLearnings(container, deps);
    });
    renderLearnings(container, deps);

    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l1");

    const input = container.querySelector<HTMLInputElement>(".comment-row input")!;
    input.value = "please refine";
    const send = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Send/.test(b.textContent ?? ""))!;
    send.click();

    expect(deps.onComment).toHaveBeenCalledWith("l1", "please refine");
    // Comment keeps status pending, so the SAME learning is still shown.
    expect(getLearning("l1")?.status).toBe("pending");
    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l1");
    expect(container.querySelectorAll(".dots .dot.done").length).toBe(0);
    // The (freshly rendered) comment input is empty.
    expect(container.querySelector<HTMLInputElement>(".comment-row input")!.value).toBe("");
  });

  it("Send is a no-op on empty / whitespace-only input", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" })]);
    await hydrateLearnings(host);
    const container = document.createElement("div");
    const deps = noopDeps("c1");
    renderLearnings(container, deps);
    const input = container.querySelector<HTMLInputElement>(".comment-row input")!;
    const send = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Send/.test(b.textContent ?? ""))!;

    send.click(); // empty
    input.value = "   \t  ";
    send.click(); // whitespace only
    expect(deps.onComment).not.toHaveBeenCalled();
  });

  it("Send passes the input text to onComment when non-empty", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" })]);
    await hydrateLearnings(host);
    const container = document.createElement("div");
    const deps = noopDeps("c1");
    renderLearnings(container, deps);
    const input = container.querySelector<HTMLInputElement>(".comment-row input")!;
    input.value = "please tweak";
    const send = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Send/.test(b.textContent ?? ""))!;
    send.click();
    expect(deps.onComment).toHaveBeenCalledWith("l1", "please tweak");
  });

  it("Comment sends to revise and ADVANCES to the next pending learning", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10 }),
      mk({ id: "l2", cardId: "c1", createdAt: 20 }),
    ]);
    await hydrateLearnings(host);

    const container = document.createElement("div");
    const deps = noopDeps("c1");
    // onComment records the comment AND flips the learning to "revising" the way
    // main.ts (R3) does, then re-renders. Revising drops out of the pending cursor.
    deps.onComment.mockImplementation((id: string, text: string) => {
      addLearningComment(id, text, 123);
      setLearningStatus(id, "revising");
      renderLearnings(container, deps);
    });
    renderLearnings(container, deps);

    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l1");

    const input = container.querySelector<HTMLInputElement>(".comment-row input")!;
    input.value = "please refine";
    const send = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Send/.test(b.textContent ?? ""))!;
    send.click();

    expect(deps.onComment).toHaveBeenCalledWith("l1", "please refine");
    // l1 is now revising (in flight); the cursor advances to l2. Denominator FIXED at 2.
    expect(getLearning("l1")?.status).toBe("revising");
    expect(container.querySelector(".lr-count")?.textContent).toBe("2 / 2");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l2");
    // l1's dot is now the in-flight "revising" class — NOT done, NOT cur; l2 is cur.
    expect(container.querySelectorAll(".dots .dot").length).toBe(2);
    expect(container.querySelectorAll(".dots .dot.revising").length).toBe(1);
    expect(container.querySelectorAll(".dots .dot.done").length).toBe(0);
    expect(container.querySelectorAll(".dots .dot.cur").length).toBe(1);
  });

  it("a revising learning renders a revising-class dot (not done, not cur)", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10, status: "revising" }),
      mk({ id: "l2", cardId: "c1", createdAt: 20 }),
    ]);
    await hydrateLearnings(host);

    const container = document.createElement("div");
    renderLearnings(container, noopDeps("c1"));

    // Cursor skips the revising l1 and lands on the pending l2.
    expect(container.querySelector(".lr-title")?.textContent).toBe("l2");
    const dots = [...container.querySelectorAll(".dots .dot")];
    expect(dots.length).toBe(2);
    expect(dots[0].classList.contains("revising")).toBe(true);
    expect(dots[0].classList.contains("done")).toBe(false);
    expect(dots[0].classList.contains("cur")).toBe(false);
    expect(dots[1].classList.contains("cur")).toBe(true);
  });

  it("waiting state: all learnings revising (none pending, none resolved)", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", createdAt: 10, status: "revising" }),
      mk({ id: "l2", cardId: "c1", createdAt: 20, status: "revising" }),
    ]);
    await hydrateLearnings(host);
    const container = document.createElement("div");
    renderLearnings(container, noopDeps("c1"));

    const waiting = container.querySelector(".lr-waiting");
    expect(waiting).not.toBeNull();
    expect(waiting?.textContent).toContain("2");
    expect(waiting?.textContent?.toLowerCase()).toContain("revise");
    // It must NOT read as the all-reviewed empty state.
    expect(container.querySelector(".lr-empty")).toBeNull();
  });

  it("all-resolved still renders the 'All learnings reviewed' empty state", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "l1", cardId: "c1", status: "accepted" }),
      mk({ id: "l2", cardId: "c1", status: "rejected" }),
    ]);
    await hydrateLearnings(host);
    const container = document.createElement("div");
    renderLearnings(container, noopDeps("c1"));
    expect(container.querySelector(".lr-empty")).not.toBeNull();
    expect(container.querySelector(".lr-waiting")).toBeNull();
    expect(container.querySelector(".lr-empty-title")?.textContent).toBe("All learnings reviewed");
  });

  it("empty state when no pending learnings", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1", status: "accepted" })]);
    await hydrateLearnings(host);
    const container = document.createElement("div");
    renderLearnings(container, noopDeps("c1"));
    expect(container.querySelector(".lr-empty")).not.toBeNull();
  });

  it("empty state when cardId is null", () => {
    const container = document.createElement("div");
    renderLearnings(container, noopDeps(null));
    expect(container.querySelector(".lr-empty")).not.toBeNull();
  });
});

describe("learningsCommentFocused (change-feed focus guard)", () => {
  let view: HTMLElement;
  beforeEach(async () => {
    localStorage.clear();
    document.body.replaceChildren();
    view = document.createElement("div");
    view.id = "view-learnings"; // the guard scopes to #view-learnings .comment-row
    document.body.append(view);
  });

  async function mount(): Promise<HTMLInputElement> {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" })]);
    await hydrateLearnings(host);
    renderLearnings(view, noopDeps("c1"));
    return view.querySelector<HTMLInputElement>(".comment-row input")!;
  }

  it("false when nothing is focused", async () => {
    await mount();
    expect(learningsCommentFocused()).toBe(false);
  });

  it("true only when the comment input within #view-learnings is focused", async () => {
    const input = await mount();
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(learningsCommentFocused()).toBe(true);
  });

  it("an external re-render GUARDED by the predicate preserves in-progress text + focus", async () => {
    const input = await mount();
    input.value = "half-typed feedback";
    input.focus();

    // Simulate the change-feed path: re-render only when NOT focused (main.ts guard).
    const externalRerender = () => {
      if (!learningsCommentFocused()) renderLearnings(view, noopDeps("c1"));
    };
    externalRerender(); // input is focused → skipped

    const stillThere = view.querySelector<HTMLInputElement>(".comment-row input")!;
    expect(stillThere).toBe(input); // same node — DOM was not rebuilt
    expect(stillThere.value).toBe("half-typed feedback");
    expect(document.activeElement).toBe(stillThere);

    // Once focus leaves, the same path DOES refresh (rebuilds the node).
    input.blur();
    externalRerender();
    const refreshed = view.querySelector<HTMLInputElement>(".comment-row input")!;
    expect(refreshed).not.toBe(input);
    expect(refreshed.value).toBe("");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Learning } from "@orden/host-api";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateLearnings, setLearningStatus } from "../src/learningsStore";
import { renderLearnings, diffLines, resetLearningsStep } from "../src/learningsView";

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
    resetLearningsStep();
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
    expect(container.querySelectorAll(".diff .row").length).toBeGreaterThan(0);
    expect(container.querySelector(".recap-body")?.textContent).toContain("first recap");
    expect([...container.querySelectorAll("button")].some((b) => /Reject/.test(b.textContent ?? ""))).toBe(true);
    expect([...container.querySelectorAll("button")].some((b) => /Accept/.test(b.textContent ?? ""))).toBe(true);
    expect([...container.querySelectorAll("button")].some((b) => /Send/.test(b.textContent ?? ""))).toBe(true);
  });

  it("Accept calls dep, then the acted item drops out and the queue advances to empty", async () => {
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

    // Two pending: starts at "1 / 2", l1 is current.
    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 2");
    const accept = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Accept/.test(b.textContent ?? ""))!;
    accept.click();
    expect(deps.onAccept).toHaveBeenCalledWith("l1");
    // l1 dropped out of the pending queue; index clamps onto the next pending (l2),
    // now the only remaining item → "1 / 1".
    expect(container.querySelector(".lr-count")?.textContent).toBe("1 / 1");
    expect(container.querySelector(".lr-title")?.textContent).toBe("l2");

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

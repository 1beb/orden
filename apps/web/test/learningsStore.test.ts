import { beforeEach, describe, expect, it } from "vitest";
import type { Learning } from "@orden/host-api";
import { BrowserHost } from "../src/host/browserHost";
import {
  hydrateLearnings,
  listLearnings,
  learningsForCard,
  pendingForCard,
  getLearning,
  setLearningStatus,
  addLearningComment,
} from "../src/learningsStore";

const settle = () => new Promise((r) => setTimeout(r, 10));

type SeedLearning = Learning;

function mk(over: Partial<SeedLearning> & Pick<SeedLearning, "id" | "cardId">): SeedLearning {
  return {
    projectId: "p1",
    type: "readme",
    title: over.id,
    recap: "recap",
    targetPath: "README.md",
    op: "edit",
    proposedContent: "content",
    status: "pending",
    createdAt: 1,
    ...over,
  };
}

async function seed(host: BrowserHost, items: SeedLearning[]): Promise<void> {
  for (const it of items) await host.vault.set("learnings", it.id, it);
}

describe("learnings store (host-backed)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("lists nothing before hydrate over an empty vault", async () => {
    await hydrateLearnings(new BrowserHost());
    expect(listLearnings()).toEqual([]);
  });

  it("hydrate populates the cache from the vault ns", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" }), mk({ id: "l2", cardId: "c2" })]);
    await hydrateLearnings(host);
    expect(listLearnings().map((l) => l.id).sort()).toEqual(["l1", "l2"]);
  });

  it("learningsForCard filters by cardId in createdAt-ascending order", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "a", cardId: "c1", createdAt: 30 }),
      mk({ id: "b", cardId: "c1", createdAt: 10 }),
      mk({ id: "c", cardId: "c1", createdAt: 20 }),
      mk({ id: "other", cardId: "c2", createdAt: 5 }),
    ]);
    await hydrateLearnings(host);
    expect(learningsForCard("c1").map((l) => l.id)).toEqual(["b", "c", "a"]);
  });

  it("pendingForCard counts only pending learnings for that card", async () => {
    const host = new BrowserHost();
    await seed(host, [
      mk({ id: "p", cardId: "c1", status: "pending" }),
      mk({ id: "q", cardId: "c1", status: "accepted" }),
      mk({ id: "r", cardId: "c1", status: "rejected" }),
      mk({ id: "s", cardId: "c1", status: "pending" }),
      mk({ id: "other", cardId: "c2", status: "pending" }),
    ]);
    await hydrateLearnings(host);
    expect(pendingForCard("c1")).toBe(2);
    expect(pendingForCard("c2")).toBe(1);
    expect(pendingForCard("none")).toBe(0);
  });

  it("getLearning returns by id, undefined when absent", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" })]);
    await hydrateLearnings(host);
    expect(getLearning("l1")?.id).toBe("l1");
    expect(getLearning("nope")).toBeUndefined();
  });

  it("setLearningStatus updates cache and writes through to the vault", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1", status: "pending" })]);
    await hydrateLearnings(host);
    setLearningStatus("l1", "accepted");
    expect(getLearning("l1")?.status).toBe("accepted");
    await settle();
    const stored = await host.vault.get<SeedLearning>("learnings", "l1");
    expect(stored?.status).toBe("accepted");
  });

  it("addLearningComment appends a comment and writes through", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1" })]);
    await hydrateLearnings(host);
    addLearningComment("l1", "needs work", 100);
    addLearningComment("l1", "thanks", 200);
    expect(getLearning("l1")?.comments).toEqual([
      { at: 100, text: "needs work" },
      { at: 200, text: "thanks" },
    ]);
    await settle();
    const stored = await host.vault.get<SeedLearning>("learnings", "l1");
    expect(stored?.comments).toEqual([
      { at: 100, text: "needs work" },
      { at: 200, text: "thanks" },
    ]);
  });

  it("persists across a re-hydrate over the same vault", async () => {
    const host = new BrowserHost();
    await seed(host, [mk({ id: "l1", cardId: "c1", status: "pending" })]);
    await hydrateLearnings(host);
    setLearningStatus("l1", "rejected");
    await settle();
    await hydrateLearnings(new BrowserHost());
    expect(getLearning("l1")?.status).toBe("rejected");
  });
});

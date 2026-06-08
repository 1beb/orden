import { describe, expect, it } from "vitest";
import { fakeVault } from "./fakeVault.js";
import {
  type Learning,
  addLearningComment,
  getLearning,
  listLearningsForCard,
  putLearning,
  setLearningStatus,
} from "../src/learnings.js";

function mkLearning(over: Partial<Learning> = {}): Learning {
  return {
    id: "l1",
    cardId: "c1",
    projectId: "p1",
    type: "readme",
    title: "Document the foo flag",
    recap: "While doing X I learned Y about the foo flag.",
    targetPath: "README.md",
    op: "edit",
    proposedContent: "# Project\n\nThe foo flag does Z.\n",
    baseContent: "# Project\n",
    status: "pending",
    createdAt: 1000,
    ...over,
  };
}

describe("learnings vault model", () => {
  it("put then get round-trips a full Learning", async () => {
    const vault = fakeVault();
    const learning = mkLearning({
      sessionId: "s1",
      comments: [{ at: 5, text: "hi" }],
    });
    await putLearning(vault, learning);
    const got = await getLearning(vault, "l1");
    expect(got).toEqual(learning);
  });

  it("getLearning returns null for a missing id", async () => {
    const vault = fakeVault();
    expect(await getLearning(vault, "nope")).toBeNull();
  });

  it("listLearningsForCard returns only matching cardId", async () => {
    const vault = fakeVault();
    await putLearning(vault, mkLearning({ id: "a1", cardId: "c1" }));
    await putLearning(vault, mkLearning({ id: "a2", cardId: "c1" }));
    await putLearning(vault, mkLearning({ id: "b1", cardId: "c2" }));
    const forC1 = await listLearningsForCard(vault, "c1");
    expect(forC1.map((l) => l.id).sort()).toEqual(["a1", "a2"]);
    const forC2 = await listLearningsForCard(vault, "c2");
    expect(forC2.map((l) => l.id)).toEqual(["b1"]);
  });

  it("setLearningStatus flips status, preserves other fields, returns updated", async () => {
    const vault = fakeVault();
    const learning = mkLearning({ comments: [{ at: 1, text: "note" }] });
    await putLearning(vault, learning);
    const updated = await setLearningStatus(vault, "l1", "accepted");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("accepted");
    expect(updated).toEqual({ ...learning, status: "accepted" });
    // persisted
    expect((await getLearning(vault, "l1"))!.status).toBe("accepted");
  });

  it("setLearningStatus returns null when missing", async () => {
    const vault = fakeVault();
    expect(await setLearningStatus(vault, "nope", "rejected")).toBeNull();
  });

  it("addLearningComment appends with passed at, inits array, preserves order", async () => {
    const vault = fakeVault();
    await putLearning(vault, mkLearning());
    const first = await addLearningComment(vault, "l1", "first", 100);
    expect(first).not.toBeNull();
    expect(first!.comments).toEqual([{ at: 100, text: "first" }]);
    const second = await addLearningComment(vault, "l1", "second", 200);
    expect(second!.comments).toEqual([
      { at: 100, text: "first" },
      { at: 200, text: "second" },
    ]);
    // persisted
    expect((await getLearning(vault, "l1"))!.comments).toEqual([
      { at: 100, text: "first" },
      { at: 200, text: "second" },
    ]);
  });

  it("addLearningComment returns null when missing", async () => {
    const vault = fakeVault();
    expect(await addLearningComment(vault, "nope", "x", 1)).toBeNull();
  });
});

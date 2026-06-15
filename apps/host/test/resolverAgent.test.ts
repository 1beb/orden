import { describe, it, expect } from "vitest";
import { conservativeResolver } from "../src/resolverAgent";

describe("conservativeResolver", () => {
  it("escalates every conflict as an intent decision with card ids as chip options", async () => {
    const outcome = await conservativeResolver({
      integrationWorkdir: "/wt",
      incoming: { cardId: "b", branch: "orden/b", title: "B feature" },
      contributors: [{ cardId: "a", branch: "orden/a", title: "A feature" }],
      conflictFiles: ["main.ts"],
    });
    expect(outcome.kind).toBe("intent-conflict");
    if (outcome.kind === "intent-conflict") {
      expect(outcome.options).toEqual(["b", "a"]); // incoming first, then contributors
      expect(outcome.question).toContain("B feature");
      expect(outcome.question).toContain("main.ts");
    }
  });
});

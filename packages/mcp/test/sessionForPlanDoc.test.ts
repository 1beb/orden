import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import { sessionForPlanDoc } from "../src/sessionLink";
import type { VaultStore } from "@orden/host-api";

const seed = (cards: Record<string, unknown>): VaultStore => fakeVault({ cards });

describe("sessionForPlanDoc", () => {
  it("matches a card by exact planDoc and returns its sessionIds", async () => {
    const v = seed({
      c1: {
        id: "c1",
        title: "Fix login",
        state: "in-progress",
        planDoc: "docs/plans/login.md",
        sessionIds: ["s1", "s2"],
      },
    });
    const r = await sessionForPlanDoc(v, "docs/plans/login.md");
    expect(r.card?.id).toBe("c1");
    expect(r.sessionIds).toEqual(["s1", "s2"]);
    expect(r.candidates).toEqual([]);
  });

  it("returns the empty shape when no card matches", async () => {
    const v = seed({
      c1: { id: "c1", title: "A", state: "planning", planDoc: "docs/plans/a.md", sessionIds: ["s1"] },
    });
    const r = await sessionForPlanDoc(v, "docs/plans/nope.md");
    expect(r.card).toBeNull();
    expect(r.sessionIds).toEqual([]);
  });

  it("reads a legacy single sessionId", async () => {
    const v = seed({
      c1: { id: "c1", title: "A", state: "planning", planDoc: "docs/plans/a.md", sessionId: "s9" },
    });
    const r = await sessionForPlanDoc(v, "docs/plans/a.md");
    expect(r.card?.id).toBe("c1");
    expect(r.sessionIds).toEqual(["s9"]);
  });

  it("returns an empty sessionIds list for a card with no sessions", async () => {
    const v = seed({
      c1: { id: "c1", title: "A", state: "planning", planDoc: "docs/plans/a.md", sessionIds: [] },
    });
    const r = await sessionForPlanDoc(v, "docs/plans/a.md");
    expect(r.card?.id).toBe("c1");
    expect(r.sessionIds).toEqual([]);
  });

  it("offers near-miss planDoc paths as candidates when nothing matches exactly", async () => {
    const v = seed({
      c1: { id: "c1", title: "A", state: "planning", planDoc: "docs/plans/login-flow.md", sessionIds: ["s1"] },
      c2: { id: "c2", title: "B", state: "planning", planDoc: "docs/plans/signup.md", sessionIds: ["s2"] },
    });
    const r = await sessionForPlanDoc(v, "docs/plans/login.md");
    expect(r.card).toBeNull();
    expect(r.candidates).toContain("docs/plans/login-flow.md");
    expect(r.candidates).not.toContain("docs/plans/signup.md");
  });
});

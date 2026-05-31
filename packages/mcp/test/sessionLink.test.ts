import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import { sessionForConversation, cardForSession, findCard } from "../src/sessionLink";

const seed = () => fakeVault({
  sessions: { s1: { id: "s1", conversationId: "uuid-1", projectId: "p1" } },
  cards: {
    c1: { id: "c1", title: "Fix login", state: "in-progress", projectId: "p1", sessionIds: ["s1"] },
    c2: { id: "c2", title: "Write docs", state: "planning", projectId: "p1", sessionIds: [] },
  },
});

describe("sessionLink", () => {
  it("maps a conversation id to its orden session", async () => {
    expect((await sessionForConversation(seed(), "uuid-1"))?.id).toBe("s1");
    expect(await sessionForConversation(seed(), "nope")).toBeNull();
  });
  it("finds the card linked to a session", async () => {
    expect((await cardForSession(seed(), "s1"))?.id).toBe("c1");
    expect(await cardForSession(seed(), "sX")).toBeNull();
  });
  it("findCard resolves by id", async () => {
    expect((await findCard(seed(), "c2")).card?.id).toBe("c2");
  });
  it("findCard resolves by exact title, case-insensitive", async () => {
    expect((await findCard(seed(), "fix login")).card?.id).toBe("c1");
  });
  it("findCard returns up-to-5 candidates on a miss (substring)", async () => {
    const r = await findCard(seed(), "doc");
    expect(r.card).toBeNull();
    expect(r.candidates).toContain("Write docs");
  });
  it("findCard prefers id over title and returns empty candidates on exact hit", async () => {
    const r = await findCard(seed(), "c1");
    expect(r.card?.id).toBe("c1");
    expect(r.candidates).toEqual([]);
  });
});

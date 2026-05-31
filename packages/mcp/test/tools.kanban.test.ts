import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import {
  resolveProject,
  cardGet,
  cardMove,
  cardComplete,
  cardCreate,
  projectList,
  sessionCreate,
  panelOpen,
} from "../src/tools";
import type { VaultStore } from "@orden/host-api";

const seed = (): VaultStore =>
  fakeVault({
    projects: {
      homeroom: { id: "homeroom", name: "Homeroom", source: "local" },
      proj_alpha: { id: "proj_alpha", name: "Alpha", source: "local" },
    },
    cards: {
      c1: {
        id: "c1",
        title: "Fix login",
        state: "in-progress",
        projectId: "proj_alpha",
        notes: "existing",
        sessionIds: ["s1"],
      },
      c2: { id: "c2", title: "Write docs", state: "planning", projectId: "homeroom", sessionIds: [] },
    },
  });

const out = (r: { content: { text: string }[] }) => r.content[0].text;

describe("resolveProject", () => {
  it("resolves by exact id", async () => {
    expect(await resolveProject(seed(), "proj_alpha")).toBe("proj_alpha");
  });
  it("resolves by name case-insensitive and trimmed", async () => {
    expect(await resolveProject(seed(), "  alpha  ")).toBe("proj_alpha");
  });
  it("throws on unmatched, listing available names", async () => {
    await expect(resolveProject(seed(), "Nope")).rejects.toThrow(
      'unknown project "Nope"; available: Homeroom, Alpha',
    );
  });
  it("defaults to homeroom when nothing given", async () => {
    expect(await resolveProject(seed(), undefined)).toBe("homeroom");
  });
  it("honors a fallback when nothing given", async () => {
    expect(await resolveProject(seed(), undefined, "proj_alpha")).toBe("proj_alpha");
  });
});

describe("cardGet", () => {
  it("returns parsed fields on a hit", async () => {
    const parsed = JSON.parse(out(await cardGet(seed(), "Fix login")));
    expect(parsed).toEqual({
      id: "c1",
      title: "Fix login",
      state: "in-progress",
      project: "proj_alpha",
      notes: "existing",
    });
  });
  it("reports a miss with closest candidates", async () => {
    expect(out(await cardGet(seed(), "log"))).toBe('no card matches "log"; closest: Fix login');
  });
  it("reports a miss with no candidates", async () => {
    expect(out(await cardGet(seed(), "zzz"))).toBe('no card matches "zzz"');
  });
});

describe("cardMove", () => {
  it("patches state, keeping title and sessionIds", async () => {
    const v = seed();
    const r = await cardMove(v, "c1", "blocked");
    expect(out(r)).toBe('card "Fix login" -> blocked');
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.state).toBe("blocked");
    expect(card?.title).toBe("Fix login");
    expect(card?.sessionIds).toEqual(["s1"]);
  });
  it("appends a note when given", async () => {
    const v = seed();
    await cardMove(v, "c1", "blocked", "waiting on review");
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.notes).toBe("existing\nblocked: waiting on review");
  });
  it("reports a miss", async () => {
    expect(out(await cardMove(seed(), "zzz", "blocked"))).toBe('no card matches "zzz"');
  });
});

describe("cardComplete", () => {
  it("reaches complete", async () => {
    const v = seed();
    expect(out(await cardComplete(v, "c2"))).toBe('card "Write docs" -> complete');
    const card = await v.get<Record<string, unknown>>("cards", "c2");
    expect(card?.state).toBe("complete");
  });
});

describe("cardCreate", () => {
  it("lands in planning with an item_ id and resolved project", async () => {
    const v = seed();
    const r = await cardCreate(v, "  New task  ", "Alpha", "some notes");
    const m = out(r).match(/created card "New task" in planning \((item_[^)]+)\)/);
    expect(m).not.toBeNull();
    const id = m![1];
    const card = await v.get<Record<string, unknown>>("cards", id);
    expect(card).toMatchObject({
      title: "New task",
      state: "planning",
      projectId: "proj_alpha",
      notes: "some notes",
      sessionIds: [],
    });
  });
  it("returns the error text on unknown project", async () => {
    expect(out(await cardCreate(seed(), "x", "Nope"))).toBe(
      'unknown project "Nope"; available: Homeroom, Alpha',
    );
  });
});

describe("projectList", () => {
  it("sorts by name", async () => {
    expect(out(await projectList(seed()))).toBe("proj_alpha  Alpha\nhomeroom  Homeroom");
  });
  it("reports empty", async () => {
    expect(out(await projectList(fakeVault()))).toBe("(no projects)");
  });
});

describe("sessionCreate", () => {
  it("writes a sess_ session and a linked planning card", async () => {
    const v = seed();
    const r = await sessionCreate(v, {
      title: "Investigate bug",
      projectIdOrName: "Alpha",
      prompt: "  look into it  ",
    });
    const m = out(r).match(/created session "Investigate bug" \+ planning card \((sess_[^)]+)\)/);
    expect(m).not.toBeNull();
    const sessionId = m![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session).toMatchObject({
      id: sessionId,
      title: "Investigate bug",
      agent: "claude",
      projectId: "proj_alpha",
      initialPrompt: "look into it",
    });
    const cardIds = await v.list("cards");
    const cards = await Promise.all(
      cardIds.map((id) => v.get<Record<string, unknown>>("cards", id)),
    );
    const linked = cards.find((c) => (c?.sessionIds as string[])?.includes(sessionId));
    expect(linked).toMatchObject({
      title: "Investigate bug",
      state: "planning",
      projectId: "proj_alpha",
    });
    expect((linked?.id as string).startsWith("item_")).toBe(true);
  });
  it("defaults agent and title, omits empty prompt", async () => {
    const v = seed();
    const r = await sessionCreate(v, { title: "   " });
    const sessionId = out(r).match(/\((sess_[^)]+)\)/)![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session).toMatchObject({ title: "Untitled session", agent: "claude", projectId: "homeroom" });
    expect(session).not.toHaveProperty("initialPrompt");
  });
  it("returns error text on unknown project", async () => {
    expect(out(await sessionCreate(seed(), { title: "x", projectIdOrName: "Nope" }))).toBe(
      'unknown project "Nope"; available: Homeroom, Alpha',
    );
  });
});

describe("panelOpen", () => {
  it("writes a panel-intent with kind/target and a nonce", async () => {
    const v = seed();
    const r = await panelOpen(v, "card", "c1");
    expect(out(r)).toBe("opened card in panel: c1");
    const intent = await v.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent).toMatchObject({ kind: "card", target: "c1" });
    expect(typeof intent?.nonce).toBe("string");
    expect((intent?.nonce as string).length).toBeGreaterThan(0);
  });
  it("handles kanban with no target", async () => {
    const v = seed();
    expect(out(await panelOpen(v, "kanban", ""))).toBe("opened kanban in panel");
    const intent = await v.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent).toMatchObject({ kind: "kanban", target: "" });
  });
  it("uses a fresh nonce so repeat opens of the same target still differ", async () => {
    const v = seed();
    await panelOpen(v, "card", "c1");
    const first = (await v.get<Record<string, unknown>>("ui", "panel-intent"))?.nonce;
    await panelOpen(v, "card", "c1");
    const second = (await v.get<Record<string, unknown>>("ui", "panel-intent"))?.nonce;
    expect(second).not.toBe(first);
  });
});

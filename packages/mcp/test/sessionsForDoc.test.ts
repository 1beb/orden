import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import { sessionsForDoc, recordDocLink, sessionByWorkdir } from "../src/sessionLink";

describe("sessionsForDoc", () => {
  it("prefers an explicit planDoc card link", async () => {
    const v = fakeVault({
      cards: {
        c1: { id: "c1", title: "A", state: "in-progress", planDoc: "/abs/doc.md", sessionIds: ["s1"] },
      },
      sessions: { s1: { id: "s1" } },
    });
    const r = await sessionsForDoc(v, "/abs/doc.md");
    expect(r.via).toBe("plan");
    expect(r.sessionIds).toEqual(["s1"]);
  });

  it("falls back to a recorded open-time doc link", async () => {
    const v = fakeVault({ sessions: { s2: { id: "s2" } } });
    await recordDocLink(v, "/abs/review.md", "s2");
    const r = await sessionsForDoc(v, "/abs/review.md");
    expect(r.via).toBe("link");
    expect(r.sessionIds).toEqual(["s2"]);
  });

  it("ignores a doc link whose session no longer exists", async () => {
    const v = fakeVault({ sessions: {} });
    await recordDocLink(v, "/abs/review.md", "gone");
    const r = await sessionsForDoc(v, "/abs/review.md");
    expect(r.via).toBe("none");
    expect(r.sessionIds).toEqual([]);
  });

  it("derives the owning session from its worktree path", async () => {
    const v = fakeVault({
      sessions: {
        s3: { id: "s3", workdir: "/home/b/.orden/worktrees/proj_x/sess_3" },
      },
    });
    const r = await sessionsForDoc(
      v,
      "/home/b/.orden/worktrees/proj_x/sess_3/docs/research/report.md",
    );
    expect(r.via).toBe("workdir");
    expect(r.sessionIds).toEqual(["s3"]);
  });

  it("picks the nested (longest) worktree when paths nest", async () => {
    const v = fakeVault({
      sessions: {
        outer: { id: "outer", workdir: "/w/a" },
        inner: { id: "inner", workdir: "/w/a/b" },
      },
    });
    expect((await sessionByWorkdir(v, "/w/a/b/doc.md"))?.id).toBe("inner");
    expect((await sessionByWorkdir(v, "/w/a/doc.md"))?.id).toBe("outer");
  });

  it("does not match a workdir that is only a string prefix, not a path boundary", async () => {
    const v = fakeVault({ sessions: { s: { id: "s", workdir: "/w/app" } } });
    // "/w/app-other/..." must NOT match "/w/app"
    expect(await sessionByWorkdir(v, "/w/app-other/doc.md")).toBeNull();
  });

  it("returns 'none' when nothing resolves", async () => {
    const v = fakeVault({ sessions: {} });
    const r = await sessionsForDoc(v, "/abs/orphan.md");
    expect(r.via).toBe("none");
  });
});

import { describe, test, expect } from "vitest";
import type { Host } from "@orden/host-api";
import { queueToSession, annotationSend, type PaneOps } from "../src/annotationDelivery";

// A vault over a plain Map, mirroring the mcp fakeVault. Host needs only .vault.
function hostWith(seed: Record<string, Record<string, unknown>> = {}): Host {
  const store = new Map<string, Map<string, unknown>>();
  for (const [ns, kv] of Object.entries(seed)) store.set(ns, new Map(Object.entries(kv)));
  const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
  return {
    vault: {
      async get<T>(ns: string, key: string) {
        return (nsMap(ns).get(key) ?? null) as T | null;
      },
      async set<T>(ns: string, key: string, value: T) {
        nsMap(ns).set(key, value);
      },
      async list(ns: string) {
        return [...nsMap(ns).keys()];
      },
      async delete(ns: string, key: string) {
        nsMap(ns).delete(key);
      },
    },
  } as unknown as Host;
}

// A fake pane surface that records calls and lets the test toggle liveness.
function fakeOps(live: boolean) {
  const calls = { sent: [] as { sessionId: string; text: string }[], relaunched: [] as string[] };
  const ops: PaneOps = {
    async isLive() {
      return live;
    },
    async sendText(sessionId, text) {
      calls.sent.push({ sessionId, text });
    },
    async sendKeys() {},
    async relaunch(sessionId) {
      calls.relaunched.push(sessionId);
    },
  };
  return { ops, calls };
}

describe("queueToSession", () => {
  test("types into a live pane and reports queued", async () => {
    const host = hostWith({ sessions: { s1: { id: "s1" } } });
    const { ops, calls } = fakeOps(true);
    const r = await queueToSession(host, "s1", "hello agent", ops);
    expect(r).toEqual({ delivered: "queued", sessionId: "s1" });
    expect(calls.sent).toEqual([{ sessionId: "s1", text: "hello agent" }]);
    expect(calls.relaunched).toEqual([]);
  });

  test("relaunches with a queued initialPrompt when no live pane", async () => {
    const host = hostWith({ sessions: { s1: { id: "s1", conversationId: "c1" } } });
    const { ops, calls } = fakeOps(false);
    const r = await queueToSession(host, "s1", "wake up", ops);
    expect(r).toEqual({ delivered: "relaunched", sessionId: "s1" });
    expect(calls.relaunched).toEqual(["s1"]);
    expect(calls.sent).toEqual([]);
    const rec = await host.vault.get<Record<string, unknown>>("sessions", "s1");
    expect(rec?.initialPrompt).toBe("wake up");
    expect(rec?.pendingLaunch).toBe(true);
  });

  test("never throws — a failing pane op resolves as failed", async () => {
    const host = hostWith({ sessions: { s1: { id: "s1" } } });
    const ops: PaneOps = {
      async isLive() {
        return true;
      },
      async sendText() {
        throw new Error("tmux blew up");
      },
      async sendKeys() {},
      async relaunch() {},
    };
    const r = await queueToSession(host, "s1", "x", ops);
    expect(r).toEqual({ delivered: "failed", sessionId: "s1" });
  });
});

describe("annotationSend", () => {
  const plan = "docs/plans/X.md";

  test("creates a session (in homeroom) and queues the annotation when nothing is linked", async () => {
    const host = hostWith({ cards: {}, sessions: {}, projects: {} });
    const { ops } = fakeOps(true);
    const r = await annotationSend(
      host,
      { planDoc: plan, annotations: [{ id: "a1", planDoc: plan, note: "n", quote: "q" }] },
      ops,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.target).toMatch(/^sess/);
    // The new session carries the annotation as its launch prompt, in homeroom.
    const rec = await host.vault.get<Record<string, unknown>>("sessions", r.target);
    expect(rec?.initialPrompt).toContain('"q"');
    expect(rec?.projectId).toBe("homeroom");
    expect(rec?.pendingLaunch).toBe(true);
    // …and the doc→session link is recorded so later sends reuse it.
    const link = await host.vault.get<{ sessionId: string }>("doclinks", plan);
    expect(link?.sessionId).toBe(r.target);
  });

  test("creates the session in the caller's project when projectId is supplied", async () => {
    // A relative docPath (as the web sends) can't match any absolute project
    // root, so without the hint this would fall to "homeroom". The hint — which
    // the web knows because it opened the file — lands it in the right project.
    const host = hostWith({ cards: {}, sessions: {}, projects: {} });
    const { ops } = fakeOps(true);
    const docPath = "analysis/model-review/rule_search_us.html";
    const r = await annotationSend(
      host,
      {
        planDoc: docPath,
        annotations: [{ id: "a1", planDoc: docPath, note: "n", quote: "q" }],
        projectId: "proj_research",
      },
      ops,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    const rec = await host.vault.get<Record<string, unknown>>("sessions", r.target);
    expect(rec?.projectId).toBe("proj_research");
  });

  test("delivers to the session that owns the doc's worktree when no card matches", async () => {
    const host = hostWith({
      cards: {},
      sessions: { s9: { id: "s9", workdir: "/wt/proj/sess9" } },
    });
    const { ops, calls } = fakeOps(true);
    const docPath = "/wt/proj/sess9/docs/report.md";
    const r = await annotationSend(
      host,
      { planDoc: docPath, annotations: [{ id: "a1", planDoc: docPath, note: "n", quote: "q" }] },
      ops,
    );
    expect(r).toMatchObject({ ok: true, target: "s9", delivered: "queued", count: 1 });
    expect(calls.sent[0].sessionId).toBe("s9");
  });

  test("delivers to a session recorded as having opened the doc", async () => {
    const host = hostWith({
      cards: {},
      sessions: { s5: { id: "s5" } },
      doclinks: { [plan]: { sessionId: "s5" } },
    });
    const { ops, calls } = fakeOps(true);
    const r = await annotationSend(
      host,
      { planDoc: plan, annotations: [{ id: "a1", planDoc: plan, note: "n", quote: "q" }] },
      ops,
    );
    expect(r).toMatchObject({ ok: true, target: "s5" });
    expect(calls.sent[0].sessionId).toBe("s5");
  });

  test("delivers a single annotation to the live session and reports count 1", async () => {
    const host = hostWith({
      cards: { c1: { id: "c1", title: "T", state: "in-progress", planDoc: plan, sessionIds: ["s1", "s2"] } },
      sessions: { s1: { id: "s1" }, s2: { id: "s2" } },
    });
    // s2 is live; s1 is not. annotationSend should prefer the live one.
    const sentTo: { sessionId: string; text: string }[] = [];
    const ops: PaneOps = {
      async isLive(sessionId: string) {
        return sessionId === "s2";
      },
      async sendText(sessionId: string, text: string) {
        sentTo.push({ sessionId, text });
      },
      async sendKeys() {},
      async relaunch() {},
    };
    const r = await annotationSend(
      host,
      { planDoc: plan, annotations: [{ id: "a1", planDoc: plan, note: "n", quote: "q" }] },
      ops,
    );
    expect(r).toEqual({ ok: true, target: "s2", delivered: "queued", count: 1 });
    expect(sentTo[0].sessionId).toBe("s2");
    expect(sentTo[0].text).toContain('> "q"');
  });

  test("falls back to the most recent session when none are live, and batches", async () => {
    const host = hostWith({
      cards: { c1: { id: "c1", title: "T", state: "blocked", planDoc: plan, sessionIds: ["s1", "s2"] } },
      sessions: { s1: { id: "s1" }, s2: { id: "s2", conversationId: "c2" } },
    });
    const { ops, calls } = fakeOps(false);
    const r = await annotationSend(
      host,
      {
        planDoc: plan,
        annotations: [
          { id: "a1", planDoc: plan, note: "n1", quote: "q1" },
          { id: "a2", planDoc: plan, note: "n2" },
        ],
      },
      ops,
    );
    // most recent = last in the array = s2
    expect(r).toEqual({ ok: true, target: "s2", delivered: "relaunched", count: 2 });
    expect(calls.relaunched).toEqual(["s2"]);
    const rec = await host.vault.get<Record<string, unknown>>("sessions", "s2");
    expect(rec?.initialPrompt).toContain("2 annotations on docs/plans/X.md");
  });
});

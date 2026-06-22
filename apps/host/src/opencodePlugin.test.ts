import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { opencodePluginSource } from "./opencodePlugin";

// Evaluate the generated plugin source in-process with fetch + env mocked, then
// return its handler map plus the list of posted card states (parsed from the
// /hooks/session-state?state=... URL). Tests the actual shipped source.
async function loadPlugin(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const states: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const m = /state=([a-z-]+)/.exec(String(url));
    if (m) states.push(m[1]);
    return { ok: true };
  });
  const src = opencodePluginSource().replace("export const OrdenKanban", "const OrdenKanban");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${src}; return OrdenKanban;`)() as () => Promise<{
    event: (i: { event: unknown }) => Promise<void>;
  }>;
  const handlers = await factory();
  const fire = (event: unknown) => handlers.event({ event });
  return { fire, states };
}

const status = (sessionID: string, type: string) => ({
  type: "session.status",
  properties: { sessionID, status: { type } },
});

beforeEach(() => {
  delete process.env.ORDEN_OPENCODE_ROOT;
  process.env.ORDEN_SESSION_ID = "sess_x";
  process.env.ORDEN_PORT = "4319";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORDEN_OPENCODE_ROOT;
});

describe("opencode plugin card-state mapping", () => {
  it("busy/retry keep in-progress; root idle blocks", async () => {
    const { fire, states } = await loadPlugin({ ORDEN_OPENCODE_ROOT: "root1" });
    await fire(status("root1", "busy"));
    await fire(status("root1", "retry"));
    await fire(status("root1", "busy"));
    await fire(status("root1", "idle"));
    expect(states).toEqual(["in-progress", "in-progress", "in-progress", "blocked"]);
  });

  it("a child/subagent idle does NOT block when root is seeded", async () => {
    const { fire, states } = await loadPlugin({ ORDEN_OPENCODE_ROOT: "root1" });
    await fire(status("child2", "idle"));
    expect(states).toEqual([]); // no block — not the root session
  });

  it("permission.asked blocks; permission.replied resumes", async () => {
    const { fire, states } = await loadPlugin({ ORDEN_OPENCODE_ROOT: "root1" });
    await fire({ type: "permission.asked", properties: { id: "per_1", sessionID: "root1" } });
    await fire({ type: "permission.replied", properties: { id: "per_1" } });
    expect(states).toEqual(["blocked", "in-progress"]);
  });

  it("permission.updated (older opencode name) also blocks", async () => {
    const { fire, states } = await loadPlugin({ ORDEN_OPENCODE_ROOT: "root1" });
    await fire({ type: "permission.updated", properties: { id: "per_1", sessionID: "root1" } });
    expect(states).toEqual(["blocked"]);
  });

  it("first launch (no env root): root session.created sets rootId, then its idle blocks", async () => {
    const { fire, states } = await loadPlugin({});
    await fire({ type: "session.created", properties: { info: { id: "root9" } } });
    await fire(status("root9", "idle"));
    expect(states).toEqual(["in-progress", "blocked"]);
  });

  it("session.updated does NOT un-block a blocked card", async () => {
    const { fire, states } = await loadPlugin({ ORDEN_OPENCODE_ROOT: "root1" });
    await fire(status("root1", "idle"));
    await fire({ type: "session.updated", properties: { info: { id: "root1" } } });
    expect(states).toEqual(["blocked"]); // updated is ignored
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { opencodePluginSource } from "./opencodePlugin";

// Evaluate the generated plugin source in-process with fetch + env mocked, then
// return its handler map plus the list of posts. Each post records the card
// state (parsed from the /hooks/session-state?state=... URL) and the parsed
// request body, so tests can assert both the state transition and the payload
// (e.g. session.created must carry session_id). Tests the actual shipped source.
async function loadPlugin(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const states: string[] = [];
  const posts: { state: string | undefined; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    const m = /state=([a-z-]+)/.exec(String(url));
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (m) states.push(m[1]);
    posts.push({ state: m?.[1], body });
    return { ok: true };
  });
  const src = opencodePluginSource().replace("export const OrdenKanban", "const OrdenKanban");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${src}; return OrdenKanban;`)() as () => Promise<{
    event: (i: { event: unknown }) => Promise<void>;
  }>;
  const handlers = await factory();
  const fire = (event: unknown) => handlers.event({ event });
  return { fire, states, posts };
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
    const { fire, states, posts } = await loadPlugin({});
    await fire({ type: "session.created", properties: { info: { id: "root9" } } });
    await fire(status("root9", "idle"));
    expect(states).toEqual(["in-progress", "blocked"]);
    // The created-event post must carry the opencode session id so the host can
    // persist the mapping (a regression dropping it would silently break resume).
    expect(posts[0].body.session_id).toBe("root9");
  });

  it("session.updated does NOT un-block a blocked card", async () => {
    const { fire, states } = await loadPlugin({ ORDEN_OPENCODE_ROOT: "root1" });
    await fire(status("root1", "idle"));
    await fire({ type: "session.updated", properties: { info: { id: "root1" } } });
    expect(states).toEqual(["blocked"]); // updated is ignored
  });
});

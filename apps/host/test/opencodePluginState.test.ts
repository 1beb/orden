import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { opencodePluginSource } from "../src/opencodePlugin";

// The generated opencode kanban plugin maps opencode lifecycle events to card
// state. The contract under test: the turn boundary is the ROOT session's
// session.status{idle} — only that blocks the card. A CHILD/subagent session's
// status{idle} must NOT block. session.idle and session.updated are ignored
// entirely, and child/subagent session.created events post nothing (so they can
// never overwrite the root's persisted conversation id).

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

describe("opencode plugin: card-state event mapping", () => {
  let dir: string;
  let makePlugin: () => Promise<{
    event: (input: { event: unknown }) => Promise<void>;
    posts: Posted[];
  }>;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "orden-plugin-state-"));
    const file = join(dir, "orden-kanban.mjs");
    writeFileSync(file, opencodePluginSource(), "utf8");
    const mod = await import(pathToFileURL(file).href);
    makePlugin = async () => {
      const posts: Posted[] = [];
      // Stub fetch: record the hook path + parsed body instead of doing network.
      globalThis.fetch = (async (url: string, init: { body: string }) => {
        posts.push({
          path: String(url).split("/hooks/")[1] ?? "",
          body: JSON.parse(init.body),
        });
        return { ok: true } as Response;
      }) as typeof fetch;
      const plugin = await mod.OrdenKanban();
      return { event: plugin.event, posts };
    };
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = savedFetch;
  });
  beforeEach(() => {
    process.env.ORDEN_SESSION_ID = "orden-sid";
  });

  const created = (id: string, parentID?: string) => ({
    type: "session.created",
    properties: { info: { id, parentID } },
  });
  const statusIdle = (sessionID: string) => ({
    type: "session.status",
    properties: { sessionID, status: { type: "idle" } },
  });
  const states = (posts: Posted[]) =>
    posts.map((p) => new URLSearchParams(p.path.split("?")[1]).get("state"));

  test("root session.created marks in-progress and carries its id", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    expect(states(posts)).toEqual(["in-progress"]);
    expect(posts[0].body.session_id).toBe("root-1");
    expect(posts[0].body.orden_session_id).toBe("orden-sid");
  });

  test("root session.status idle blocks the card", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: statusIdle("root-1") });
    expect(states(posts)).toEqual(["in-progress", "blocked"]);
  });

  test("a child/subagent session idle does NOT block the card", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: created("child-1", "root-1") }); // subagent spawned (posts nothing)
    await event({ event: statusIdle("child-1") }); // subagent finishes its turn
    // Only the root's in-progress post — the child created nothing and its
    // status-idle is not the root, so no block.
    expect(states(posts)).toEqual(["in-progress"]);
  });

  test("a child session.created does not overwrite the conversation id", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: created("child-1", "root-1") });
    // The child created posts nothing, so the id can never be overwritten.
    expect(posts.length).toBe(1);
    expect(posts[0].body.session_id).toBe("root-1");
  });

  test("subagent finishes, then root goes idle -> blocked once", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: created("child-1", "root-1") });
    await event({ event: statusIdle("child-1") }); // no block here
    await event({ event: statusIdle("root-1") }); // real turn boundary
    expect(states(posts)).toEqual(["in-progress", "blocked"]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { opencodePluginSource } from "../src/opencodePlugin";

// The generated opencode kanban plugin maps opencode lifecycle events to card
// state. The contract under test: a CHILD/subagent session going idle must NOT
// block the card — only the ROOT session's idle is a turn boundary.

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
  const idle = (sessionID: string) => ({ type: "session.idle", properties: { sessionID } });
  const states = (posts: Posted[]) =>
    posts.map((p) => new URLSearchParams(p.path.split("?")[1]).get("state"));

  test("root session.created marks in-progress and carries its id", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    expect(states(posts)).toEqual(["in-progress"]);
    expect(posts[0].body.session_id).toBe("root-1");
    expect(posts[0].body.orden_session_id).toBe("orden-sid");
  });

  test("root session.idle blocks the card", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: idle("root-1") });
    expect(states(posts)).toEqual(["in-progress", "blocked"]);
  });

  test("a child/subagent session idle does NOT block the card", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: created("child-1", "root-1") }); // subagent spawned
    await event({ event: idle("child-1") }); // subagent finishes its turn
    // Only the two in-progress posts — no blocked from the child's idle.
    expect(states(posts)).toEqual(["in-progress", "in-progress"]);
  });

  test("a child session.created does not overwrite the conversation id", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: created("child-1", "root-1") });
    expect(posts[0].body.session_id).toBe("root-1");
    expect(posts[1].body.session_id).toBeUndefined();
  });

  test("subagent finishes, then root goes idle -> blocked once", async () => {
    const { event, posts } = await makePlugin();
    await event({ event: created("root-1") });
    await event({ event: created("child-1", "root-1") });
    await event({ event: idle("child-1") }); // no block here
    await event({ event: idle("root-1") }); // real turn boundary
    expect(states(posts)).toEqual(["in-progress", "in-progress", "blocked"]);
  });
});

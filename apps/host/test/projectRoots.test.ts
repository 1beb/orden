import { describe, test, expect } from "vitest";
import { makeProjectRootResolver, listLocalProjectRoots } from "../src/projectRoots";
import type { Host } from "@orden/host-api";

function vaultWith(recs: Record<string, unknown>): Host {
  return {
    vault: {
      get: async (_ns: string, key: string) => recs[key] ?? null,
      list: async (_ns: string) => Object.keys(recs),
    },
  } as unknown as Host;
}

describe("makeProjectRootResolver", () => {
  const FILES_ROOT = "/srv/orden";
  test("resolves a local project to its source.path", async () => {
    const r = makeProjectRootResolver(vaultWith({
      p1: { id: "p1", name: "X", source: { kind: "local", path: "/home/u/x" } },
    }), FILES_ROOT);
    expect(await r("p1")).toBe("/home/u/x");
  });
  test("aliases the literal 'repo' id to filesRoot", async () => {
    const r = makeProjectRootResolver(vaultWith({}), FILES_ROOT);
    expect(await r("repo")).toBe(FILES_ROOT);
  });
  test("returns undefined for ephemeral / unknown / non-local", async () => {
    const r = makeProjectRootResolver(vaultWith({
      eph: { id: "eph", name: "H", source: { kind: "ephemeral" } },
    }), FILES_ROOT);
    expect(await r("eph")).toBeUndefined();
    expect(await r("nope")).toBeUndefined();
  });
  test("returns undefined for 'repo' when no filesRoot is configured", async () => {
    const r = makeProjectRootResolver(vaultWith({}), undefined);
    expect(await r("repo")).toBeUndefined();
  });

  // The "host" root opens arbitrary absolute paths (open/edit/annotate a
  // referenced file with no project), independent of any vault record.
  test("resolves the 'host' id to the filesystem root", async () => {
    const r = makeProjectRootResolver(vaultWith({}), FILES_ROOT);
    expect(await r("host")).toBe("/");
  });

  // session:<id> exposes a session's git worktree as a file root, so
  // panel_open / doc_render / repo-file resolve worktree paths.
  test("resolves session:<id> to the session's workdir", async () => {
    const host = {
      vault: {
        get: async (ns: string, key: string) =>
          ns === "sessions" && key === "sess_1"
            ? { id: "sess_1", workdir: "/home/u/.orden/worktrees/p1/sess_1" }
            : null,
      },
    } as unknown as Host;
    const r = makeProjectRootResolver(host, FILES_ROOT);
    expect(await r("session:sess_1")).toBe("/home/u/.orden/worktrees/p1/sess_1");
  });

  test("returns undefined for an unknown session or one without a workdir", async () => {
    const host = {
      vault: {
        get: async (ns: string, key: string) =>
          ns === "sessions" && key === "plain" ? { id: "plain" } : null,
      },
    } as unknown as Host;
    const r = makeProjectRootResolver(host, FILES_ROOT);
    expect(await r("session:plain")).toBeUndefined();
    expect(await r("session:ghost")).toBeUndefined();
  });
});

describe("listLocalProjectRoots", () => {
  test("returns only local projects as {id, root}", async () => {
    const host = vaultWith({
      p1: { id: "p1", name: "X", source: { kind: "local", path: "/home/u/x" } },
      eph: { id: "eph", name: "H", source: { kind: "ephemeral" } },
    });
    expect(await listLocalProjectRoots(host)).toEqual([{ id: "p1", root: "/home/u/x" }]);
  });
});

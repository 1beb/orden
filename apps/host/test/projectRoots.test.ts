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

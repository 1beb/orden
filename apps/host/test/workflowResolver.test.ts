import { describe, expect, it } from "vitest";
import type { VaultStore } from "@orden/host-api";
import { DEFAULT_WORKFLOW } from "@orden/workflows";
import {
  resolveSessionWorkflow,
  resolveSessionWorkflowName,
  isDefaultName,
} from "../src/workflowResolver";

// A map-backed vault matching the VaultStore contract.
function mapVault(recs: Record<string, unknown>): VaultStore {
  const data = new Map<string, unknown>();
  for (const [k, v] of Object.entries(recs)) data.set(k, v);
  return {
    get: async (ns: string, key: string) => data.get(`${ns}/${key}`) ?? null,
    set: async (ns: string, key: string, value: unknown) => {
      data.set(`${ns}/${key}`, value);
    },
    list: async (ns: string) =>
      [...data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1)),
    delete: async (ns: string, key: string) => {
      data.delete(`${ns}/${key}`);
    },
  } as unknown as VaultStore;
}

describe("resolveSessionWorkflowName", () => {
  it("returns undefined (default) when nothing is configured", async () => {
    const vault = mapVault({ "sessions/s1": { id: "s1", projectId: "p1" } });
    expect(await resolveSessionWorkflowName(vault, "s1")).toBeUndefined();
  });
  it("uses the session.workflow binding first", async () => {
    const vault = mapVault({
      "sessions/s1": { id: "s1", projectId: "p1", workflow: "bugfix" },
      "workflows/project:p1": "release", // project default is shadowed
    });
    expect(await resolveSessionWorkflowName(vault, "s1")).toBe("bugfix");
  });
  it("falls back to the project default when the session has no binding", async () => {
    const vault = mapVault({
      "sessions/s1": { id: "s1", projectId: "p1" },
      "workflows/project:p1": "analysis",
    });
    expect(await resolveSessionWorkflowName(vault, "s1")).toBe("analysis");
  });
});

describe("resolveSessionWorkflow", () => {
  it("resolves a built-in preset by name", async () => {
    const vault = mapVault({
      "sessions/s1": { id: "s1", projectId: "p1", workflow: "bugfix" },
    });
    const spec = await resolveSessionWorkflow(vault, "s1");
    expect(spec.name).toBe("bugfix");
  });
  it("falls back to DEFAULT_WORKFLOW for an unconfigured session", async () => {
    const vault = mapVault({ "sessions/s1": { id: "s1", projectId: "p1" } });
    const spec = await resolveSessionWorkflow(vault, "s1");
    expect(spec).toBe(DEFAULT_WORKFLOW);
  });
  it("falls back to default when a referenced stored workflow is missing", async () => {
    const vault = mapVault({
      "sessions/s1": { id: "s1", projectId: "p1", workflow: "ghost" },
    });
    const spec = await resolveSessionWorkflow(vault, "s1");
    expect(spec).toBe(DEFAULT_WORKFLOW);
  });
});

describe("isDefaultName", () => {
  it("treats undefined, empty, and 'default' as default", () => {
    expect(isDefaultName(undefined)).toBe(true);
    expect(isDefaultName("")).toBe(true);
    expect(isDefaultName("default")).toBe(true);
    expect(isDefaultName("bugfix")).toBe(false);
  });
});

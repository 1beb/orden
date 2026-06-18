import { describe, expect, it } from "vitest";
import type { VaultStore } from "@orden/host-api";
import {
  workflowList,
  workflowValidate,
  workflowSave,
  workflowRender,
  workflowPropose,
  workflowAdvance,
  WORKFLOW_SIGNAL_NS,
} from "../src/tools";

function mapVault(recs: Record<string, unknown> = {}): VaultStore {
  const data = new Map<string, unknown>(Object.entries(recs).map(([k, v]) => [k, v]));
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

const text = (r: { content: { text: string }[] }): string => r.content[0].text;

const GOOD_MD = `---
name: my-flow
description: A test flow.
---

1. prose — Plan
   Plan it.

2. gate: approve — Approve
   Confirm.

3. do: push — Publish
   Push it.
`;

describe("workflowList", () => {
  it("lists presets + saved, saved shadows presets", async () => {
    const vault = mapVault({
      "workflows/md:custom": "---\nname: custom\ndescription: mine\n---\n\n1. prose — X\n   y\n",
    });
    const out = text(await workflowList(vault));
    expect(out).toContain("default");
    expect(out).toContain("custom");
    expect(out).toContain("mine");
  });
});

describe("workflowValidate", () => {
  it("validates a sound markdown with no errors", async () => {
    const r = JSON.parse(text(await workflowValidate(GOOD_MD)));
    expect(r.errors).toEqual([]);
    expect(r.name).toBe("my-flow");
  });
  it("reports a warning when there is no approval gate", async () => {
    const md = `---
name: no-approve
---

1. prose — Do
   work

2. do: push — Push
   push
`;
    const r = JSON.parse(text(await workflowValidate(md)));
    expect(r.warnings.some((w: string) => /approval gate/i.test(w))).toBe(true);
  });
});

describe("workflowSave", () => {
  it("saves under workflows/md:<name>", async () => {
    const vault = mapVault();
    const out = text(await workflowSave(vault, GOOD_MD));
    expect(out).toContain("saved workflow \"my-flow\"");
    const stored = await vault.get<string>("workflows", "md:my-flow");
    expect(stored).toBe(GOOD_MD);
  });
  it("rejects a missing or invalid name", async () => {
    const vault = mapVault();
    const out = text(await workflowSave(vault, "---\nname: has:colon\n---\n"));
    expect(out).toMatch(/needs a `name:`/);
  });
});

describe("workflowRender", () => {
  it("renders a preset by name", async () => {
    const out = text(await workflowRender(mapVault(), "default"));
    expect(out).toContain("name: default");
    expect(out).toMatch(/prose.*Plan/);
  });
  it("renders a saved workflow", async () => {
    const vault = mapVault({ "workflows/md:my-flow": GOOD_MD });
    expect(text(await workflowRender(vault, "my-flow"))).toBe(GOOD_MD);
  });
  it("reports not-found for an unknown name", async () => {
    expect(text(await workflowRender(mapVault(), "ghost"))).toMatch(/not found/);
  });
});

describe("workflowPropose", () => {
  it("binds a workflow to a session record", async () => {
    const vault = mapVault({ "sessions/s1": { id: "s1", title: "T", projectId: "p1" } });
    const out = text(await workflowPropose(vault, "s1", "bugfix"));
    expect(out).toContain("bound to workflow \"bugfix\"");
    expect(out).toContain("runbook engine will drive");
    const ses = (await vault.get<{ workflow?: string }>("sessions", "s1"))!;
    expect(ses.workflow).toBe("bugfix");
  });
  it("notes default means existing behavior (no engine)", async () => {
    const vault = mapVault({ "sessions/s1": { id: "s1", title: "T" } });
    const out = text(await workflowPropose(vault, "s1", "default"));
    expect(out).toContain("default — existing behavior");
  });
  it("refuses an unknown session", async () => {
    expect(text(await workflowPropose(mapVault(), "nope", "bugfix"))).toMatch(/not found/);
  });
});

describe("workflowAdvance", () => {
  it("writes the signal to the workflow-signal namespace keyed by cardId", async () => {
    const vault = mapVault();
    const out = text(await workflowAdvance(vault, "c1", "approve"));
    expect(out).toContain("approve");
    const sig = await vault.get<{ signal: string }>(WORKFLOW_SIGNAL_NS, "c1");
    expect(sig).toEqual({ signal: "approve" });
  });
  it("accepts reject and complete signals", async () => {
    const vault = mapVault();
    await workflowAdvance(vault, "c1", "reject");
    expect((await vault.get<{ signal: string }>(WORKFLOW_SIGNAL_NS, "c1"))!.signal).toBe("reject");
    await workflowAdvance(vault, "c1", "complete");
    expect((await vault.get<{ signal: string }>(WORKFLOW_SIGNAL_NS, "c1"))!.signal).toBe("complete");
  });
});

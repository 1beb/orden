import { describe, expect, it } from "vitest";
import type { Host } from "@orden/host-api";
import {
  DEFAULT_WORKFLOW,
  advance,
  resolveSpec,
  type WorkflowSpec,
} from "@orden/workflows";
import {
  tickRunbook,
  handleSignal,
  executePrimitiveAction,
  isEngineDrivenCard,
  WORKFLOW_RUN_NS,
  type RunnerDeps,
} from "../src/runbookRunner";
import { WORKFLOWS_NS, projectWorkflowKey } from "../src/workflowResolver";
import type { CardRec } from "@orden/mcp";

// A non-default runbook: plan -> approve(gate) -> implement -> check(onFail->implement)
// -> review(gate,onReject->implement) -> journal -> push -> reap.
const RUNBOOK: WorkflowSpec = resolveSpec({
  name: "engine-test",
  description: "test",
  steps: [
    { id: "plan", label: "Plan", role: "initial", kind: "prose", prose: "Plan." },
    { id: "approve", label: "Approve", role: "waiting", kind: "gate", gate: "approve" },
    { id: "implement", label: "Implement", role: "active", kind: "prose", prose: "Do." },
    {
      id: "check",
      label: "Check",
      role: "active",
      kind: "primitive",
      action: "check",
      params: { command: "pnpm test" },
      onFail: { goto: "implement" },
    },
    {
      id: "review",
      label: "Review",
      role: "waiting",
      kind: "gate",
      gate: "review",
      onReject: { goto: "implement" },
    },
    { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
    { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
    { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
  ],
});

interface FakeHost extends Host {
  written: Record<string, unknown>;
  killed: string[];
  publishCalls: string[];
  runCalls: { cwd: string; command: string }[];
  logCalls: { cardId: string; line: string }[];
}

function makeHost(opts: {
  card?: Partial<CardRec>;
  workflow?: string; // session.workflow binding (non-default = engine-driven)
  storedWorkflow?: unknown;
  projectWorkflow?: string;
  runResult?: { code: number; stdout: string };
  gitClean?: boolean;
  publishFail?: boolean;
}): FakeHost {
  const data = new Map<string, unknown>();
  const card: CardRec = {
    id: "c1",
    title: "Test card",
    state: "in-progress",
    sessionIds: ["s1"],
    ...opts.card,
  };
  data.set("cards/c1", card);
  data.set("sessions/s1", {
    id: "s1",
    projectId: "p1",
    workdir: "/wt/s1",
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
  });
  if (opts.projectWorkflow) data.set(`workflows/${projectWorkflowKey("p1")}`, opts.projectWorkflow);
  // Store the non-default workflow so resolveSessionWorkflow finds it (the
  // runner is opt-in: a workflow that resolves to "default" is never driven).
  data.set(`${WORKFLOWS_NS}/engine-test`, RUNBOOK);

  const written: Record<string, unknown> = {};
  const killed: string[] = [];
  const publishCalls: string[] = [];
  const runCalls: { cwd: string; command: string }[] = [];
  const logCalls: { cardId: string; line: string }[] = [];
  const runResult = opts.runResult ?? { code: 0, stdout: "" };

  const host = {
    written,
    killed,
    publishCalls,
    runCalls,
    logCalls,
    vault: {
      get: async (ns: string, key: string) => data.get(`${ns}/${key}`) ?? null,
      set: async (ns: string, key: string, value: unknown) => {
        data.set(`${ns}/${key}`, value);
        written[`${ns}/${key}`] = value;
      },
      list: async (ns: string) =>
        [...data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1)),
      delete: async (ns: string, key: string) => {
        data.delete(`${ns}/${key}`);
      },
    },
    sessions: {
      kill: async (sid: string) => {
        killed.push(sid);
      },
    },
    publish: opts.publishFail
      ? async (sid: string) => {
          publishCalls.push(sid);
          return { state: "push-failed", branch: "orden/x", error: "nope" };
        }
      : async (sid: string) => {
          publishCalls.push(sid);
          return { state: "pr-opened", branch: "orden/x", prUrl: "http://pr" };
        },
  } as unknown as FakeHost;

  return host;
}

function deps(opts: { runResult?: { code: number; stdout: string }; gitClean?: boolean } = {}): RunnerDeps {
  return {
    runCommand: async () => opts.runResult ?? { code: 0, stdout: "" },
    gitStatus: async () => ({ code: 0, stdout: opts.gitClean === false ? " M file.ts" : "" }),
    logLine: async () => {},
    now: () => 1000,
  };
}

describe("tickRunbook — opt-in", () => {
  it("does NOTHING for a default-workflow card (behavior-neutral)", async () => {
    const host = makeHost({ card: { state: "in-progress" } }); // no workflow binding
    await tickRunbook(host, "c1", deps());
    // No run-state written, card unchanged.
    expect(host.written[`${WORKFLOW_RUN_NS}/c1`]).toBeUndefined();
    expect((host.written["cards/c1"] as CardRec | undefined)?.state).toBeUndefined();
  });
  it("does nothing when the session binds the default workflow explicitly", async () => {
    const host = makeHost({ workflow: "default" });
    await tickRunbook(host, "c1", deps());
    expect(host.written[`${WORKFLOW_RUN_NS}/c1`]).toBeUndefined();
  });
});

describe("behavior-neutrality — default cards look identical to today", () => {
  it("isEngineDrivenCard is false for a card with no run-state (the reactors fire)", async () => {
    const host = makeHost({ card: { state: "complete" } });
    expect(await isEngineDrivenCard(host.vault, "c1")).toBe(false);
  });
  it("isEngineDrivenCard is true only once the runner has initialized a run-state", async () => {
    const host = makeHost({ workflow: "engine-test" });
    await tickRunbook(host, "c1", deps()); // initializes the run-state
    expect(await isEngineDrivenCard(host.vault, "c1")).toBe(true);
  });
  it("a complete default-workflow card is reaped/published/journaled by the reactors, not the runner", async () => {
    // The runner must not touch this card; the unconditional reactors own it.
    const host = makeHost({ card: { state: "complete" } });
    const before = (await host.vault.get<CardRec>("cards", "c1"))!;
    await tickRunbook(host, "c1", deps());
    const after = await host.vault.get<CardRec>("cards", "c1");
    expect(after).toEqual(before); // byte-identical — runner did nothing
    expect(host.killed).toEqual([]); // no reap
    expect(host.publishCalls).toEqual([]); // no publish
  });
});

describe("tickRunbook — terminal completion pipeline", () => {
  it("walks terminal primitives to complete when starting at the first terminal step", async () => {
    const host = makeHost({ workflow: "engine-test" });
    // Seed a run-state already past the review gate, at the journal step (index 5).
    await host.vault.set(WORKFLOW_RUN_NS, "c1", {
      cardId: "c1",
      workflowName: "engine-test",
      stepIndex: 5,
      status: "running",
      history: [],
    });
    await tickRunbook(host, "c1", deps());
    const run = host.written[`${WORKFLOW_RUN_NS}/c1`] as { status: string; stepIndex: number };
    expect(run.status).toBe("done");
    expect(run.stepIndex).toBe(8);
    // Card projected to complete.
    expect((host.written["cards/c1"] as CardRec).state).toBe("complete");
    // Effects fired: publish (push) + reap (kill).
    expect(host.publishCalls).toEqual(["s1"]);
    expect(host.killed).toEqual(["s1"]);
  });
});

describe("tickRunbook — gates park as durable suspensions", () => {
  it("parks at a gate step (blocked) and waits for the resume signal", async () => {
    const host = makeHost({ workflow: "engine-test" });
    // At the approve gate (index 1).
    await host.vault.set(WORKFLOW_RUN_NS, "c1", {
      cardId: "c1",
      workflowName: "engine-test",
      stepIndex: 1,
      status: "running",
      history: [],
    });
    await tickRunbook(host, "c1", deps());
    const run = host.written[`${WORKFLOW_RUN_NS}/c1`] as { status: string };
    expect(run.status).toBe("gate-parked");
    expect((host.written["cards/c1"] as CardRec).state).toBe("blocked");
  });

  it("resume (approve) advances past the gate", async () => {
    const host = makeHost({ workflow: "engine-test" });
    await host.vault.set(WORKFLOW_RUN_NS, "c1", {
      cardId: "c1",
      workflowName: "engine-test",
      stepIndex: 1,
      status: "gate-parked",
      history: [],
    });
    await handleSignal(host, "c1", "approve", deps());
    const run = host.written[`${WORKFLOW_RUN_NS}/c1`] as { status: string; stepIndex: number };
    // Now at implement (prose, index 2) — runner projects and waits.
    expect(run.stepIndex).toBe(2);
    expect(run.status).toBe("running");
  });
});

describe("tickRunbook — board projection", () => {
  it("projects planning for the initial step", async () => {
    const host = makeHost({ workflow: "engine-test", card: { state: "complete" } });
    await tickRunbook(host, "c1", deps()); // starts at plan (initial)
    expect((host.written["cards/c1"] as CardRec).state).toBe("planning");
  });
});

describe("tickRunbook — dirty-state rule", () => {
  it("parks before push when the tree is dirty and policy is ask", async () => {
    const host = makeHost({ workflow: "engine-test" });
    // At the push step (index 6), tree dirty.
    await host.vault.set(WORKFLOW_RUN_NS, "c1", {
      cardId: "c1",
      workflowName: "engine-test",
      stepIndex: 6,
      status: "running",
      history: [],
    });
    await tickRunbook(host, "c1", deps({ gitClean: false }));
    const run = host.written[`${WORKFLOW_RUN_NS}/c1`] as { status: string; parkedReason?: string };
    expect(run.status).toBe("parked-dirty");
    expect(run.parkedReason).toMatch(/push/i);
    expect((host.written["cards/c1"] as CardRec).state).toBe("blocked");
    // push did NOT fire.
    expect(host.publishCalls).toEqual([]);
  });
});

describe("executePrimitiveAction — check gates on exit code", () => {
  it("check passes on exit 0", async () => {
    const host = makeHost({ workflow: "engine-test" });
    const spec = RUNBOOK;
    const run = { cardId: "c1", workflowName: "engine-test", stepIndex: 3, status: "running" as const, history: [] };
    const out = await executePrimitiveAction(host, host.written["cards/c1"] as CardRec ?? { id: "c1", title: "t", state: "in-progress", sessionIds: ["s1"] }, ["s1"], ["/wt"], spec, run, { runCommand: async () => ({ code: 0, stdout: "" }), gitStatus: async () => ({ code: 0, stdout: "" }), executePrimitive: async () => "pass", logLine: async () => {}, now: () => 1000 });
    expect(out).toBe("pass");
  });
  it("check fails on non-zero exit", async () => {
    const host = makeHost({ workflow: "engine-test" });
    const spec = RUNBOOK;
    const run = { cardId: "c1", workflowName: "engine-test", stepIndex: 3, status: "running" as const, history: [] };
    const out = await executePrimitiveAction(host, { id: "c1", title: "t", state: "in-progress", sessionIds: ["s1"] }, ["s1"], ["/wt"], spec, run, { runCommand: async () => ({ code: 1, stdout: "FAIL" }), gitStatus: async () => ({ code: 0, stdout: "" }), executePrimitive: async () => "pass", logLine: async () => {}, now: () => 1000 });
    expect(out).toBe("fail");
  });
  it("run never gates (always passes)", async () => {
    const spec = resolveSpec({
      name: "t",
      steps: [
        { id: "do", label: "Do", role: "active", kind: "prose", prose: "x" },
        { id: "run", label: "Run", role: "active", kind: "primitive", action: "run", params: { command: "echo hi" } },
        { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
      ],
    });
    const host = makeHost({ workflow: "engine-test" });
    const run = { cardId: "c1", workflowName: "t", stepIndex: 1, status: "running" as const, history: [] };
    const out = await executePrimitiveAction(host, { id: "c1", title: "t", state: "in-progress", sessionIds: ["s1"] }, ["s1"], ["/wt"], spec, run, { runCommand: async () => ({ code: 2, stdout: "" }), gitStatus: async () => ({ code: 0, stdout: "" }), executePrimitive: async () => "pass", logLine: async () => {}, now: () => 1000 });
    expect(out).toBe("pass");
  });
});

describe("tickRunbook — default workflow runbook is well-formed", () => {
  it("DEFAULT_WORKFLOW walks its terminal steps to done (engine self-consistency)", () => {
    // Sanity: the default runbook's terminal steps are walkable by the engine.
    // (The runner never executes them for real — default cards are opt-OUT — but
    // the runbook must be structurally sound.)
    let run: import("@orden/workflows").RunState = {
      cardId: "c1",
      workflowName: "default",
      stepIndex: 4, // propose-learnings (first terminal)
      status: "running",
      history: [],
    };
    for (let i = 0; i < 5; i++) run = advance(DEFAULT_WORKFLOW, run, "pass");
    expect(run.status).toBe("done");
  });
});

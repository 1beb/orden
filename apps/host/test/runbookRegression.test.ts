import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHost } from "../src/nodeHost";
import { journalCompletedCard } from "../src/cardJournal";
import { tickRunbook, WORKFLOW_RUN_NS } from "../src/runbookRunner";
import { journalKey } from "@orden/outliner/page";

// The app-run regression check: under the DEFAULT workflow, completing a card
// must behave exactly as today — the journal reactor fires, and the runbook
// engine never creates a run-state (it's opt-in for non-default workflows only).
// This exercises the real NodeHost + EmittingVault + reactor chain end-to-end.
let root: string;
let host: NodeHost;
const hosts: NodeHost[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-regress-"));
  host = new NodeHost({ vaultRoot: root });
  hosts.push(host);
});

afterEach(async () => {
  for (const h of hosts.splice(0)) h.stop();
  await rm(root, { recursive: true, force: true });
});

describe("default-workflow completion regression (app-run)", () => {
  test("journal reactor fires on a default card completion", async () => {
    // Seed a default-workflow session (no `workflow` field) + a planning card.
    await host.vault.set("sessions", "s1", { id: "s1", title: "T", agent: "claude", projectId: "p1" });
    await host.vault.set("cards", "c1", {
      id: "c1",
      title: "Regression card",
      state: "planning",
      projectId: "p1",
      sessionIds: ["s1"],
    });

    // Wire the journal reactor exactly as serve.ts does.
    const journaled = new Set<string>();
    host.onChange((change) => {
      if (change.ns !== "cards") return;
      void journalCompletedCard(host, change.key, journaled);
    });

    // Complete the card (the write fires the change feed).
    await host.vault.set("cards", "c1", {
      id: "c1",
      title: "Regression card",
      state: "complete",
      projectId: "p1",
      sessionIds: ["s1"],
      completedAt: Date.now(),
      completionSummary: "app-run regression",
    });

    // The reactor is async; let it drain.
    await new Promise((r) => setTimeout(r, 100));

    // The journal day-page should now carry the completion entry.
    const day = journalKey(new Date());
    const entry = await host.vault.get<string>("journal", day);
    expect(entry).toBeTruthy();
    expect(entry).toContain("Completed \"Regression card\"");
    expect(entry).toContain("app-run regression");
  });

  test("the runbook engine creates NO run-state for a default card", async () => {
    await host.vault.set("sessions", "s1", { id: "s1", title: "T", agent: "claude", projectId: "p1" });
    await host.vault.set("cards", "c1", {
      id: "c1",
      title: "Default card",
      state: "complete",
      projectId: "p1",
      sessionIds: ["s1"],
    });

    // Tick the runner the way serve.ts does on a card write.
    await tickRunbook(host, "c1");

    // No run-state => the engine is dormant for default cards.
    const run = await host.vault.get(WORKFLOW_RUN_NS, "c1");
    expect(run).toBeNull();
  });

  test("the runbook engine DOES drive a non-default-workflow card", async () => {
    // A bugfix-workflow session. Bugfix is a preset; its first step is "reproduce"
    // (a prose step, role initial). The runner should initialize a run-state and
    // project the card to "planning".
    await host.vault.set("sessions", "s1", {
      id: "s1",
      title: "Bug",
      agent: "claude",
      projectId: "p1",
      workflow: "bugfix",
    });
    await host.vault.set("cards", "c1", {
      id: "c1",
      title: "Bug card",
      state: "complete", // deliberately wrong; the engine should re-project
      projectId: "p1",
      sessionIds: ["s1"],
    });

    await tickRunbook(host, "c1");

    const run = await host.vault.get<{ status: string; workflowName: string }>(WORKFLOW_RUN_NS, "c1");
    expect(run).not.toBeNull();
    expect(run!.workflowName).toBe("bugfix");
    // The first bugfix step ("reproduce") is a prose step at role initial ->
    // the card projects to "planning" and the runner parks (prose = agent works).
    const card = await host.vault.get<{ state: string }>("cards", "c1");
    expect(card!.state).toBe("planning");
  });
});

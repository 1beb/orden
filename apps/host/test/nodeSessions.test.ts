import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskVault } from "../src/diskVault";
import { NodeSessions, type AgentRunner } from "../src/nodeSessions";

let root: string;
let vault: DiskVault;

async function seedSession(id: string): Promise<void> {
  await vault.set("sessions", id, {
    id,
    title: "Untitled",
    agent: "claude",
    projectId: "",
    messages: [],
  });
  await vault.set("cards", "card1", {
    id: "card1",
    projectId: "",
    title: "Untitled",
    state: "backlog",
    notes: "",
    sessionId: id,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-sess-"));
  vault = new DiskVault(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NodeSessions.prompt", () => {
  test("appends user + agent messages and stores the conversation id", async () => {
    await seedSession("s1");
    const runner: AgentRunner = async ({ prompt }) => ({
      reply: `echo: ${prompt}`,
      conversationId: "conv-1",
    });
    const sessions = new NodeSessions({ vault, defaultCwd: root, runner });

    await sessions.prompt("s1", "hello there");

    const rec = await vault.get<{ messages: { role: string; text: string }[]; conversationId: string }>(
      "sessions",
      "s1",
    );
    expect(rec!.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello there"],
      ["agent", "echo: hello there"],
    ]);
    expect(rec!.conversationId).toBe("conv-1");
  });

  test("resumes with the stored conversation id on the next turn", async () => {
    await seedSession("s1");
    const seen: (string | undefined)[] = [];
    const runner: AgentRunner = async ({ conversationId, prompt }) => {
      seen.push(conversationId);
      return { reply: `r:${prompt}`, conversationId: "conv-1" };
    };
    const sessions = new NodeSessions({ vault, defaultCwd: root, runner });
    await sessions.prompt("s1", "first");
    await sessions.prompt("s1", "second");
    expect(seen).toEqual([undefined, "conv-1"]); // first turn mints, second resumes
  });

  test("auto-titles an Untitled session and the linked card after the first turn", async () => {
    await seedSession("s1");
    const runner: AgentRunner = async () => ({
      reply: "ok",
      conversationId: "c",
      title: "Investigate the churn drop",
    });
    const sessions = new NodeSessions({ vault, defaultCwd: root, runner });
    await sessions.prompt("s1", "why did churn jump?");

    expect((await vault.get<{ title: string }>("sessions", "s1"))!.title).toBe(
      "Investigate the churn drop",
    );
    expect((await vault.get<{ title: string }>("cards", "card1"))!.title).toBe(
      "Investigate the churn drop",
    );
  });

  test("drives the linked card: in-progress while running, ready when done", async () => {
    await seedSession("s1");
    const states: string[] = [];
    const runner: AgentRunner = async () => {
      states.push((await vault.get<{ state: string }>("cards", "card1"))!.state);
      return { reply: "ok", conversationId: "c" };
    };
    const sessions = new NodeSessions({ vault, defaultCwd: root, runner });
    await sessions.prompt("s1", "go");
    expect(states[0]).toBe("in-progress"); // card was in-progress during the run
    expect((await vault.get<{ state: string }>("cards", "card1"))!.state).toBe("ready");
  });

  test("a runner error records a system message and marks the card broken", async () => {
    await seedSession("s1");
    const runner: AgentRunner = async () => {
      throw new Error("claude blew up");
    };
    const sessions = new NodeSessions({ vault, defaultCwd: root, runner });
    await sessions.prompt("s1", "go");
    const rec = await vault.get<{ messages: { role: string; text: string }[] }>("sessions", "s1");
    expect(rec!.messages.at(-1)!.role).toBe("system");
    expect(rec!.messages.at(-1)!.text).toContain("claude blew up");
    expect((await vault.get<{ state: string }>("cards", "card1"))!.state).toBe("broken");
  });
});

import { describe, test, expect } from "vitest";
import type { Host, VaultStore } from "@orden/host-api";
import {
  applyState,
  applyStop,
  isDestructiveGit,
  noteSubagentStart,
  noteSubagentStop,
  preToolUseVerdict,
  reconcileConversationId,
  resetSubagents,
  settleSubagents,
} from "../src/hooks";

// Minimal in-memory vault (mirrors packages/mcp/test/fakeVault) so we can drive
// applyState without disk. Only get/set/list/delete are exercised by the helpers.
function fakeVault(seed: Record<string, Record<string, unknown>> = {}): VaultStore {
  const store = new Map<string, Map<string, unknown>>();
  for (const [ns, kv] of Object.entries(seed)) store.set(ns, new Map(Object.entries(kv)));
  const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
  return {
    async get<T>(ns: string, key: string) {
      return (nsMap(ns).get(key) ?? null) as T | null;
    },
    async set<T>(ns: string, key: string, value: T) {
      nsMap(ns).set(key, value);
    },
    async list(ns: string) {
      return [...nsMap(ns).keys()];
    },
    async delete(ns: string, key: string) {
      nsMap(ns).delete(key);
    },
  };
}

// applyState only touches host.vault — a vault-only host is enough.
const hostWith = (vault: VaultStore): Host => ({ vault }) as unknown as Host;

describe("applyState (hooks → card state)", () => {
  test("leaves a completed card at 'complete' (terminal, user/LLM-owned)", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "complete", sessionIds: ["s1"] } },
    });
    await applyState(hostWith(vault), "uuid-1", "blocked");
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("complete");
  });

  test("moves an in-progress card to blocked", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });
    await applyState(hostWith(vault), "uuid-1", "blocked");
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("blocked");
  });

  test("unknown conversation id is a no-op (no throw)", async () => {
    const vault = fakeVault({ sessions: {}, cards: {} });
    await expect(applyState(hostWith(vault), "nope", "blocked")).resolves.toBeUndefined();
  });

  // Recovery edge (the PostToolUse hook): after a mid-turn waiting-notification
  // (permission/elicitation prompt) parks the card at blocked, the agent's next
  // tool activity must restore in-progress — otherwise the card is stuck on
  // blocked for the rest of the turn while the agent is actively working.
  test("restores a blocked card to in-progress on resumed tool activity", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "blocked", sessionIds: ["s1"] } },
    });
    await applyState(hostWith(vault), "uuid-1", "in-progress");
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("in-progress");
  });

  // The full reported scenario as a sequence: the agent starts, pauses to ask a
  // question (blocked), then resumes working (PostToolUse). The card must reflect
  // in-progress while that resumed work happens, not stay parked at blocked.
  test("mid-turn elicitation then resumed work ends in-progress", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "planning", sessionIds: ["s1"] } },
    });
    const h = hostWith(vault);
    await applyState(h, "uuid-1", "in-progress"); // UserPromptSubmit
    await applyState(h, "uuid-1", "blocked"); // Notification: elicitation_dialog
    await applyState(h, "uuid-1", "in-progress"); // PostToolUse: work resumed
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("in-progress");
  });

  // A tool firing after the user completes a card must not knock it off complete:
  // the terminal guard still wins over the PostToolUse heartbeat.
  test("PostToolUse activity never revives a completed card", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "complete", sessionIds: ["s1"] } },
    });
    await applyState(hostWith(vault), "uuid-1", "in-progress");
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("complete");
  });
});

// Claude hooks carry the stable orden session id (baked into the hook URL by
// settingsArg); the host uses it to repair a record whose conversationId was lost
// or went stale, so the conversationId-keyed lookups (hook->card, MCP, --resume)
// keep working. The live session_id from the running agent is authoritative.
describe("reconcileConversationId (self-heal a lost/stale conversationId)", () => {
  test("sets conversationId when the record has none", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1", title: "Search box" } } });
    await reconcileConversationId(hostWith(vault), "s1", "uuid-live");
    const ses = await vault.get<{ conversationId?: string; title?: string }>("sessions", "s1");
    expect(ses?.conversationId).toBe("uuid-live");
    expect(ses?.title).toBe("Search box"); // other fields preserved
  });

  test("overwrites a stale conversationId with the live one", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-old", touched: true } },
    });
    await reconcileConversationId(hostWith(vault), "s1", "uuid-live");
    const ses = await vault.get<{ conversationId?: string; touched?: boolean }>("sessions", "s1");
    expect(ses?.conversationId).toBe("uuid-live");
    expect(ses?.touched).toBe(true);
  });

  test("is a no-op when already correct", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1", conversationId: "uuid-live" } } });
    let writes = 0;
    const spy = { ...vault, set: async (...a: Parameters<typeof vault.set>) => (writes++, vault.set(...a)) };
    await reconcileConversationId(hostWith(spy as typeof vault), "s1", "uuid-live");
    expect(writes).toBe(0);
  });

  test("is a no-op for an unknown session", async () => {
    const vault = fakeVault({ sessions: {} });
    await expect(reconcileConversationId(hostWith(vault), "ghost", "uuid")).resolves.toBeUndefined();
    expect(await vault.get("sessions", "ghost")).toBeNull();
  });

  // The end-to-end win: after healing, the conversationId-keyed card lookup that
  // the state hooks use resolves again — so a clobbered session's auto-cycle and
  // resume both recover.
  test("after healing, the conversationId-keyed card lookup resolves", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1" } }, // conversationId lost
      cards: { c1: { id: "c1", title: "T", state: "planning", sessionIds: ["s1"] } },
    });
    const h = hostWith(vault);
    await reconcileConversationId(h, "s1", "uuid-live");
    await applyState(h, "uuid-live", "in-progress"); // keyed on conversationId
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("in-progress");
  });
});

// A "subagent workflow" (the Task tool / background workflows) hands control back
// to the main agent immediately: the main agent's turn ends (Stop fires) while
// the spawned subagents keep working. SubagentStart/SubagentStop both fire
// carrying the PARENT session_id, so the host counts in-flight subagents and
// gates Stop on that depth — a Stop with subagents still running is a background
// turn-end, not a wait-on-you, so the card stays in-progress.
describe("applyStop (subagent-aware Stop gating)", () => {
  const cardState = (v: VaultStore) => v.get<{ state: string }>("cards", "c1");
  const seed = (conv: string) =>
    fakeVault({
      sessions: { s1: { id: "s1", conversationId: conv } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });

  test("with no subagents in flight, Stop blocks the card (unchanged behavior)", async () => {
    const vault = seed("c-none");
    await applyStop(hostWith(vault), "c-none");
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("Stop while a subagent is in flight leaves the card in-progress", async () => {
    const vault = seed("c-bg");
    noteSubagentStart("c-bg");
    await applyStop(hostWith(vault), "c-bg");
    expect((await cardState(vault))?.state).toBe("in-progress");
    resetSubagents("c-bg");
  });

  test("Stop after the subagent finishes blocks the card", async () => {
    const vault = seed("c-seq");
    noteSubagentStart("c-seq");
    noteSubagentStop("c-seq");
    await applyStop(hostWith(vault), "c-seq");
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("parallel subagents: Stop stays gated until the LAST one stops", async () => {
    const vault = seed("c-par");
    noteSubagentStart("c-par");
    noteSubagentStart("c-par");
    noteSubagentStop("c-par");
    await applyStop(hostWith(vault), "c-par"); // one still running
    expect((await cardState(vault))?.state).toBe("in-progress");
    noteSubagentStop("c-par");
    await applyStop(hostWith(vault), "c-par"); // all done
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("noteSubagentStop never drives depth negative", async () => {
    const vault = seed("c-floor");
    noteSubagentStop("c-floor"); // stray stop with no matching start
    await applyStop(hostWith(vault), "c-floor");
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("resetSubagents clears stale depth from a missed SubagentStop", async () => {
    const vault = seed("c-reset");
    noteSubagentStart("c-reset"); // leak: subagent start with no stop
    resetSubagents("c-reset"); // UserPromptSubmit starts a fresh turn
    await applyStop(hostWith(vault), "c-reset");
    expect((await cardState(vault))?.state).toBe("blocked");
  });
});

// The trap: a BACKGROUND subagent workflow ends the main turn (Stop) WHILE the
// subagent runs, and no Stop follows once it finishes. The deferred block must
// fire when the last subagent stops, or the card is stuck at in-progress forever.
describe("deferred block (background subagent turn-end)", () => {
  const cardState = (v: VaultStore) => v.get<{ state: string }>("cards", "c1");
  const seed = (conv: string) =>
    fakeVault({
      sessions: { s1: { id: "s1", conversationId: conv } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });

  test("background: gated Stop is applied when the subagent finishes", async () => {
    const vault = seed("c-defer");
    const h = hostWith(vault);
    noteSubagentStart("c-defer"); // workflow launched
    await applyStop(h, "c-defer"); // main turn ends mid-flight -> deferred
    expect((await cardState(vault))?.state).toBe("in-progress"); // not blocked yet
    noteSubagentStop("c-defer");
    await settleSubagents(h, "c-defer"); // last subagent done -> owed block fires
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("foreground: SubagentStop with no prior Stop does NOT block (main still working)", async () => {
    const vault = seed("c-fg");
    const h = hostWith(vault);
    noteSubagentStart("c-fg");
    noteSubagentStop("c-fg");
    await settleSubagents(h, "c-fg"); // nothing owed
    expect((await cardState(vault))?.state).toBe("in-progress");
    await applyStop(h, "c-fg"); // the real trailing Stop
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("parallel background: deferred block waits for the LAST subagent", async () => {
    const vault = seed("c-pardefer");
    const h = hostWith(vault);
    noteSubagentStart("c-pardefer");
    noteSubagentStart("c-pardefer");
    await applyStop(h, "c-pardefer"); // deferred (depth 2)
    noteSubagentStop("c-pardefer");
    await settleSubagents(h, "c-pardefer"); // depth 1 — still owed
    expect((await cardState(vault))?.state).toBe("in-progress");
    noteSubagentStop("c-pardefer");
    await settleSubagents(h, "c-pardefer"); // depth 0 — fire
    expect((await cardState(vault))?.state).toBe("blocked");
  });

  test("a new user turn cancels a deferred block", async () => {
    const vault = seed("c-cancel");
    const h = hostWith(vault);
    noteSubagentStart("c-cancel");
    await applyStop(h, "c-cancel"); // deferred
    resetSubagents("c-cancel"); // UserPromptSubmit: fresh turn
    noteSubagentStop("c-cancel");
    await settleSubagents(h, "c-cancel"); // nothing owed — old Stop is moot
    expect((await cardState(vault))?.state).toBe("in-progress");
  });
});

describe("isDestructiveGit (shared-checkout guardrail patterns)", () => {
  test("flags the history/worktree-destroying commands", () => {
    for (const cmd of [
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git reset origin/main --hard",
      "git checkout -- .",
      "git checkout .",
      "git clean -f",
      "git clean -fd",
      "git clean -xdf",
      "git stash",
      "git stash push -m wip",
      "cd /repo && git reset --hard",
    ]) {
      expect(isDestructiveGit(cmd), cmd).toBe(true);
    }
  });
  test("leaves ordinary git alone", () => {
    for (const cmd of [
      "git status",
      "git reset --soft HEAD~1",
      "git checkout -b feature",
      "git checkout main",
      "git stash list",
      "git stash pop",
      "git stash apply",
      "git clean -n",
      "git add -A && git commit -m x",
    ]) {
      expect(isDestructiveGit(cmd), cmd).toBe(false);
    }
  });
});

describe("preToolUseVerdict (deny destructive git outside worktrees)", () => {
  const payload = (command: string, tool = "Bash") => ({
    tool_name: tool,
    tool_input: { command },
  });

  test("denies destructive git for a session in a SHARED checkout", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1" } } }); // no workdir
    const v = await preToolUseVerdict(hostWith(vault), "s1", payload("git reset --hard"));
    expect(v).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
  });

  test("allows the same command for a session in its own worktree", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", workdir: "/home/u/.orden/worktrees/p/s1" } },
    });
    const v = await preToolUseVerdict(hostWith(vault), "s1", payload("git reset --hard"));
    expect(v).toEqual({});
  });

  test("allows non-Bash tools and non-destructive commands", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1" } } });
    expect(await preToolUseVerdict(hostWith(vault), "s1", payload("git status"))).toEqual({});
    expect(
      await preToolUseVerdict(hostWith(vault), "s1", payload("git reset --hard", "Edit")),
    ).toEqual({});
  });

  test("allows when the session is unknown (not orden-tracked)", async () => {
    const vault = fakeVault({ sessions: {} });
    expect(await preToolUseVerdict(hostWith(vault), "ghost", payload("git reset --hard"))).toEqual({});
  });
});

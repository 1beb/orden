import { describe, it, expect } from "vitest";
import { fromMarkdown, toMarkdown, journalKey } from "@orden/host-api";
import { fakeVault } from "./fakeVault";
import {
  resolveProject,
  cardGet,
  cardMove,
  cardComplete,
  logCardCompletion,
  cardSetPlan,
  cardCreate,
  cardDelete,
  projectList,
  sessionCreate,
  panelOpen,
} from "../src/tools";
import type { Host, VaultStore } from "@orden/host-api";

const seed = (): VaultStore =>
  fakeVault({
    projects: {
      homeroom: { id: "homeroom", name: "Homeroom", source: "local" },
      proj_alpha: { id: "proj_alpha", name: "Alpha", source: "local" },
    },
    cards: {
      c1: {
        id: "c1",
        title: "Fix login",
        state: "in-progress",
        projectId: "proj_alpha",
        notes: "existing",
        sessionIds: ["s1"],
      },
      c2: { id: "c2", title: "Write docs", state: "planning", projectId: "homeroom", sessionIds: [] },
    },
  });

const out = (r: { content: { text: string }[] }) => r.content[0].text;

describe("resolveProject", () => {
  it("resolves by exact id", async () => {
    expect(await resolveProject(seed(), "proj_alpha")).toBe("proj_alpha");
  });
  it("resolves by name case-insensitive and trimmed", async () => {
    expect(await resolveProject(seed(), "  alpha  ")).toBe("proj_alpha");
  });
  it("throws on unmatched, listing available names", async () => {
    await expect(resolveProject(seed(), "Nope")).rejects.toThrow(
      'unknown project "Nope"; available: Homeroom, Alpha',
    );
  });
  it("defaults to homeroom when nothing given", async () => {
    expect(await resolveProject(seed(), undefined)).toBe("homeroom");
  });
  it("honors a fallback when nothing given", async () => {
    expect(await resolveProject(seed(), undefined, "proj_alpha")).toBe("proj_alpha");
  });
});

describe("cardGet", () => {
  it("returns parsed fields on a hit, with the legacy notes as the log fallback", async () => {
    const parsed = JSON.parse(out(await cardGet(seed(), "Fix login")));
    expect(parsed).toEqual({
      id: "c1",
      title: "Fix login",
      state: "in-progress",
      project: "proj_alpha",
      log: "existing",
    });
  });
  it("prefers the card log page over the legacy notes string", async () => {
    const v = seed();
    await v.set("pages", "card:c1", "- logged line\n");
    const parsed = JSON.parse(out(await cardGet(v, "c1")));
    expect(parsed.log).toBe("- logged line\n");
    expect(parsed).not.toHaveProperty("notes");
  });
  it("includes planDoc when set", async () => {
    const v = seed();
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    await v.set("cards", "c1", { ...card, planDoc: "docs/plans/x.md" });
    const parsed = JSON.parse(out(await cardGet(v, "c1")));
    expect(parsed.planDoc).toBe("docs/plans/x.md");
  });
  it("includes description when set", async () => {
    const v = seed();
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    await v.set("cards", "c1", { ...card, description: "It fails twice a day." });
    const parsed = JSON.parse(out(await cardGet(v, "c1")));
    expect(parsed.description).toBe("It fails twice a day.");
  });
  it("reports a miss with closest candidates", async () => {
    expect(out(await cardGet(seed(), "log"))).toBe('no card matches "log"; closest: Fix login');
  });
  it("reports a miss with no candidates", async () => {
    expect(out(await cardGet(seed(), "zzz"))).toBe('no card matches "zzz"');
  });
});

describe("cardMove", () => {
  it("patches state, keeping title and sessionIds", async () => {
    const v = seed();
    const r = await cardMove(v, "c1", "blocked");
    expect(out(r)).toBe('card "Fix login" -> blocked');
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.state).toBe("blocked");
    expect(card?.title).toBe("Fix login");
    expect(card?.sessionIds).toEqual(["s1"]);
  });
  it("appends a note under the Automatic Logging section (not card.notes)", async () => {
    const v = seed();
    await cardMove(v, "c1", "blocked", "waiting on review");
    const log = await v.get<string>("pages", "card:c1");
    expect(log).toMatch(/^- Automatic Logging\n  - \d\d:\d\d blocked: waiting on review\n$/);
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.notes).toBe("existing"); // untouched legacy field
  });
  it("files repeated notes as siblings under one Automatic Logging section", async () => {
    const v = seed();
    await cardMove(v, "c1", "in-progress", "starting");
    await cardMove(v, "c1", "blocked", "stuck");
    const log = await v.get<string>("pages", "card:c1");
    expect((log!.match(/^- Automatic Logging$/gm) ?? []).length).toBe(1);
    expect(log).toMatch(/  - \d\d:\d\d in-progress: starting\n  - \d\d:\d\d blocked: stuck\n$/);
  });
  it("keeps one section after the outliner collapses it between writes", async () => {
    const v = seed();
    await cardMove(v, "c1", "in-progress", "starting");
    // Simulate the journal/outliner round-trip that collapses the log section:
    // the bullet comes back as "- Automatic Logging collapsed:: true".
    const root = fromMarkdown((await v.get<string>("pages", "card:c1"))!);
    for (const b of root.children) if (b.text === "Automatic Logging") b.collapsed = true;
    await v.set("pages", "card:c1", toMarkdown(root));
    await cardMove(v, "c1", "blocked", "stuck");
    const log = await v.get<string>("pages", "card:c1");
    expect((log!.match(/^- Automatic Logging\b/gm) ?? []).length).toBe(1);
  });
  it("heals a page already split into two sections, folding into one in order", async () => {
    const v = seed();
    // A page damaged before the fix: two separate Automatic Logging sections.
    await v.set(
      "pages",
      "card:c1",
      "- Automatic Logging collapsed:: true\n  - 09:00 in-progress: starting\n" +
        "- Automatic Logging\n  - 11:00 blocked: stuck\n",
    );
    await cardMove(v, "c1", "in-progress", "back on it");
    const log = await v.get<string>("pages", "card:c1");
    expect((log!.match(/^- Automatic Logging\b/gm) ?? []).length).toBe(1);
    // First header (with its collapsed marker) survives; children stay in order,
    // new entry appended last.
    expect(log).toMatch(
      /^- Automatic Logging collapsed:: true\n  - 09:00 in-progress: starting\n  - 11:00 blocked: stuck\n  - \d\d:\d\d in-progress: back on it\n$/,
    );
  });
  it("reuses an existing section written with * bullets instead of -", async () => {
    const v = seed();
    // Legacy/external content can use the `*` bullet marker (the outliner parser
    // accepts both). The auto-log code must recognize it as the same section and
    // not spawn a parallel `- Automatic Logging`.
    await v.set(
      "pages",
      "card:c1",
      "* Automatic Logging\n  * 09:00 in-progress: starting\n",
    );
    await cardMove(v, "c1", "blocked", "stuck");
    const log = await v.get<string>("pages", "card:c1");
    expect((log!.match(/^[-*] Automatic Logging\b/gm) ?? []).length).toBe(1);
    expect(log).toMatch(/  - \d\d:\d\d blocked: stuck\n$/);
  });
  it("does not write a log line when no note is given", async () => {
    const v = seed();
    await cardMove(v, "c1", "blocked");
    expect(await v.get("pages", "card:c1")).toBeNull();
  });
  it("reports a miss", async () => {
    expect(out(await cardMove(seed(), "zzz", "blocked"))).toBe('no card matches "zzz"');
  });
});

describe("cardComplete", () => {
  // Mirror production's default-zone resolution (host's own zone, no override),
  // not UTC — otherwise this drifts a day from the entry's page in the evening
  // window where UTC and local land on different dates.
  const todayKey = () => journalKey(new Date());

  it("reaches complete", async () => {
    const v = seed();
    expect(out(await cardComplete(v, "c2"))).toBe('card "Write docs" -> complete');
    const card = await v.get<Record<string, unknown>>("cards", "c2");
    expect(card?.state).toBe("complete");
    expect(typeof card?.completedAt).toBe("number");
  });
  it("appends a Completed line with the summary under Automatic Logging", async () => {
    const v = seed();
    await cardComplete(v, "c1", "  shipped the fix  ");
    const log = await v.get<string>("pages", "card:c1");
    expect(log).toMatch(/^- Automatic Logging\n  - \d\d:\d\d Completed — shipped the fix\n$/);
  });
  it("writes a journal entry under Automatic Logging, linking the project", async () => {
    const v = seed();
    await cardComplete(v, "c1", "shipped the fix");
    const journal = await v.get<string>("journal", todayKey());
    expect(journal).toContain("- Automatic Logging\n");
    // The entry is a second-level (indented) child of the section.
    expect(journal).toMatch(/^  - \d\d:\d\d Completed "Fix login" — shipped the fix \[\[Project: Alpha\]\] \[\[Session: s1\]\]$/m);
  });
  it("includes the plan suffix when the card has a planDoc", async () => {
    const v = seed();
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    await v.set("cards", "c1", { ...card, planDoc: "docs/plans/p.md" });
    await cardComplete(v, "c1", "done");
    const journal = await v.get<string>("journal", todayKey());
    expect(journal).toContain("· plan: docs/plans/p.md");
  });
  it("works with no summary and creates the journal page", async () => {
    const v = seed();
    await cardComplete(v, "c2");
    const journal = await v.get<string>("journal", todayKey());
    expect(journal).toContain('Completed "Write docs"');
    expect(journal).not.toContain("—");
  });
  it("files the journal entry under the day of the settings timeZone override", async () => {
    const v = seed();
    // Kiritimati (UTC+14) is the most extreme zone: it is reliably a day ahead
    // of any host zone, so the override demonstrably moves the page off the
    // host-default day no matter where the test runs.
    await v.set("settings", "app", { timeZone: "Pacific/Kiritimati" });
    await cardComplete(v, "c1", "shipped");
    const now = new Date();
    const overrideKey = journalKey(now, "Pacific/Kiritimati");
    const journal = await v.get<string>("journal", overrideKey);
    expect(journal).toContain('Completed "Fix login"');
    // And nothing was written under the host-default day (unless they coincide).
    if (overrideKey !== journalKey(now)) {
      expect(await v.get("journal", journalKey(now))).toBeNull();
    }
  });
  it("preserves the user's top-level entries, nesting auto entries below", async () => {
    const v = seed();
    await v.set("journal", todayKey(), "- earlier entry\n");
    await cardComplete(v, "c1", "later");
    const journal = await v.get<string>("journal", todayKey());
    // User's flush-left line is untouched; the auto entry is a nested child of
    // a new Automatic Logging section appended after it.
    expect(journal).toMatch(
      /^- earlier entry\n- Automatic Logging\n  - \d\d:\d\d Completed "Fix login" — later \[\[Project: Alpha\]\] \[\[Session: s1\]\]\n$/,
    );
  });
  // --- publish gate (worktree isolation) -----------------------------------

  const publishOf = (results: Record<string, import("@orden/host-api").PublishResult>) => {
    const calls: string[] = [];
    return {
      calls,
      publish: async (sessionId: string) => {
        calls.push(sessionId);
        return results[sessionId] ?? { state: "no-worktree" as const };
      },
    };
  };

  it("completes exactly as today when no publish hook is wired (standalone)", async () => {
    const v = seed();
    expect(out(await cardComplete(v, "c1", "done"))).toBe('card "Fix login" -> complete');
    expect((await v.get<Record<string, unknown>>("cards", "c1"))?.state).toBe("complete");
  });

  it("refuses to complete when a session worktree is dirty (no force)", async () => {
    const v = seed();
    const { publish } = publishOf({ s1: { state: "dirty", branch: "orden/fix-login" } });
    const t = out(await cardComplete(v, "c1", "done", { publish }));
    expect(t).toContain("uncommitted changes");
    expect(t).toContain("orden/fix-login");
    expect((await v.get<Record<string, unknown>>("cards", "c1"))?.state).toBe("in-progress");
  });

  it("force completes past a dirty worktree, stamping the publish state", async () => {
    const v = seed();
    const { publish } = publishOf({ s1: { state: "dirty", branch: "orden/fix-login" } });
    const t = out(await cardComplete(v, "c1", "done", { publish, force: true }));
    expect(t).toContain("-> complete");
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.state).toBe("complete");
    expect(card?.publishState).toBe("dirty");
    expect(card?.branch).toBe("orden/fix-login");
  });

  it("stamps branch + PR url on the card when publish opens a PR", async () => {
    const v = seed();
    const { publish, calls } = publishOf({
      s1: {
        state: "pr-opened",
        branch: "orden/fix-login",
        prUrl: "https://github.com/x/y/pull/7",
      },
    });
    const t = out(await cardComplete(v, "c1", "done", { publish }));
    expect(calls).toEqual(["s1"]);
    expect(t).toContain("https://github.com/x/y/pull/7");
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.state).toBe("complete");
    expect(card?.publishState).toBe("pr-opened");
    expect(card?.prUrl).toBe("https://github.com/x/y/pull/7");
  });

  it("a no-worktree session completes silently (nothing to publish)", async () => {
    const v = seed();
    const { publish } = publishOf({ s1: { state: "no-worktree" } });
    const t = out(await cardComplete(v, "c1", "done", { publish }));
    expect(t).toBe('card "Fix login" -> complete');
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.publishState).toBeUndefined();
  });

  it("does not write a duplicate journal/card-log entry when completion is logged twice", async () => {
    // Reproduces the double-write seen in the field: a single completion that
    // gets logged twice (e.g. an MCP double-dispatch, or the direct call plus
    // the host reactor both firing). The two writes are byte-identical, so the
    // append must collapse them to one.
    const v = seed();
    await cardComplete(v, "c1", "shipped");
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    // Re-log the *same* completion (same completedAt → same timestamp/entry).
    await logCardCompletion(v, card as never);
    const journal = await v.get<string>("journal", todayKey());
    expect((journal!.match(/Completed "Fix login"/g) ?? []).length).toBe(1);
    const log = await v.get<string>("pages", "card:c1");
    expect((log!.match(/Completed/g) ?? []).length).toBe(1);
  });
});

describe("logCardCompletion", () => {
  // A fixed completion instant so the entry is deterministic regardless of when
  // the test runs (2026-06-05T20:09:32Z).
  const AT = 1780690172706;
  it("writes the journal entry off the card's own completedAt, not now", async () => {
    const v = seed();
    const card = {
      ...(await v.get<Record<string, unknown>>("cards", "c1")),
      state: "complete",
      completedAt: AT,
      completionSummary: "shipped",
    };
    await logCardCompletion(v, card as never);
    const day = journalKey(new Date(AT));
    const journal = await v.get<string>("journal", day);
    expect(journal).toContain('Completed "Fix login" — shipped [[Project: Alpha]] [[Session: s1]]');
  });
  it("logs a card completed without a summary (the web-UI path)", async () => {
    const v = seed();
    const card = {
      ...(await v.get<Record<string, unknown>>("cards", "c2")),
      state: "complete",
      completedAt: AT,
    };
    await logCardCompletion(v, card as never);
    const journal = await v.get<string>("journal", journalKey(new Date(AT)));
    expect(journal).toContain('Completed "Write docs"');
    expect(journal).not.toContain("—");
  });
});

// cardSetPlan needs a host with a files source; build a minimal fake over a vault.
function hostWith(vault: VaultStore, files: Record<string, string>): Host {
  return {
    vault,
    files: {
      async read(_projectId: string, path: string) {
        if (path in files) return files[path];
        throw new Error("ENOENT");
      },
      async list() {
        return [];
      },
      async write() {},
    },
  } as unknown as Host;
}

describe("cardSetPlan", () => {
  it("sets planDoc when the file exists under docs/plans/", async () => {
    const v = seed();
    const host = hostWith(v, { "docs/plans/good.md": "# plan" });
    const r = await cardSetPlan(host, "c1", "docs/plans/good.md");
    expect(out(r)).toBe('card "Fix login" plan -> docs/plans/good.md');
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card?.planDoc).toBe("docs/plans/good.md");
  });
  it("rejects a path outside docs/plans/", async () => {
    const v = seed();
    const host = hostWith(v, { "src/foo.md": "x" });
    const r = await cardSetPlan(host, "c1", "src/foo.md");
    expect(out(r)).toContain("must be under docs/plans/");
    const card = await v.get<Record<string, unknown>>("cards", "c1");
    expect(card).not.toHaveProperty("planDoc");
  });
  it("rejects a missing file", async () => {
    const v = seed();
    const host = hostWith(v, {});
    const r = await cardSetPlan(host, "c1", "docs/plans/missing.md");
    expect(out(r)).toBe("plan file not found: docs/plans/missing.md");
  });
  it("reports a card miss", async () => {
    const v = seed();
    const host = hostWith(v, {});
    expect(out(await cardSetPlan(host, "zzz", "docs/plans/x.md"))).toBe('no card matches "zzz"');
  });
});

describe("cardCreate", () => {
  it("lands in planning with an item_ id and resolved project", async () => {
    const v = seed();
    const r = await cardCreate(v, "  New task  ", "Alpha", "some notes");
    const m = out(r).match(/created card "New task" in planning \((item_[^)]+)\)/);
    expect(m).not.toBeNull();
    const id = m![1];
    const card = await v.get<Record<string, unknown>>("cards", id);
    expect(card).toMatchObject({
      title: "New task",
      state: "planning",
      projectId: "proj_alpha",
      sessionIds: [],
    });
    expect(card).not.toHaveProperty("notes");
    // Opening notes seed the card log page, not a card.notes field.
    expect(await v.get<string>("pages", `card:${id}`)).toBe("some notes\n");
  });
  it("stores a description when given", async () => {
    const v = seed();
    const r = await cardCreate(v, "New task", "Alpha", undefined, "It fails twice a day.");
    const id = out(r).match(/\((item_[^)]+)\)/)![1];
    const card = await v.get<Record<string, unknown>>("cards", id);
    expect(card?.description).toBe("It fails twice a day.");
  });
  it("returns the error text on unknown project", async () => {
    expect(out(await cardCreate(seed(), "x", "Nope"))).toBe(
      'unknown project "Nope"; available: Homeroom, Alpha',
    );
  });
});

describe("cardDelete", () => {
  it("deletes by id and reports the linked sessions left intact", async () => {
    const v = seed();
    const r = await cardDelete(v, "c1");
    expect(out(r)).toBe('deleted card "Fix login" (c1); linked sessions left intact: s1');
    expect(await v.get("cards", "c1")).toBeNull();
  });
  it("deletes by title (case-insensitive, trimmed), omitting the session suffix when none", async () => {
    const v = seed();
    const r = await cardDelete(v, "  write docs  ");
    expect(out(r)).toBe('deleted card "Write docs" (c2)');
    expect(await v.get("cards", "c2")).toBeNull();
  });
  it("leaves the linked session records untouched", async () => {
    const v = seed();
    await v.set("sessions", "s1", { id: "s1", title: "Sess", projectId: "proj_alpha" });
    await cardDelete(v, "c1");
    expect(await v.get("cards", "c1")).toBeNull();
    expect(await v.get<Record<string, unknown>>("sessions", "s1")).toMatchObject({
      id: "s1",
      title: "Sess",
      projectId: "proj_alpha",
    });
  });
  it("requires an explicit target", async () => {
    expect(out(await cardDelete(seed(), "   "))).toBe(
      "card_delete requires an explicit card id or title",
    );
  });
  it("reports a miss with closest candidates", async () => {
    expect(out(await cardDelete(seed(), "login"))).toBe(
      'no card matches "login"; closest: Fix login',
    );
  });
  it("reports a miss with no candidates", async () => {
    expect(out(await cardDelete(seed(), "zzz"))).toBe('no card matches "zzz"');
  });
  it("refuses an ambiguous title, listing the matching ids, and deletes nothing", async () => {
    const v = seed();
    await v.set("cards", "c3", { id: "c3", title: "Fix login", state: "planning", sessionIds: [] });
    const r = await cardDelete(v, "Fix login");
    expect(out(r)).toBe('"Fix login" matches 2 cards (c1, c3); pass a card id');
    expect(await v.get("cards", "c1")).not.toBeNull();
    expect(await v.get("cards", "c3")).not.toBeNull();
  });
});

describe("projectList", () => {
  it("sorts by name", async () => {
    expect(out(await projectList(seed()))).toBe("proj_alpha  Alpha\nhomeroom  Homeroom");
  });
  it("reports empty", async () => {
    expect(out(await projectList(fakeVault()))).toBe("(no projects)");
  });
});

describe("sessionCreate", () => {
  it("writes a sess_ session and a linked planning card", async () => {
    const v = seed();
    const r = await sessionCreate(v, {
      title: "Investigate bug",
      projectIdOrName: "Alpha",
      prompt: "  look into it  ",
    });
    const m = out(r).match(
      /created session "Investigate bug" \+ planning card \(launching\) \((sess_[^)]+)\)/,
    );
    expect(m).not.toBeNull();
    const sessionId = m![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session).toMatchObject({
      id: sessionId,
      title: "Investigate bug",
      agent: "claude",
      projectId: "proj_alpha",
      initialPrompt: "look into it",
    });
    const cardIds = await v.list("cards");
    const cards = await Promise.all(
      cardIds.map((id) => v.get<Record<string, unknown>>("cards", id)),
    );
    const linked = cards.find((c) => (c?.sessionIds as string[])?.includes(sessionId));
    expect(linked).toMatchObject({
      title: "Investigate bug",
      state: "planning",
      projectId: "proj_alpha",
    });
    expect((linked?.id as string).startsWith("item_")).toBe(true);
  });
  it("defaults agent and title, omits empty prompt", async () => {
    const v = seed();
    const r = await sessionCreate(v, { title: "   " });
    const sessionId = out(r).match(/\((sess_[^)]+)\)/)![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session).toMatchObject({ title: "Untitled session", agent: "claude", projectId: "homeroom" });
    expect(session).not.toHaveProperty("initialPrompt");
  });
  it("returns error text on unknown project", async () => {
    expect(out(await sessionCreate(seed(), { title: "x", projectIdOrName: "Nope" }))).toBe(
      'unknown project "Nope"; available: Homeroom, Alpha',
    );
  });

  it("flags the session pendingLaunch when auto-launch is on", async () => {
    const v = fakeVault({
      projects: { homeroom: { id: "homeroom", name: "Homeroom", source: "local" } },
      settings: { app: { sessionAutoLaunch: true } },
    });
    const r = await sessionCreate(v, { title: "Go" });
    expect(out(r)).toMatch(/created session "Go" \+ planning card \(launching\) \(sess_[^)]+\)/);
    const sessionId = out(r).match(/\((sess_[^)]+)\)/)![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session?.pendingLaunch).toBe(true);
  });

  it("flags the session pendingLaunch when no setting is present (default on)", async () => {
    const v = seed();
    const r = await sessionCreate(v, { title: "Go" });
    const sessionId = out(r).match(/\((sess_[^)]+)\)/)![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session?.pendingLaunch).toBe(true);
  });

  it("does not flag pendingLaunch when auto-launch is off", async () => {
    const v = fakeVault({
      projects: { homeroom: { id: "homeroom", name: "Homeroom", source: "local" } },
      settings: { app: { sessionAutoLaunch: false } },
    });
    const r = await sessionCreate(v, { title: "Go" });
    expect(out(r)).toMatch(/created session "Go" \+ planning card \(sess_[^)]+\)/);
    const sessionId = out(r).match(/\((sess_[^)]+)\)/)![1];
    const session = await v.get<Record<string, unknown>>("sessions", sessionId);
    expect(session?.pendingLaunch).toBeFalsy();
  });
});

describe("panelOpen", () => {
  it("writes a panel-intent with kind/target and a nonce", async () => {
    const v = seed();
    const r = await panelOpen(v, "card", "c1");
    expect(out(r)).toBe("opened card in panel: c1");
    const intent = await v.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent).toMatchObject({ kind: "card", target: "c1" });
    expect(typeof intent?.nonce).toBe("string");
    expect((intent?.nonce as string).length).toBeGreaterThan(0);
  });
  it("handles kanban with no target", async () => {
    const v = seed();
    expect(out(await panelOpen(v, "kanban", ""))).toBe("opened kanban in panel");
    const intent = await v.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent).toMatchObject({ kind: "kanban", target: "" });
  });
  it("uses a fresh nonce so repeat opens of the same target still differ", async () => {
    const v = seed();
    await panelOpen(v, "card", "c1");
    const first = (await v.get<Record<string, unknown>>("ui", "panel-intent"))?.nonce;
    await panelOpen(v, "card", "c1");
    const second = (await v.get<Record<string, unknown>>("ui", "panel-intent"))?.nonce;
    expect(second).not.toBe(first);
  });
  it("carries a projectId (session worktree root) when given", async () => {
    const v = seed();
    await panelOpen(v, "doc", "docs/report.html", "session:s1");
    const intent = await v.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent).toMatchObject({
      kind: "doc",
      target: "docs/report.html",
      projectId: "session:s1",
    });
  });
  it("omits projectId when not given", async () => {
    const v = seed();
    await panelOpen(v, "doc", "docs/report.html");
    const intent = await v.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent && "projectId" in intent).toBe(false);
  });
});

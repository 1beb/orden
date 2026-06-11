import { describe, test, expect, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

// Under vitest's worker pool os.homedir() is pinned to the real home and ignores
// a runtime $HOME change, and node:os exports are non-configurable so vi.spyOn
// can't patch homedir(). Mock the module instead, with a hoisted mutable holder
// the buildCommand tests point at a throwaway home (empty = real homedir).
const osHome = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.dir || actual.homedir() };
});
import {
  mcpConfigArg,
  settingsArg,
  launchDetached,
  opencodeEnv,
  resolveSessionCwd,
  resolveAgentBin,
  buildCommand,
  killSessionTmux,
} from "../src/terminal";
import { encodeCwd } from "../src/transcriptTitle";
import type { Host, Project } from "@orden/host-api";

// A host whose vault returns the given project records (ns "projects"), plus an
// optional settings record and vaultRoot capability — enough to drive
// resolveSessionCwd (including its worktree branch) without real storage.
// Session writes are captured in `written` for assertions.
function hostWithProjects(
  projects: Record<string, Project>,
  opts: { settings?: Record<string, unknown>; vaultRoot?: string } = {},
): Host & { written: Record<string, unknown> } {
  const written: Record<string, unknown> = {};
  return {
    written,
    vault: {
      get: async (ns: string, key: string) => {
        if (ns === "projects") return projects[key] ?? null;
        if (ns === "settings" && key === "app") return opts.settings ?? null;
        return null;
      },
      set: async (ns: string, key: string, value: unknown) => {
        written[`${ns}/${key}`] = value;
      },
      list: async () => [],
      delete: async () => {},
    },
    capabilities: () => ({ vaultRoot: opts.vaultRoot }),
  } as unknown as Host & { written: Record<string, unknown> };
}

// Minimal session record for resolveSessionCwd.
function recFor(projectId: string | undefined, extra: Record<string, unknown> = {}) {
  return { id: "s1", agent: "claude" as const, projectId: projectId as string, ...extra };
}

const ORIGINAL_PORT = process.env.ORDEN_PORT;
afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.ORDEN_PORT;
  else process.env.ORDEN_PORT = ORIGINAL_PORT;
});

// Parse the JSON back out of the `--mcp-config '<json>'` fragment.
function parseConfig(arg: string): { mcpServers: Record<string, { type: string; url: string }> } {
  const m = arg.match(/^--mcp-config '(.*)'$/s);
  if (!m) throw new Error(`unexpected fragment: ${arg}`);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

describe("mcpConfigArg", () => {
  test("binds an 'orden' http server to the session-scoped /mcp/<convId> path", () => {
    delete process.env.ORDEN_PORT;
    const arg = mcpConfigArg("conv-123");
    expect(arg.startsWith("--mcp-config ")).toBe(true);
    const cfg = parseConfig(arg);
    expect(cfg.mcpServers.orden).toEqual({
      type: "http",
      url: "http://127.0.0.1:4319/mcp/conv-123",
    });
  });

  test("uses ORDEN_PORT when set", () => {
    process.env.ORDEN_PORT = "5555";
    const cfg = parseConfig(mcpConfigArg("abc"));
    expect(cfg.mcpServers.orden.url).toBe("http://127.0.0.1:5555/mcp/abc");
  });
});

// Reverse shquote's single-quote escaping (`'` -> `'\''`) to recover the inline
// JSON. settingsArg's curl commands contain single quotes (around the URL), so
// this exercises the escaping path mcpConfigArg's quote-free JSON never hits.
function parseSettings(arg: string): {
  hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
} {
  const m = arg.match(/^--settings '(.*)'$/s);
  if (!m) throw new Error(`unexpected fragment: ${arg}`);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

describe("settingsArg", () => {
  test("injects the kanban state + subagent-tracking hooks, port-templated", () => {
    delete process.env.ORDEN_PORT;
    const arg = settingsArg("sess_test");
    expect(arg.startsWith("--settings ")).toBe(true);
    const s = parseSettings(arg);
    // The state edges that drive the automatic working/waiting cycle, plus the
    // SubagentStart/Stop pair that gates Stop on in-flight background work.
    expect(Object.keys(s.hooks).sort()).toEqual(
      [
        "Notification",
        "PostToolUse",
        "PreToolUse",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    const cmdOf = (e: string) => s.hooks[e][0].hooks[0].command;
    expect(cmdOf("UserPromptSubmit")).toContain("/hooks/session-state?state=in-progress");
    expect(cmdOf("PostToolUse")).toContain("/hooks/session-state?state=in-progress");
    expect(cmdOf("Stop")).toContain("/hooks/session-state?state=blocked");
    expect(cmdOf("SubagentStart")).toContain("/hooks/session-subagent?delta=start");
    expect(cmdOf("SubagentStop")).toContain("/hooks/session-subagent?delta=stop");
    expect(cmdOf("Notification")).toContain("/hooks/notification");
    expect(cmdOf("Stop")).toContain("http://127.0.0.1:4319/");
  });

  test("uses ORDEN_PORT when set", () => {
    process.env.ORDEN_PORT = "5555";
    const s = parseSettings(settingsArg("sess_test"));
    expect(s.hooks.PostToolUse[0].hooks[0].command).toContain("http://127.0.0.1:5555/");
  });

  // The stable orden session id rides every hook URL so the host can self-heal a
  // record whose conversationId was lost (claude's payload carries only its own
  // session_id). The query separator must adapt: state hooks already have `?`.
  test("bakes the orden session id into every hook URL", () => {
    delete process.env.ORDEN_PORT;
    const s = parseSettings(settingsArg("sess_abc"));
    const cmdOf = (e: string) => s.hooks[e][0].hooks[0].command;
    expect(cmdOf("UserPromptSubmit")).toContain(
      "/hooks/session-state?state=in-progress&orden_session_id=sess_abc",
    );
    expect(cmdOf("Stop")).toContain(
      "/hooks/session-state?state=blocked&orden_session_id=sess_abc",
    );
    // The notification hook has no prior query string, so it joins with `?`.
    expect(cmdOf("Notification")).toContain("/hooks/notification?orden_session_id=sess_abc");
  });

  // The destructive-git guardrail: Bash-matched, and — unlike the
  // fire-and-forget state hooks — its curl must KEEP stdout, because the
  // response body is the PreToolUse allow/deny verdict claude reads.
  test("wires the PreToolUse guard to Bash and keeps curl stdout", () => {
    delete process.env.ORDEN_PORT;
    const s = parseSettings(settingsArg("sess_abc")) as unknown as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
    };
    const entry = s.hooks.PreToolUse[0];
    expect(entry.matcher).toBe("Bash");
    const cmd = entry.hooks[0].command;
    expect(cmd).toContain("/hooks/pretooluse?orden_session_id=sess_abc");
    // stdout is the verdict — only stderr may be discarded (the state hooks
    // use `>/dev/null 2>&1`, which would swallow the decision).
    expect(cmd).not.toContain(">/dev/null 2>&1");
    expect(cmd).toContain("2>/dev/null");
  });
});

describe("opencodeEnv worktree flag + plugin guard", () => {
  test("marks the env with ORDEN_WORKTREE and writes the guard into the plugin", () => {
    const tmp = mkdtempSync(join(tmpdir(), "orden-oc-"));
    osHome.dir = tmp; // ensureOpencodePluginDir writes under homedir()
    try {
      const inWt = opencodeEnv({ agent: "opencode" }, "sess_oc", true);
      expect(inWt.env.ORDEN_WORKTREE).toBe("1");
      expect(inWt.cmdPrefix).toContain("ORDEN_WORKTREE=1");
      const shared = opencodeEnv({ agent: "opencode" }, "sess_oc", false);
      expect(shared.env.ORDEN_WORKTREE).toBe("0");
      // The generated plugin carries the destructive-git guard, gated on the env.
      const plugin = readFileSync(
        join(tmp, ".orden", "opencode-plugins", "sess_oc", "plugins", "orden-kanban.js"),
        "utf8",
      );
      expect(plugin).toContain("tool.execute.before");
      expect(plugin).toContain('process.env.ORDEN_WORKTREE === "1"');
      expect(plugin).toContain("reset\\s+");
      expect(plugin).toContain("destructive git is blocked");
    } finally {
      osHome.dir = "";
    }
  });
});

describe("resolveSessionCwd", () => {
  const DEFAULT = "/host/default";
  // Worktree creation off (isolation disabled) keeps these focused on the
  // project-path resolution rules; isolation cases have their own describe.
  const NO_ISO = { settings: { worktreeIsolation: false } };

  test("uses a local project's own path", async () => {
    const dir = tmpdir(); // a real directory, so the existence guard passes
    const host = hostWithProjects(
      { p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } } },
      NO_ISO,
    );
    expect(await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT)).toBe(dir);
  });

  test("falls back to defaultCwd for an ephemeral project", async () => {
    const host = hostWithProjects({
      p1: { id: "p1", name: "Homeroom", source: { kind: "ephemeral" } },
    });
    expect(await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT)).toBe(DEFAULT);
  });

  test("falls back to defaultCwd for an ssh project (no local folder yet)", async () => {
    const host = hostWithProjects({
      p1: { id: "p1", name: "Box", source: { kind: "ssh", host: "h", path: "/srv" } },
    });
    expect(await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT)).toBe(DEFAULT);
  });

  test("falls back when the project is unknown or projectId is missing", async () => {
    const host = hostWithProjects({});
    expect(await resolveSessionCwd(host, recFor("nope"), "s1", DEFAULT)).toBe(DEFAULT);
    expect(await resolveSessionCwd(host, recFor(undefined), "s1", DEFAULT)).toBe(DEFAULT);
  });

  test("falls back when a local path does not exist", async () => {
    const host = hostWithProjects({
      p1: {
        id: "p1",
        name: "Gone",
        source: { kind: "local", path: "/no/such/orden/dir/xyz" },
      },
    });
    expect(await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT)).toBe(DEFAULT);
  });
});

describe("resolveSessionCwd worktree isolation", () => {
  const DEFAULT = "/host/default";

  // A git-positive exec that records worktree adds and reports branches free.
  function gitExec(calls: string[][]) {
    return (cwd: string, args: string[]) => {
      calls.push([cwd, ...args]);
      if (args.includes("--is-inside-work-tree"))
        return Promise.resolve({ stdout: "true\n", code: 0 });
      if (args[0] === "symbolic-ref") return Promise.resolve({ stdout: "origin/main\n", code: 0 });
      if (args[0] === "worktree") return Promise.resolve({ stdout: "", code: 0 });
      return Promise.resolve({ stdout: "", code: 1 });
    };
  }

  test("creates a worktree for a local git project and persists workdir+branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const vaultRoot = join(dir, "vault");
    const host = hostWithProjects(
      { p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } } },
      { vaultRoot },
    );
    const calls: string[][] = [];
    const rec = recFor("p1", { title: "Fix It" });
    const cwd = await resolveSessionCwd(host, rec, "s1", DEFAULT, { launch: true, exec: gitExec(calls) });
    expect(cwd).toBe(join(vaultRoot, "..", "worktrees", "p1", "s1"));
    const persisted = host.written["sessions/s1"] as { workdir?: string; branch?: string };
    expect(persisted.workdir).toBe(cwd);
    expect(persisted.branch).toBe("orden/fix-it");
  });

  test("global setting off keeps the project path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const host = hostWithProjects(
      { p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } } },
      { vaultRoot: join(dir, "vault"), settings: { worktreeIsolation: false } },
    );
    const calls: string[][] = [];
    const cwd = await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT, { launch: true, exec: gitExec(calls) });
    expect(cwd).toBe(dir);
    expect(calls.length).toBe(0);
  });

  test("project override off beats global on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const host = hostWithProjects(
      {
        p1: {
          id: "p1", name: "Repo", source: { kind: "local", path: dir }, worktreeIsolation: false,
        },
      },
      { vaultRoot: join(dir, "vault"), settings: { worktreeIsolation: true } },
    );
    const cwd = await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT, { launch: true, exec: gitExec([]) });
    expect(cwd).toBe(dir);
  });

  test("an existing workdir on the record is reused as-is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const existing = join(dir, "wt");
    mkdirSync(existing);
    const host = hostWithProjects(
      { p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } } },
      { vaultRoot: join(dir, "vault") },
    );
    const calls: string[][] = [];
    const cwd = await resolveSessionCwd(host, recFor("p1", { workdir: existing }), "s1", DEFAULT, {
      launch: true,
      exec: gitExec(calls),
    });
    expect(cwd).toBe(existing);
    expect(calls.length).toBe(0);
    expect(host.written["sessions/s1"]).toBeUndefined(); // nothing changed
  });

  // A reaped worktree recreated at the SAME path gets a NEW branch (the old
  // one still exists, so pickBranch suffixes it). The path being unchanged must
  // not skip the persist — otherwise the record keeps naming the old (often
  // already-merged) branch and a later publish pushes the wrong one.
  test("recreating a reaped worktree persists the new branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const vaultRoot = join(dir, "vault");
    const host = hostWithProjects(
      { p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } } },
      { vaultRoot },
    );
    const workdir = join(vaultRoot, "..", "worktrees", "p1", "s1"); // does NOT exist on disk
    // First probe (the un-suffixed branch) reports taken; the -2 probe is free.
    const exec = (cwd: string, args: string[]) => {
      if (args.includes("--is-inside-work-tree")) return Promise.resolve({ stdout: "true\n", code: 0 });
      if (args[0] === "symbolic-ref") return Promise.resolve({ stdout: "origin/main\n", code: 0 });
      if (args[0] === "rev-parse" && args.includes("refs/heads/orden/fix-it"))
        return Promise.resolve({ stdout: "abc123\n", code: 0 });
      if (args[0] === "worktree") return Promise.resolve({ stdout: "", code: 0 });
      return Promise.resolve({ stdout: "", code: 1 });
    };
    const rec = recFor("p1", { title: "Fix It", workdir, branch: "orden/fix-it" });
    const cwd = await resolveSessionCwd(host, rec, "s1", DEFAULT, { launch: true, exec });
    expect(cwd).toBe(workdir);
    const persisted = host.written["sessions/s1"] as { workdir?: string; branch?: string };
    expect(persisted).toBeDefined();
    expect(persisted.workdir).toBe(workdir);
    expect(persisted.branch).toBe("orden/fix-it-2");
  });

  test("a non-git project dir falls back to the project path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const host = hostWithProjects(
      { p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } } },
      { vaultRoot: join(dir, "vault") },
    );
    const noGit = (_cwd: string, _args: string[]) => Promise.resolve({ stdout: "", code: 128 });
    const cwd = await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT, { launch: true, exec: noGit });
    expect(cwd).toBe(dir);
  });

  test("no vaultRoot capability keeps the project path (browser-style host)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-iso-"));
    const host = hostWithProjects({
      p1: { id: "p1", name: "Repo", source: { kind: "local", path: dir } },
    });
    const cwd = await resolveSessionCwd(host, recFor("p1"), "s1", DEFAULT, { launch: true, exec: gitExec([]) });
    expect(cwd).toBe(dir);
  });
});

describe("resolveAgentBin", () => {
  const ORIGINAL_PATH = process.env.PATH;
  const ORIGINAL_HOME = process.env.HOME;
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (ORIGINAL_PATH === undefined) delete process.env.PATH;
    else process.env.PATH = ORIGINAL_PATH;
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  function fakeBin(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  }

  // The bug: the host started with a PATH lacking ~/.local/bin (where claude
  // lives) launched `sh -c "claude …"`, which exited 127 and showed `[exited]`.
  test("finds claude in ~/.local/bin even when PATH omits it", () => {
    home = mkdtempSync(join(tmpdir(), "orden-bin-"));
    process.env.HOME = home;
    process.env.PATH = "/no/such/orden/path"; // claude not reachable here
    const p = fakeBin(join(home, ".local", "bin"), "claude");
    expect(resolveAgentBin("claude")).toBe(p);
  });

  test("finds opencode in ~/.opencode/bin", () => {
    home = mkdtempSync(join(tmpdir(), "orden-bin-"));
    process.env.HOME = home;
    process.env.PATH = "/no/such/orden/path";
    const p = fakeBin(join(home, ".opencode", "bin"), "opencode");
    expect(resolveAgentBin("opencode")).toBe(p);
  });

  test("prefers a PATH entry over the home fallbacks", () => {
    home = mkdtempSync(join(tmpdir(), "orden-bin-"));
    process.env.HOME = home;
    const onPath = fakeBin(join(home, "pathbin"), "claude");
    fakeBin(join(home, ".local", "bin"), "claude"); // also present, must lose
    process.env.PATH = join(home, "pathbin");
    expect(resolveAgentBin("claude")).toBe(onPath);
  });

  test("falls back to the bare name when nothing is found", () => {
    home = mkdtempSync(join(tmpdir(), "orden-bin-"));
    process.env.HOME = home;
    process.env.PATH = "/no/such/orden/path";
    expect(resolveAgentBin("claude")).toBe("claude");
  });
});

describe("buildCommand (claude resume vs mint)", () => {
  const ORIGINAL_PATH = process.env.PATH;
  const ORIGINAL_HOME = process.env.HOME;
  let home: string;

  // Point claude's transcript lookup at a throwaway HOME so a test can make a
  // conversation "exist" (or not) without touching the real ~/.claude. The mocked
  // os.homedir() (see top of file) reads osHome.dir.
  function setup(): void {
    home = mkdtempSync(join(tmpdir(), "orden-home-"));
    process.env.HOME = home;
    osHome.dir = home;
  }
  afterEach(() => {
    osHome.dir = "";
    if (home) rmSync(home, { recursive: true, force: true });
    if (ORIGINAL_PATH === undefined) delete process.env.PATH;
    else process.env.PATH = ORIGINAL_PATH;
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  // Drop a fake claude transcript at ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
  function writeTranscript(cwd: string, convId: string): void {
    const dir = join(home, ".claude", "projects", encodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${convId}.jsonl`), "{}\n");
  }

  // An in-memory vault (mirrors hooks.test / packages/mcp fakeVault) seeded per
  // test, so buildCommand's get/set across the "sessions" and "convindex"
  // namespaces are observable.
  function fakeVault(seed: Record<string, Record<string, unknown>> = {}) {
    const store = new Map<string, Map<string, unknown>>();
    for (const [ns, kv] of Object.entries(seed)) store.set(ns, new Map(Object.entries(kv)));
    const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
    return {
      get: async <T>(ns: string, key: string) => (nsMap(ns).get(key) ?? null) as T | null,
      set: async (ns: string, key: string, value: unknown) => void nsMap(ns).set(key, value),
      list: async (ns: string) => [...nsMap(ns).keys()],
      delete: async (ns: string, key: string) => void nsMap(ns).delete(key),
    };
  }
  function vaultHost(seed: Record<string, Record<string, unknown>> = {}): {
    host: Host;
    vault: ReturnType<typeof fakeVault>;
  } {
    const vault = fakeVault(seed);
    return { host: { vault } as unknown as Host, vault };
  }

  const CWD = "/work/repo";

  test("resumes when the conversation transcript exists on disk", async () => {
    setup();
    writeTranscript(CWD, "conv-real");
    const { host } = vaultHost();
    const rec = { agent: "claude", conversationId: "conv-real" } as never;
    const cmd = await buildCommand(host, rec, "sess_1", CWD);
    expect(cmd).toContain("--resume conv-real");
    expect(cmd).not.toContain("--session-id");
  });

  test("re-mints with the SAME id (not --resume) when the transcript is missing", async () => {
    setup();
    // conversationId persisted at mint time, but claude never wrote the transcript
    // (session closed before its first turn) — the bug that printed `[exited]`.
    const { host } = vaultHost();
    const rec = { agent: "claude", conversationId: "conv-ghost" } as never;
    const cmd = await buildCommand(host, rec, "sess_1", CWD);
    expect(cmd).toContain("--session-id conv-ghost");
    expect(cmd).not.toContain("--resume");
    // Same id is kept so the scoped MCP endpoint stays bound.
    expect(cmd).toContain("/mcp/conv-ghost");
  });

  test("launches via the resolved absolute agent path (PATH-independent)", async () => {
    setup();
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "claude");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = "/no/such/orden/path"; // force resolution via the home fallback
    const { host } = vaultHost();
    const rec = { agent: "claude" } as never;
    const cmd = await buildCommand(host, rec, "sess_1", CWD);
    // The command leads with the shquoted absolute path, not a bare `claude`.
    expect(cmd.startsWith(`'${binPath}' `)).toBe(true);
  });

  test("mints a fresh id and persists it (record + recovery index) for a new session", async () => {
    setup();
    const { host, vault } = vaultHost();
    const rec = { agent: "claude" } as never;
    const cmd = await buildCommand(host, rec, "sess_1", CWD);
    const m = cmd.match(/--session-id ([0-9a-f-]{36})/);
    expect(m).not.toBeNull();
    expect(cmd).not.toContain("--resume");
    // The minted id is written back to the record AND to the host-owned index.
    const saved = await vault.get<{ conversationId?: string }>("sessions", "sess_1");
    expect(saved?.conversationId).toBe(m![1]);
    const idx = await vault.get<{ conversationId?: string }>("convindex", "sess_1");
    expect(idx?.conversationId).toBe(m![1]);
  });

  // The reported bug: a record lost its conversationId, so the old fallback minted
  // a BRAND-NEW id and orphaned the real transcript. The host-owned index lets a
  // resume recover the lost id and heal the record instead of faking a new session.
  test("recovers a lost conversationId from the host-owned index and heals the record", async () => {
    setup();
    writeTranscript(CWD, "conv-orig");
    const { host, vault } = vaultHost({
      convindex: { sess_1: { conversationId: "conv-orig" } },
    });
    // Record has NO conversationId (it was clobbered), but it has prior activity.
    const rec = { agent: "claude", touched: true } as never;
    const cmd = await buildCommand(host, rec, "sess_1", CWD);
    // Resumes the recovered conversation — does NOT mint a fresh one.
    expect(cmd).toContain("--resume conv-orig");
    expect(cmd).not.toContain("--session-id");
    // The record is healed back to the recovered id.
    const saved = await vault.get<{ conversationId?: string }>("sessions", "sess_1");
    expect(saved?.conversationId).toBe("conv-orig");
  });

  // Recovery only resumes when the recovered transcript actually exists; a stale
  // index entry whose file is gone must not --resume a ghost. It keeps the id
  // (stable MCP binding) and relaunches under it rather than minting a random one.
  test("does not resume from the index when the recovered transcript is missing", async () => {
    setup();
    const { host } = vaultHost({ convindex: { sess_1: { conversationId: "conv-gone" } } });
    const rec = { agent: "claude", touched: true } as never;
    const cmd = await buildCommand(host, rec, "sess_1", CWD);
    expect(cmd).not.toContain("--resume");
    expect(cmd).toContain("--session-id conv-gone");
  });
});

describe("killSessionTmux", () => {
  // `tmux kill-session` only SIGHUPs the pane process; claude catches that and
  // can linger for minutes still holding its conversation id, so a prompt
  // resume dies with "Session ID … is already in use" ([exited] in the pane).
  // The kill must therefore escalate: TERM the pane process groups right away,
  // KILL whatever survives the grace period.
  test("snapshots pane pids, kills the session, TERMs then KILLs the process groups", async () => {
    const tmux: string[][] = [];
    const signals: Array<[number, string]> = [];
    const exec = (cmd: string, args: string[]) => {
      tmux.push([cmd, ...args]);
      if (args[0] === "list-panes") return Promise.resolve({ stdout: "1234\n5678\n", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    };
    await killSessionTmux("s1", {
      exec,
      kill: (pid, sig) => signals.push([pid, sig]),
      graceMs: 0,
    });
    await new Promise((r) => setTimeout(r, 5)); // let the grace timer fire
    // panes listed BEFORE the session is killed, against the whole session (-s)
    expect(tmux[0].slice(0, 2)).toEqual(["tmux", "list-panes"]);
    expect(tmux[0]).toContain("-s");
    expect(tmux[1].slice(0, 2)).toEqual(["tmux", "kill-session"]);
    // negative pids = the pane process GROUPS; TERM first, KILL after the grace
    expect(signals).toEqual([
      [-1234, "SIGTERM"],
      [-5678, "SIGTERM"],
      [-1234, "SIGKILL"],
      [-5678, "SIGKILL"],
    ]);
  });

  test("a missing tmux session stays a silent no-op (no signals sent)", async () => {
    const signals: Array<[number, string]> = [];
    const exec = (_cmd: string, args: string[]) =>
      args[0] === "list-panes"
        ? Promise.reject(new Error("no such session"))
        : Promise.resolve({ stdout: "", stderr: "" });
    await expect(
      killSessionTmux("gone", { exec, kill: (pid, sig) => signals.push([pid, sig]), graceMs: 0 }),
    ).resolves.toBeUndefined();
    expect(signals).toEqual([]);
  });

  test("an already-dead process group is swallowed (kill throws ESRCH)", async () => {
    const exec = (_cmd: string, args: string[]) =>
      Promise.resolve({ stdout: args[0] === "list-panes" ? "999\n" : "", stderr: "" });
    await expect(
      killSessionTmux("s1", {
        exec,
        kill: () => {
          throw new Error("ESRCH");
        },
        graceMs: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("launchDetached", () => {
  // Guard path only: a missing session record short-circuits BEFORE any tmux
  // spawn, so this never touches tmux (which we must not run in tests).
  test("returns without spawning when the session record is missing", async () => {
    let getCalled = false;
    const host = {
      vault: {
        get: async () => {
          getCalled = true;
          return null;
        },
        set: async () => {
          throw new Error("set should not be called for a missing session");
        },
        list: async () => [],
        delete: async () => {},
      },
    } as unknown as Host;
    await expect(launchDetached(host, "/tmp", "sess_missing")).resolves.toBeUndefined();
    expect(getCalled).toBe(true);
  });
});

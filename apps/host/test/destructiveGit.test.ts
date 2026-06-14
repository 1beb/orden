// One command corpus, BOTH consumers. The destructive-git guard is enforced by
// the claude PreToolUse hook (isDestructiveGit) and by the generated opencode
// plugin (tool.execute.before). They once diverged — the plugin's whole-string
// safe-list negation let `git stash list && git stash` through while the claude
// hook blocked it. This suite runs every corpus entry against both consumers so
// any future drift fails loudly.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDestructiveGit } from "../src/destructiveGit";
import { opencodePluginSource } from "../src/opencodePlugin";

const DESTRUCTIVE = [
  "git reset --hard",
  "git reset --hard HEAD~1",
  "git -C /repo reset origin/main --hard",
  "git checkout .",
  "git checkout -- .",
  "git checkout . && npm test",
  "git clean -f",
  "git clean -fdx",
  "git clean -xdf",
  "git stash",
  "git stash push -m wip",
  // The divergence cases: an innocent safe subcommand elsewhere in a compound
  // command must not defeat the guard on the destructive part.
  "git stash list && git stash",
  "git stash; git stash list",
];

const SAFE = [
  "git status",
  "git reset --soft HEAD~1",
  "git reset HEAD file.txt",
  "git checkout main",
  "git checkout -b feature",
  "git checkout -- src/file.ts",
  "git clean -n",
  "git stash list",
  "git stash show",
  "git stash pop",
  "git stash apply",
  "git stash branch fix",
  "git stash drop",
  "echo done",
];

describe("claude consumer: isDestructiveGit", () => {
  test.each(DESTRUCTIVE)("blocks: %s", (cmd) => {
    expect(isDestructiveGit(cmd)).toBe(true);
  });
  test.each(SAFE)("allows: %s", (cmd) => {
    expect(isDestructiveGit(cmd)).toBe(false);
  });
});

describe("opencode consumer: generated plugin tool.execute.before", () => {
  let dir: string;
  // The instantiated plugin's hook: throws on destructive git in a shared checkout.
  let before: (input: unknown, output: unknown) => Promise<void>;
  const savedWorktree = process.env.ORDEN_WORKTREE;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "orden-plugin-"));
    const file = join(dir, "orden-kanban.mjs");
    writeFileSync(file, opencodePluginSource(), "utf8");
    const mod = await import(pathToFileURL(file).href);
    const plugin = await mod.OrdenKanban();
    before = plugin["tool.execute.before"];
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedWorktree === undefined) delete process.env.ORDEN_WORKTREE;
    else process.env.ORDEN_WORKTREE = savedWorktree;
  });
  beforeEach(() => {
    delete process.env.ORDEN_WORKTREE; // shared checkout: the guard is armed
  });

  const bash = (command: string) => before({ tool: "bash" }, { args: { command } });

  test.each(DESTRUCTIVE)("blocks: %s", async (cmd) => {
    await expect(bash(cmd)).rejects.toThrow(/destructive git is blocked/);
  });
  test.each(SAFE)("allows: %s", async (cmd) => {
    await expect(bash(cmd)).resolves.toBeUndefined();
  });

  test("stands down inside an isolated worktree", async () => {
    process.env.ORDEN_WORKTREE = "1";
    await expect(bash("git reset --hard")).resolves.toBeUndefined();
  });

  test("ignores non-bash tools", async () => {
    await expect(
      before({ tool: "edit" }, { args: { command: "git reset --hard" } }),
    ).resolves.toBeUndefined();
  });
});

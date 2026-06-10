import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, isPathTrusted, ensureClaudeTrust } from "../src/claudeTrust";

function tmpConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "orden-trust-"));
  const path = join(dir, ".claude.json");
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

describe("claudeConfigPath", () => {
  it("uses CLAUDE_CONFIG_DIR when set", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/.claude.json");
  });
  it("falls back to the home directory", () => {
    expect(claudeConfigPath({})).toMatch(/\/\.claude\.json$/);
    expect(claudeConfigPath({})).not.toBe("/.claude.json");
  });
});

describe("isPathTrusted", () => {
  const projects = { "/home/u/repo": { hasTrustDialogAccepted: true } };
  it("matches the exact path", () => {
    expect(isPathTrusted(projects, "/home/u/repo")).toBe(true);
  });
  it("matches through a trusted ancestor (claude's walk-up)", () => {
    expect(isPathTrusted(projects, "/home/u/repo/sub/dir")).toBe(true);
  });
  it("rejects untrusted paths", () => {
    expect(isPathTrusted(projects, "/home/u/other")).toBe(false);
    expect(isPathTrusted({}, "/home/u/repo")).toBe(false);
  });
  it("ignores entries without an accepted dialog", () => {
    expect(isPathTrusted({ "/home/u/repo": { hasTrustDialogAccepted: false } }, "/home/u/repo")).toBe(
      false,
    );
  });
});

describe("ensureClaudeTrust", () => {
  const repo = "/home/u/repo";
  const workdir = "/home/u/.orden/worktrees/p1/s1";

  it("seeds the workdir when the repo is trusted", async () => {
    const cfg = tmpConfig({ projects: { [repo]: { hasTrustDialogAccepted: true } }, theme: "light" });
    expect(await ensureClaudeTrust(workdir, repo, cfg)).toBe("seeded");
    const after = JSON.parse(readFileSync(cfg, "utf8"));
    expect(after.projects[workdir].hasTrustDialogAccepted).toBe(true);
    // untouched siblings survive the rewrite
    expect(after.theme).toBe("light");
    expect(after.projects[repo].hasTrustDialogAccepted).toBe(true);
  });

  it("preserves an existing workdir entry's other fields", async () => {
    const cfg = tmpConfig({
      projects: {
        [repo]: { hasTrustDialogAccepted: true },
        [workdir]: { allowedTools: ["Bash"] },
      },
    });
    expect(await ensureClaudeTrust(workdir, repo, cfg)).toBe("seeded");
    const after = JSON.parse(readFileSync(cfg, "utf8"));
    expect(after.projects[workdir]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: true });
  });

  it("is a no-op when the workdir is already trusted", async () => {
    const cfg = tmpConfig({ projects: { [workdir]: { hasTrustDialogAccepted: true } } });
    const before = readFileSync(cfg, "utf8");
    expect(await ensureClaudeTrust(workdir, repo, cfg)).toBe("trusted");
    expect(readFileSync(cfg, "utf8")).toBe(before); // no rewrite
  });

  it("does not widen trust: skips when the repo itself is untrusted", async () => {
    const cfg = tmpConfig({ projects: {} });
    expect(await ensureClaudeTrust(workdir, repo, cfg)).toBe("skipped");
    expect(JSON.parse(readFileSync(cfg, "utf8")).projects[workdir]).toBeUndefined();
  });

  it("inherits trust from an ancestor of the repo", async () => {
    const cfg = tmpConfig({ projects: { "/srv/code": { hasTrustDialogAccepted: true } } });
    expect(await ensureClaudeTrust(workdir, "/srv/code/repo", cfg)).toBe("seeded");
  });

  it("never writes when the config is missing or malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orden-trust-"));
    const missing = join(dir, ".claude.json");
    expect(await ensureClaudeTrust(workdir, repo, missing)).toBe("failed");
    expect(existsSync(missing)).toBe(false);

    const bad = tmpConfig({});
    writeFileSync(bad, "{not json");
    expect(await ensureClaudeTrust(workdir, repo, bad)).toBe("failed");
    expect(readFileSync(bad, "utf8")).toBe("{not json");
  });
});

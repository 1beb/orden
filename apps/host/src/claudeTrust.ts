// Pre-seed Claude Code's workspace-trust acceptance for orden worktrees, so a
// fresh worktree of an already-trusted repo doesn't re-prompt "do you trust the
// files in this folder?" on every session (design:
// docs/plans/2026-06-10-worktree-auto-trust-design.md).
//
// Claude keys trust in its config file (~/.claude.json, or
// $CLAUDE_CONFIG_DIR/.claude.json) as projects[<path>].hasTrustDialogAccepted
// and walks UP ancestor directories when checking. `claude config set` is
// deprecated (prints guidance, writes nothing), so we edit the file directly —
// read, merge ONE project entry, atomic-rename write. Trust is inherited, never
// widened: we only seed a worktree whose source repo is itself trusted.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

export function claudeConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
}

type ProjectsMap = Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;

// Claude's own check: the path or any ancestor with an accepted trust dialog.
export function isPathTrusted(projects: ProjectsMap | undefined, path: string): boolean {
  let p = resolve(path);
  for (;;) {
    if (projects?.[p]?.hasTrustDialogAccepted === true) return true;
    const parent = dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

export type TrustResult = "trusted" | "seeded" | "skipped" | "failed";

/**
 * Ensure claude trusts `workdir`, inheriting from `repo`. Returns
 *  - "trusted": workdir already trusted, nothing written
 *  - "seeded":  trust entry added for workdir
 *  - "skipped": repo itself is untrusted — refuse to widen trust
 *  - "failed":  config missing/unreadable/malformed — never written to
 * Never throws: a failed seed costs one dialog, never a launch.
 */
export async function ensureClaudeTrust(
  workdir: string,
  repo: string,
  configPath: string = claudeConfigPath(),
): Promise<TrustResult> {
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return "failed";
    config = parsed as Record<string, unknown>;
  } catch {
    return "failed"; // missing or malformed — never risk clobbering claude's config
  }
  const projects = (config.projects ?? {}) as ProjectsMap;
  if (isPathTrusted(projects, workdir)) return "trusted";
  if (!isPathTrusted(projects, repo)) return "skipped";
  const key = resolve(workdir);
  const next = {
    ...config,
    projects: { ...projects, [key]: { ...projects[key], hasTrustDialogAccepted: true } },
  };
  try {
    // Atomic replace (claude itself pretty-prints with 2 spaces); a concurrent
    // claude rewrite can still win the race, which at worst re-shows one dialog.
    const tmp = `${configPath}.orden-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, configPath);
    return "seeded";
  } catch {
    return "failed";
  }
}

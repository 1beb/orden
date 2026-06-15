// Wires the merge coordinator into the host: builds its injected dependencies
// from the real git/build/publish machinery, and registers the two reactors on
// the `cards` change feed.
//
//   complete  -> enqueueOnComplete + drain (ordered integration of the project)
//   blocked   -> resumeOnResolve when the user has chosen a winner
//
// Drains are single-flight PER PROJECT (chained) so two near-simultaneous
// completions can't race onto the same integration worktree. Non-local /
// non-git projects are skipped — there's nothing to integrate.

import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Host, Project } from "@orden/host-api";
import type { NodeHost } from "./nodeHost";
import type { CardRec } from "@orden/mcp";
import {
  drain,
  enqueueOnComplete,
  resumeOnResolve,
  type CoordinatorDeps,
  type CoordinatorGit,
  type TerminalContext,
} from "./mergeCoordinator";
import {
  ensureIntegrationWorktree,
  previewMerge,
  applyClean,
  resetIntegration,
  currentTip,
  changedFiles,
  runGate,
} from "./integrationBranch";
import { makeTerminalStep } from "./integrationTerminal";
import {
  worktreesRoot,
  readWorktreeSettings,
  readIntegrationSettings,
  integrationFor,
  defaultBaseRef,
} from "./worktrees";
import { publishWorktree } from "./publishSession";
import { conservativeResolver } from "./resolverAgent";

const execFileAsync = promisify(execFile);

const realGit: CoordinatorGit = {
  ensureIntegrationWorktree: (i) => ensureIntegrationWorktree(i),
  previewMerge: (cwd, into, inc) => previewMerge(cwd, into, inc),
  applyClean: (cwd, inc, msg) => applyClean(cwd, inc, msg),
  resetIntegration: (cwd, tip) => resetIntegration(cwd, tip),
  currentTip: (cwd) => currentTip(cwd),
  changedFiles: (cwd, base, branch) => changedFiles(cwd, base, branch),
};

export function buildCoordinatorDeps(host: Host): CoordinatorDeps {
  const rebuild = async (repo: string) => {
    try {
      const { stdout, stderr } = await execFileAsync("pnpm", ["--filter", "@orden/web", "build"], {
        cwd: repo,
        timeout: 10 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, output: `${stdout}\n${stderr}` };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof err.code === "number" ? err.code : 1, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
    }
  };

  const terminalStep = makeTerminalStep({
    vault: host.vault,
    rebuild,
    publish: async (ctx: TerminalContext) => {
      const settings = await readWorktreeSettings(host.vault);
      const res = await publishWorktree({
        workdir: ctx.handle.workdir,
        branch: ctx.handle.branch,
        title: `Integration: ${ctx.mergedCardIds.length} session(s)`,
        summary: `Combined integration of: ${ctx.mergedCardIds.join(", ")}`,
        prForge: settings.prForge,
      });
      return { prUrl: res.prUrl };
    },
  });

  return {
    vault: host.vault,
    git: realGit,
    resolver: conservativeResolver,
    gate: (cwd, cmd) => runGate(cwd, cmd),
    plan: async (projectId) => {
      const project = await host.vault.get<Project>("projects", projectId);
      const repo = project?.source.kind === "local" ? project.source.path : "";
      const vaultRoot = host.capabilities().vaultRoot ?? "";
      const integrationRoot = join(worktreesRoot(vaultRoot), projectId, "_integration");
      const ws = await readWorktreeSettings(host.vault);
      const base = ws.baseRef || (repo ? await defaultBaseRef(repo) : "main");
      const integ = integrationFor(await readIntegrationSettings(host.vault), project);
      return { repo, integrationRoot, base, verify: integ.verify, mode: integ.mode, project: project ?? null };
    },
    terminalStep,
  };
}

export function registerMergeCoordinator(host: NodeHost): void {
  const deps = buildCoordinatorDeps(host);
  const chains = new Map<string, Promise<void>>();
  const schedule = (projectId: string, work: () => Promise<void>): void => {
    const prev = chains.get(projectId) ?? Promise.resolve();
    const next = prev.then(work).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`orden: merge coordinator failed for project ${projectId}:`, err);
    });
    chains.set(projectId, next);
  };

  host.onChange((change) => {
    if (change.ns !== "cards") return;
    void (async () => {
      const card = await host.vault.get<CardRec>("cards", change.key);
      if (!card) return;
      const projectId = card.projectId ?? "";
      if (!projectId) return;

      if (card.state === "complete") {
        // Only local git projects have branches to integrate.
        const project = await host.vault.get<Project>("projects", projectId);
        if (project?.source.kind !== "local") return;
        await enqueueOnComplete(host.vault, change.key);
        schedule(projectId, () => drain(deps, projectId));
      } else if (card.state === "blocked") {
        const block = (card as { integrationBlock?: { chosen?: string } }).integrationBlock;
        if (block?.chosen) schedule(projectId, () => resumeOnResolve(deps, change.key));
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("orden: merge coordinator dispatch failed:", err);
    });
  });
}

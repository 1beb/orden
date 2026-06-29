// Project registry backed by the host vault (ns "projects", one key per id).
// A project is a named work location. Accessors stay synchronous over a cache
// hydrated at boot; add/remove write through. (Local/remote file access and
// sessions arrive with the host; see docs/plans/2026-05-29-orden-host-backend.md.)
import type { Host } from "@orden/host-api";
import type { Agent } from "./sessions";

export type ProjectSource =
  | { kind: "ephemeral" } // not tied to a folder; backed by one internally later
  | { kind: "local"; path: string }
  | { kind: "ssh"; host: string; path: string }
  | { kind: "s3"; bucket: string };

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
  // Per-project session defaults. Both optional so existing vault records (which
  // predate these fields) stay valid; absent means "fall back to the global
  // behaviour".
  //
  // defaultAgent: the agent the launchers pre-select for this project. Absent =
  // ask each time (show both Claude/opencode marks with no emphasis).
  defaultAgent?: Agent;
  // workingDir: the cwd agents launch in for this project. Absent = use the
  // source path (for local projects). NOTE: the host currently launches every
  // session in one global cwd (filesRoot ?? process.cwd()); honoring a per-
  // project override needs the spawn path to read this. Persisted now; the host
  // cwd-override plumbing is deferred.
  workingDir?: string;
  // showCompleted: keep completed cards/sessions in the project page's "Items by
  // state" list instead of letting them fade out after completeFadeHours. Absent
  // / false = the default fade-out behaviour.
  showCompleted?: boolean;
  // archived: hidden from the sidebar, pickers, board, and search — it only
  // appears in the Projects page's furled "Archived" section. Its cards and
  // sessions are kept. Absent / false = active (the default). Reversible.
  archived?: boolean;
  // worktreeIsolation: per-project override of the global "isolate sessions in
  // git worktrees" setting. Absent = inherit; true/false force it on/off here.
  worktreeIsolation?: boolean;
  // integrationMode: per-project override of the global merge-coordinator mode.
  // Absent = inherit; "fast"/"measured" force it for this project.
  integrationMode?: "fast" | "measured";
  // integrationVerify: the gate command the coordinator runs to test the combined
  // state (any shell command — pnpm/pytest/cargo/go/make…). Absent = inherit;
  // "" = no semantic gate. Language-agnostic; no toolchain assumed.
  integrationVerify?: string;
  // integrationRebuild: command run after a fast merge to main (e.g. rebuild a
  // served bundle). Absent = inherit; "" = none.
  integrationRebuild?: string;
}

let host: Host | null = null;
let cache: Project[] = [];
let counter = 0;

export async function hydrateProjects(h: Host): Promise<void> {
  host = h;
  const ids = await h.vault.list("projects");
  const all = await Promise.all(ids.map((id) => h.vault.get<Project>("projects", id)));
  cache = all.filter((p): p is Project => p !== null);
}

export function listProjects(opts?: { includeArchived?: boolean }): Project[] {
  const all = [...cache];
  return opts?.includeArchived ? all : all.filter((p) => !p.archived);
}

// True when the host can pop a native directory chooser. The project modal uses
// this to decide whether to show its "Browse…" button.
export function canPickDirectory(): boolean {
  return host?.capabilities().pickDirectory ?? false;
}

// Ask the host to open a native directory chooser, returning the chosen absolute
// path or null (cancelled / unsupported). Routed through the host because a
// browser can't produce a real filesystem path.
export async function pickDirectory(startPath?: string): Promise<string | null> {
  if (!host) return null;
  return host.files.pickDirectory({ title: "Choose project folder", startPath });
}

export function getProject(id: string): Project | undefined {
  return cache.find((p) => p.id === id);
}

// Resolve a project by its NAME (case-insensitive). This is the portable,
// shareable handle for projects — deep links and [[Project: X]] wiki links use
// names rather than instance-local ids, so a link survives across instances.
// On a name collision the first match wins (single-user vaults rarely collide;
// an immutable slug would remove the ambiguity — the resolver is the single
// place to swap in once that exists). Returns undefined when no project matches.
export function findProjectByName(name: string): Project | undefined {
  const lower = name.toLowerCase();
  return cache.find((p) => p.name.toLowerCase() === lower);
}

// The catch-all project for work not tied to a folder (e.g. a session you start
// without picking a project). Stable id so everything lands consistently.
export const DEFAULT_PROJECT_ID = "homeroom";
export const DEFAULT_PROJECT_NAME = "Homeroom";

export function ensureDefaultProject(): Project {
  const existing = cache.find((p) => p.id === DEFAULT_PROJECT_ID);
  if (existing) return existing;
  const project: Project = {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    source: { kind: "ephemeral" },
  };
  cache.push(project);
  if (host) void host.vault.set("projects", project.id, project);
  return project;
}

export function addProject(
  name: string,
  source: ProjectSource = { kind: "ephemeral" },
  extra: { defaultAgent?: Agent; workingDir?: string } = {},
): Project {
  counter += 1;
  const project: Project = {
    id: `proj_${Date.now().toString(36)}_${counter}`,
    name: name.trim(),
    source,
    ...(extra.defaultAgent ? { defaultAgent: extra.defaultAgent } : {}),
    ...(extra.workingDir?.trim() ? { workingDir: extra.workingDir.trim() } : {}),
  };
  cache.push(project);
  if (host) void host.vault.set("projects", project.id, project);
  return project;
}

// Edit an existing project's name, (for local projects) its folder path, and its
// session defaults. Path is ignored for ephemeral/ssh/s3 sources — only `local`
// has a path field. Passing defaultAgent/workingDir as null clears them.
export function updateProject(
  id: string,
  patch: {
    name?: string;
    path?: string;
    defaultAgent?: Agent | null;
    workingDir?: string | null;
    showCompleted?: boolean;
    // true archives (hides from active lists); false unarchives. Stored as
    // absence when false, matching the absent-means-default rule.
    archived?: boolean;
    // true/false force the override; null clears it back to inherit.
    worktreeIsolation?: boolean | null;
    // "fast"/"measured" force the override; null clears it back to inherit.
    integrationMode?: "fast" | "measured" | null;
    // command string sets the override; null clears it back to inherit.
    integrationVerify?: string | null;
    integrationRebuild?: string | null;
  },
): void {
  const project = cache.find((p) => p.id === id);
  if (!project) return;
  if (patch.name !== undefined && patch.name.trim()) project.name = patch.name.trim();
  if (patch.path !== undefined && project.source.kind === "local") {
    project.source = { kind: "local", path: patch.path.trim() };
  }
  if (patch.defaultAgent !== undefined) {
    if (patch.defaultAgent) project.defaultAgent = patch.defaultAgent;
    else delete project.defaultAgent;
  }
  if (patch.workingDir !== undefined) {
    const wd = patch.workingDir?.trim();
    if (wd) project.workingDir = wd;
    else delete project.workingDir;
  }
  if (patch.worktreeIsolation !== undefined) {
    if (patch.worktreeIsolation === null) delete project.worktreeIsolation;
    else project.worktreeIsolation = patch.worktreeIsolation;
  }
  if (patch.integrationMode !== undefined) {
    if (patch.integrationMode === null) delete project.integrationMode;
    else project.integrationMode = patch.integrationMode;
  }
  if (patch.integrationVerify !== undefined) {
    if (patch.integrationVerify === null) delete project.integrationVerify;
    else project.integrationVerify = patch.integrationVerify;
  }
  if (patch.integrationRebuild !== undefined) {
    if (patch.integrationRebuild === null) delete project.integrationRebuild;
    else project.integrationRebuild = patch.integrationRebuild;
  }
  if (patch.showCompleted !== undefined) {
    // Default is false, so store only the truthy case and drop the field
    // otherwise — keeps records clean and matches the absent-means-default rule.
    if (patch.showCompleted) project.showCompleted = true;
    else delete project.showCompleted;
  }
  if (patch.archived !== undefined) {
    if (patch.archived) project.archived = true;
    else delete project.archived;
  }
  if (host) void host.vault.set("projects", project.id, project);
}

export function removeProject(id: string): void {
  cache = cache.filter((p) => p.id !== id);
  if (host) void host.vault.delete("projects", id);
}

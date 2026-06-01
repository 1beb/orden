// Project registry backed by the host vault (ns "projects", one key per id).
// A project is a named work location. Accessors stay synchronous over a cache
// hydrated at boot; add/remove write through. (Local/remote file access and
// sessions arrive with the host; see docs/plans/2026-05-29-orden-host-backend.md.)
import type { Host } from "@orden/host-api";

export type ProjectSource =
  | { kind: "ephemeral" } // not tied to a folder; backed by one internally later
  | { kind: "local"; path: string }
  | { kind: "ssh"; host: string; path: string }
  | { kind: "s3"; bucket: string };

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
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

export function listProjects(): Project[] {
  return [...cache];
}

export function getProject(id: string): Project | undefined {
  return cache.find((p) => p.id === id);
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

export function addProject(name: string, source: ProjectSource = { kind: "ephemeral" }): Project {
  counter += 1;
  const project: Project = {
    id: `proj_${Date.now().toString(36)}_${counter}`,
    name: name.trim(),
    source,
  };
  cache.push(project);
  if (host) void host.vault.set("projects", project.id, project);
  return project;
}

// Edit an existing project's name and (for local projects) its folder path.
// Path is ignored for ephemeral/ssh/s3 sources — only `local` has a path field.
export function updateProject(id: string, patch: { name?: string; path?: string }): void {
  const project = cache.find((p) => p.id === id);
  if (!project) return;
  if (patch.name !== undefined && patch.name.trim()) project.name = patch.name.trim();
  if (patch.path !== undefined && project.source.kind === "local") {
    project.source = { kind: "local", path: patch.path.trim() };
  }
  if (host) void host.vault.set("projects", project.id, project);
}

export function removeProject(id: string): void {
  cache = cache.filter((p) => p.id !== id);
  if (host) void host.vault.delete("projects", id);
}

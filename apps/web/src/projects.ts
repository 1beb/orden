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

export function removeProject(id: string): void {
  cache = cache.filter((p) => p.id !== id);
  if (host) void host.vault.delete("projects", id);
}

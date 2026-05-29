// Frontend project registry (vault stand-in until the host backend lands).
// A project is a named work location. Local/remote file access and sessions
// arrive with the host (see docs/plans/2026-05-29-orden-host-backend.md); for
// now this just persists the registry so "Add project" is real and listed.

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

const KEY = "orden:projects";
let counter = 0;

function load(): Project[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(projects: Project[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(projects));
  } catch {
    /* ignore */
  }
}

export function listProjects(): Project[] {
  return load();
}

export function getProject(id: string): Project | undefined {
  return load().find((p) => p.id === id);
}

export function addProject(name: string, source: ProjectSource = { kind: "ephemeral" }): Project {
  const projects = load();
  counter += 1;
  const project: Project = {
    id: `proj_${Date.now().toString(36)}_${counter}`,
    name: name.trim(),
    source,
  };
  projects.push(project);
  save(projects);
  return project;
}

export function removeProject(id: string): void {
  save(load().filter((p) => p.id !== id));
}

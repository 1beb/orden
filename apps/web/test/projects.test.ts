import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  addProject,
  getProject,
  hydrateProjects,
  listProjects,
  removeProject,
  updateProject,
} from "../src/projects";

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("projects registry (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateProjects(new BrowserHost());
  });

  it("lists nothing before any project is added", () => {
    expect(listProjects()).toEqual([]);
  });

  it("addProject returns a project with an id and trimmed name", () => {
    const p = addProject("  My Project  ", { kind: "local", path: "/tmp/x" });
    expect(p.name).toBe("My Project");
    expect(typeof p.id).toBe("string");
    expect(p.source).toEqual({ kind: "local", path: "/tmp/x" });
  });

  it("getProject and listProjects see an added project", () => {
    const p = addProject("Alpha");
    expect(listProjects().map((x) => x.id)).toContain(p.id);
    expect(getProject(p.id)?.name).toBe("Alpha");
  });

  it("removeProject removes it", () => {
    const p = addProject("Gone");
    removeProject(p.id);
    expect(getProject(p.id)).toBeUndefined();
    expect(listProjects().map((x) => x.id)).not.toContain(p.id);
  });

  it("updateProject renames and re-paths a local project", () => {
    const p = addProject("Old", { kind: "local", path: "/tmp/old" });
    updateProject(p.id, { name: "  New  ", path: "  /tmp/new  " });
    const got = getProject(p.id)!;
    expect(got.name).toBe("New");
    expect(got.source).toEqual({ kind: "local", path: "/tmp/new" });
  });

  it("updateProject ignores an empty name and ignores path for non-local sources", () => {
    const p = addProject("Keep", { kind: "ephemeral" });
    updateProject(p.id, { name: "   ", path: "/tmp/x" });
    const got = getProject(p.id)!;
    expect(got.name).toBe("Keep");
    expect(got.source).toEqual({ kind: "ephemeral" });
  });

  it("updateProject on a missing id is a no-op", () => {
    expect(() => updateProject("nope", { name: "x" })).not.toThrow();
  });

  it("toggles showCompleted on, then clears it when set false", () => {
    const p = addProject("Showy");
    expect(getProject(p.id)?.showCompleted).toBeUndefined();
    updateProject(p.id, { showCompleted: true });
    expect(getProject(p.id)?.showCompleted).toBe(true);
    updateProject(p.id, { showCompleted: false });
    // Default is false, so it's stored as absence rather than an explicit false.
    expect(getProject(p.id)?.showCompleted).toBeUndefined();
  });

  it("archived projects are hidden from listProjects() but kept by includeArchived", () => {
    const a = addProject("Active");
    const g = addProject("Gone");
    updateProject(g.id, { archived: true });
    expect(getProject(g.id)?.archived).toBe(true);
    // Default listing excludes archived.
    expect(listProjects().map((x) => x.id)).toEqual([a.id]);
    // includeArchived returns them all (still cached, not deleted).
    expect(listProjects({ includeArchived: true }).map((x) => x.id).sort()).toEqual(
      [a.id, g.id].sort(),
    );
    // Unarchive clears the flag back to absence.
    updateProject(g.id, { archived: false });
    expect(getProject(g.id)?.archived).toBeUndefined();
    expect(listProjects().map((x) => x.id).sort()).toEqual([a.id, g.id].sort());
  });

  it("sets the worktree-isolation override and clears it back to inherit", () => {
    const p = addProject("Isolated");
    expect(getProject(p.id)?.worktreeIsolation).toBeUndefined(); // inherit
    updateProject(p.id, { worktreeIsolation: false });
    expect(getProject(p.id)?.worktreeIsolation).toBe(false);
    updateProject(p.id, { worktreeIsolation: true });
    expect(getProject(p.id)?.worktreeIsolation).toBe(true);
    updateProject(p.id, { worktreeIsolation: null });
    expect(getProject(p.id)?.worktreeIsolation).toBeUndefined();
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    const p = addProject("Durable");
    await settle();
    await hydrateProjects(new BrowserHost());
    expect(getProject(p.id)?.name).toBe("Durable");
  });
});

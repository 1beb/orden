import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  addProject,
  getProject,
  hydrateProjects,
  isHostFilesRoot,
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

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    const p = addProject("Durable");
    await settle();
    await hydrateProjects(new BrowserHost());
    expect(getProject(p.id)?.name).toBe("Durable");
  });
});

describe("isHostFilesRoot", () => {
  it("matches a local project whose path equals the host files root", () => {
    const p = addProject("Repo", { kind: "local", path: "/home/b/projects/orden" });
    expect(isHostFilesRoot(p, "/home/b/projects/orden")).toBe(true);
  });

  it("ignores a trailing slash on either side", () => {
    const p = addProject("Repo", { kind: "local", path: "/home/b/projects/orden/" });
    expect(isHostFilesRoot(p, "/home/b/projects/orden")).toBe(true);
    const q = addProject("Repo2", { kind: "local", path: "/home/b/projects/orden" });
    expect(isHostFilesRoot(q, "/home/b/projects/orden/")).toBe(true);
  });

  it("does not match a local project with a different path (the leak)", () => {
    const p = addProject("Other", { kind: "local", path: "/home/b/projects/ygqc" });
    expect(isHostFilesRoot(p, "/home/b/projects/orden")).toBe(false);
  });

  it("never matches a non-local project", () => {
    const p = addProject("Ephemeral", { kind: "ephemeral" });
    expect(isHostFilesRoot(p, "/home/b/projects/orden")).toBe(false);
  });

  it("never matches when the host exposes no files root", () => {
    const p = addProject("Repo", { kind: "local", path: "/home/b/projects/orden" });
    expect(isHostFilesRoot(p, undefined)).toBe(false);
  });
});

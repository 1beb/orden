import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  addProject,
  getProject,
  hydrateProjects,
  listProjects,
  removeProject,
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

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    const p = addProject("Durable");
    await settle();
    await hydrateProjects(new BrowserHost());
    expect(getProject(p.id)?.name).toBe("Durable");
  });
});

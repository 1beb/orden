import { describe, it, expect } from "vitest";
import { serializeNav, parseNav } from "../src/urlRouter";
import { VIEWS } from "../src/viewState";

describe("serializeNav / parseNav", () => {
  it("serializes a bare view with no params", () => {
    expect(serializeNav({ view: "kanban" })).toBe("#/kanban");
  });

  it("round-trips a project view (project is a NAME, not an id)", () => {
    const s = { view: "project" as const, project: "orden" };
    expect(parseNav(serializeNav(s))).toEqual(s);
  });

  it("round-trips a doc view scoped to the active project", () => {
    const s = { view: "code" as const, project: "orden", docPath: "src/main.ts" };
    expect(serializeNav(s)).toBe("#/code?p=orden&d=src%2Fmain.ts");
    expect(parseNav(serializeNav(s))).toEqual(s);
  });

  it("encodes a doc whose project differs from the active project", () => {
    const s = { view: "html" as const, docPath: "report.html", docProject: "website" };
    const hash = serializeNav(s);
    expect(hash).toContain("dp=website");
    expect(parseNav(hash)).toEqual(s);
  });

  it("omits dp when the doc project equals the active project", () => {
    const s = { view: "code" as const, project: "orden", docPath: "a.ts", docProject: "orden" };
    expect(serializeNav(s)).not.toContain("dp=");
  });

  it("round-trips a journal page", () => {
    const s = { view: "journal" as const, page: "2026-06-27" };
    expect(parseNav(serializeNav(s))).toEqual(s);
  });

  it("round-trips project names with spaces and special characters", () => {
    const s = { view: "project" as const, project: "My C++ Project" };
    expect(parseNav(serializeNav(s))).toEqual(s);
  });

  it("round-trips every registered view", () => {
    for (const view of VIEWS) {
      const s = { view };
      expect(parseNav(serializeNav(s))).toEqual(s);
    }
  });

  it("does NOT carry session ids (sessions are instance-local, vault-only)", () => {
    const hash = serializeNav({ view: "kanban" });
    expect(hash).not.toContain("s=");
    // A stale link carrying s= is simply ignored (unknown param dropped).
    expect(parseNav("#/kanban?s=sess_3")).toEqual({ view: "kanban" });
  });
});

describe("parseNav edge cases", () => {
  it("returns null for an empty hash", () => {
    expect(parseNav("")).toBeNull();
    expect(parseNav("#")).toBeNull();
  });

  it("returns null for an unknown view", () => {
    expect(parseNav("#/bogus")).toBeNull();
    expect(parseNav("#/bogus?p=x")).toBeNull();
  });

  it("accepts hash with or without a leading slash", () => {
    expect(parseNav("#/kanban")).toEqual({ view: "kanban" });
    expect(parseNav("#kanban")).toEqual({ view: "kanban" });
    expect(parseNav("kanban")).toEqual({ view: "kanban" });
  });

  it("ignores unknown query params", () => {
    expect(parseNav("#/kanban?foo=bar&p=orden")).toEqual({
      view: "kanban",
      project: "orden",
    });
  });

  it("drops empty param values", () => {
    expect(parseNav("#/kanban?p=")).toEqual({ view: "kanban" });
  });

  it("does not set docProject when dp is absent (applyNav resolves it)", () => {
    expect(parseNav("#/code?p=orden&d=x.ts")).toEqual({
      view: "code",
      project: "orden",
      docPath: "x.ts",
    });
  });
});

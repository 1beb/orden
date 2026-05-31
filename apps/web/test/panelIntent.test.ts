import { describe, expect, it, vi } from "vitest";
import { dispatchPanelIntent, type PanelIntentDeps } from "../src/panelIntent";

function makeDeps(overrides: Partial<PanelIntentDeps> = {}): PanelIntentDeps {
  return {
    openRepoFile: vi.fn(),
    openPage: vi.fn(),
    openKanban: vi.fn(),
    openCard: vi.fn(() => true),
    resolveCardId: vi.fn((t: string) => t),
    ...overrides,
  };
}

describe("dispatchPanelIntent", () => {
  it("routes doc to openRepoFile", () => {
    const deps = makeDeps();
    expect(dispatchPanelIntent({ kind: "doc", target: "notes/x.md" }, deps)).toBe(true);
    expect(deps.openRepoFile).toHaveBeenCalledWith("notes/x.md");
  });

  it("routes page to openPage", () => {
    const deps = makeDeps();
    dispatchPanelIntent({ kind: "page", target: "Welcome" }, deps);
    expect(deps.openPage).toHaveBeenCalledWith("Welcome");
  });

  it("routes kanban to openKanban", () => {
    const deps = makeDeps();
    dispatchPanelIntent({ kind: "kanban", target: "" }, deps);
    expect(deps.openKanban).toHaveBeenCalledOnce();
  });

  it("resolves and opens a card by target", () => {
    const deps = makeDeps({ resolveCardId: vi.fn(() => "card-1") });
    dispatchPanelIntent({ kind: "card", target: "My Task" }, deps);
    expect(deps.resolveCardId).toHaveBeenCalledWith("My Task");
    expect(deps.openCard).toHaveBeenCalledWith("card-1");
    expect(deps.openKanban).not.toHaveBeenCalled();
  });

  it("falls back to the board when the card id won't resolve", () => {
    const deps = makeDeps({ resolveCardId: vi.fn(() => undefined) });
    dispatchPanelIntent({ kind: "card", target: "ghost" }, deps);
    expect(deps.openCard).not.toHaveBeenCalled();
    expect(deps.openKanban).toHaveBeenCalledOnce();
  });

  it("falls back to the board when openCard reports failure", () => {
    const deps = makeDeps({ openCard: vi.fn(() => false) });
    dispatchPanelIntent({ kind: "card", target: "card-1" }, deps);
    expect(deps.openKanban).toHaveBeenCalledOnce();
  });

  it("ignores unknown kinds", () => {
    const deps = makeDeps();
    expect(dispatchPanelIntent({ kind: "wat", target: "x" }, deps)).toBe(false);
    expect(deps.openKanban).not.toHaveBeenCalled();
  });
});

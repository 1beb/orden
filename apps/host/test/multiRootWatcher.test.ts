import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiRootWatcher } from "../src/multiRootWatcher";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const mkroot = () => {
  const d = mkdtempSync(join(tmpdir(), "mrw-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("MultiRootWatcher", () => {
  test("emits (projectId, path) for a change under a local project's root", async () => {
    const a = mkroot();
    const roots = [{ id: "pa", root: a }];
    const seen: Array<[string, string]> = [];
    const w = new MultiRootWatcher(
      async () => roots,
      (id, p) => seen.push([id, p]),
    );
    await w.start();
    writeFileSync(join(a, "x.md"), "hi");
    await delay(400);
    expect(seen).toContainEqual(["pa", "x.md"]);
    w.stop();
  });

  test("refresh() begins watching a newly added project", async () => {
    const a = mkroot();
    const roots = [{ id: "pa", root: a }];
    const seen: Array<[string, string]> = [];
    const w = new MultiRootWatcher(
      async () => roots,
      (id, p) => seen.push([id, p]),
    );
    await w.start();
    const b = mkroot();
    roots.push({ id: "pb", root: b });
    await w.refresh();
    writeFileSync(join(b, "y.md"), "yo");
    await delay(400);
    expect(seen).toContainEqual(["pb", "y.md"]);
    w.stop();
  });

  test("refresh() stops watching a removed project", async () => {
    const a = mkroot();
    const b = mkroot();
    const roots = [
      { id: "pa", root: a },
      { id: "pb", root: b },
    ];
    const seen: Array<[string, string]> = [];
    const w = new MultiRootWatcher(
      async () => roots,
      (id, p) => seen.push([id, p]),
    );
    await w.start();
    // Drop pb.
    roots.splice(1, 1);
    await w.refresh();
    writeFileSync(join(b, "gone.md"), "x");
    await delay(400);
    expect(seen.some(([id]) => id === "pb")).toBe(false);
    w.stop();
  });

  test("refresh() reopens a watcher when a project's root changes", async () => {
    const a = mkroot();
    const roots = [{ id: "pa", root: a }];
    const seen: Array<[string, string]> = [];
    const w = new MultiRootWatcher(
      async () => roots,
      (id, p) => seen.push([id, p]),
    );
    await w.start();
    const a2 = mkroot();
    roots[0] = { id: "pa", root: a2 };
    await w.refresh();
    writeFileSync(join(a2, "moved.md"), "x");
    await delay(400);
    expect(seen).toContainEqual(["pa", "moved.md"]);
    w.stop();
  });

  test("stop() closes watchers — no callbacks after stop", async () => {
    const a = mkroot();
    const seen: Array<[string, string]> = [];
    const w = new MultiRootWatcher(
      async () => [{ id: "pa", root: a }],
      (id, p) => seen.push([id, p]),
    );
    await w.start();
    w.stop();
    writeFileSync(join(a, "z.md"), "z");
    await delay(400);
    expect(seen).toEqual([]);
    w.stop(); // double-stop is safe
  });

  test("filter discriminates: keeps a sibling, skips node_modules / dotfiles", async () => {
    const a = mkroot();
    // Create node_modules before start() so the recursive watcher arms over it
    // — proving the skip is the filter, not arming order.
    mkdirSync(join(a, "node_modules", "pkg"), { recursive: true });
    const seen: Array<[string, string]> = [];
    const w = new MultiRootWatcher(
      async () => [{ id: "pa", root: a }],
      (id, p) => seen.push([id, p]),
    );
    await w.start();
    // Skipped paths and a kept sibling, all written together so the kept event
    // proves the watcher is live and the filter discriminates (not silence).
    writeFileSync(join(a, "node_modules", "pkg", "f.md"), "x");
    writeFileSync(join(a, ".secret"), "x");
    writeFileSync(join(a, "keep.md"), "x");
    await delay(400);
    // The kept sibling fired.
    expect(seen).toContainEqual(["pa", "keep.md"]);
    // Nothing under node_modules or any dotfile leaked through.
    expect(
      seen.some(([, p]) => p.includes("node_modules") || p.startsWith(".") || p === ".secret"),
    ).toBe(false);
    w.stop();
  });
});

import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenDocWatcher } from "../src/openDocWatcher";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Poll until `pred` holds (or time out). fs.watch delivery latency varies with
// machine load — a fixed delay flakes under a full parallel suite — so positive
// "the event fired" assertions wait for the condition. Absence assertions still
// use a fixed delay (you can't poll for a non-event).
const waitFor = async (pred: () => boolean, timeout = 3000, step = 20): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(step);
  }
};

const dirs: string[] = [];
const mkroot = () => {
  const d = mkdtempSync(join(tmpdir(), "odw-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A resolver over a fixed projectId→root map, matching FsFiles' resolver shape.
const resolver = (map: Record<string, string>) => async (id: string) => map[id];

describe("OpenDocWatcher", () => {
  test("emits (projectId, path) for an edit to the watched doc", async () => {
    const a = mkroot();
    const seen: Array<[string, string]> = [];
    const w = new OpenDocWatcher(resolver({ pa: a }), (id, p) => seen.push([id, p]));
    await w.watch("pa", "x.md");
    writeFileSync(join(a, "x.md"), "hi");
    await waitFor(() => seen.some(([id, p]) => id === "pa" && p === "x.md"));
    expect(seen).toContainEqual(["pa", "x.md"]);
    w.stop();
  });

  test("ignores a sibling in the same dir that is not open", async () => {
    const a = mkroot();
    const seen: Array<[string, string]> = [];
    const w = new OpenDocWatcher(resolver({ pa: a }), (id, p) => seen.push([id, p]));
    await w.watch("pa", "open.md");
    // Write the unopened sibling first, then the open doc — the open-doc event
    // proves the watcher is live and the sibling was filtered, not just slow.
    writeFileSync(join(a, "closed.md"), "x");
    writeFileSync(join(a, "open.md"), "y");
    await waitFor(() => seen.some(([, p]) => p === "open.md"));
    expect(seen).toContainEqual(["pa", "open.md"]);
    expect(seen.some(([, p]) => p === "closed.md")).toBe(false);
    w.stop();
  });

  test("watches a doc in a subdirectory", async () => {
    const a = mkroot();
    mkdirSync(join(a, "docs"), { recursive: true });
    const seen: Array<[string, string]> = [];
    const w = new OpenDocWatcher(resolver({ pa: a }), (id, p) => seen.push([id, p]));
    await w.watch("pa", "docs/note.md");
    writeFileSync(join(a, "docs", "note.md"), "hi");
    await waitFor(() => seen.some(([id, p]) => id === "pa" && p === "docs/note.md"));
    expect(seen).toContainEqual(["pa", "docs/note.md"]);
    w.stop();
  });

  test("unwatch() stops emission for that doc", async () => {
    const a = mkroot();
    const seen: Array<[string, string]> = [];
    const w = new OpenDocWatcher(resolver({ pa: a }), (id, p) => seen.push([id, p]));
    await w.watch("pa", "x.md");
    w.unwatch("pa", "x.md");
    writeFileSync(join(a, "x.md"), "hi");
    await delay(400);
    expect(seen).toEqual([]);
    w.stop();
  });

  test("two docs in one dir share a watch; unwatching one keeps the other live", async () => {
    const a = mkroot();
    const seen: Array<[string, string]> = [];
    const w = new OpenDocWatcher(resolver({ pa: a }), (id, p) => seen.push([id, p]));
    await w.watch("pa", "one.md");
    await w.watch("pa", "two.md");
    w.unwatch("pa", "one.md");
    // one.md is closed → silent; two.md is still open → still fires.
    writeFileSync(join(a, "one.md"), "x");
    writeFileSync(join(a, "two.md"), "y");
    await waitFor(() => seen.some(([, p]) => p === "two.md"));
    expect(seen).toContainEqual(["pa", "two.md"]);
    expect(seen.some(([, p]) => p === "one.md")).toBe(false);
    w.stop();
  });

  test("stop() closes watchers — no callbacks after stop", async () => {
    const a = mkroot();
    const seen: Array<[string, string]> = [];
    const w = new OpenDocWatcher(resolver({ pa: a }), (id, p) => seen.push([id, p]));
    await w.watch("pa", "z.md");
    w.stop();
    writeFileSync(join(a, "z.md"), "z");
    await delay(400);
    expect(seen).toEqual([]);
    w.stop(); // double-stop is safe
  });
});

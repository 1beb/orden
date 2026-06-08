import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSnapshotStore } from "../../src/clipper/snapshotStore";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orden-snap-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("DiskSnapshotStore", () => {
  it("writes bytes under snapshots/<hash>.<ext> and returns a vault-relative path", async () => {
    const store = new DiskSnapshotStore(root);
    const path = await store.put("deadbeef", "html", "<p>hi</p>");
    expect(path).toBe("snapshots/deadbeef.html");
    expect(existsSync(join(root, path))).toBe(true);
    expect(await store.get(path)).toBe("<p>hi</p>");
  });
  it("is idempotent for the same hash (no duplicate write churn)", async () => {
    const store = new DiskSnapshotStore(root);
    const a = await store.put("h1", "html", "<p>x</p>");
    const b = await store.put("h1", "html", "<p>x</p>");
    expect(a).toBe(b);
  });
});

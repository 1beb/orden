import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskVault } from "../src/diskVault";

let root: string;
let vault: DiskVault;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-vault-"));
  vault = new DiskVault(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DiskVault", () => {
  test("set then get round-trips a value", async () => {
    await vault.set("docs", "alpha", { title: "Alpha", n: 1 });
    expect(await vault.get("docs", "alpha")).toEqual({ title: "Alpha", n: 1 });
  });

  test("get returns null for a missing key", async () => {
    expect(await vault.get("docs", "nope")).toBeNull();
  });

  test("list returns keys in a namespace, scoped to that namespace", async () => {
    await vault.set("docs", "alpha", 1);
    await vault.set("docs", "beta", 2);
    await vault.set("pages", "home", 3);
    expect((await vault.list("docs")).sort()).toEqual(["alpha", "beta"]);
    expect(await vault.list("pages")).toEqual(["home"]);
  });

  test("list returns empty for an unknown namespace", async () => {
    expect(await vault.list("ghost")).toEqual([]);
  });

  test("delete removes a key", async () => {
    await vault.set("docs", "alpha", 1);
    await vault.delete("docs", "alpha");
    expect(await vault.get("docs", "alpha")).toBeNull();
    expect(await vault.list("docs")).toEqual([]);
  });

  test("keys with slashes and spaces round-trip through get and list", async () => {
    const key = "Daily Note/2026-05-29";
    await vault.set("pages", key, { body: "hi" });
    expect(await vault.get("pages", key)).toEqual({ body: "hi" });
    expect(await vault.list("pages")).toEqual([key]);
  });

  test("get returns null for an empty file (crash-truncated write), not a throw", async () => {
    // A non-atomic write that died mid-flush leaves a 0-byte file. One corrupt
    // entry must not take down hydrateSessions/hydrateCards for the whole app.
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", "sess_x.json"), "", "utf8");
    expect(await vault.get("sessions", "sess_x")).toBeNull();
  });

  test("get returns null for a non-JSON (partially-written) file, not a throw", async () => {
    await mkdir(join(root, "cards"), { recursive: true });
    await writeFile(join(root, "cards", "c1.json"), '{"id":"c1","ti', "utf8");
    expect(await vault.get("cards", "c1")).toBeNull();
  });

  test("set leaves no leftover temp artifacts in the namespace dir", async () => {
    // Atomic write goes through a temp file + rename; the temp must not linger.
    await vault.set("docs", "alpha", { n: 1 });
    expect(await readdir(join(root, "docs"))).toEqual(["alpha.json"]);
  });

  test("concurrent writes to the same key don't throw and leave a valid value", async () => {
    // The launch-on-create reactor and the web write-through can both persist the
    // same session record near-simultaneously. The temp file must be unique PER
    // CALL (not just per process), or the second rename hits ENOENT and crashes
    // the host.
    await Promise.all([
      vault.set("sessions", "s1", { id: "s1", n: 1 }),
      vault.set("sessions", "s1", { id: "s1", n: 2 }),
      vault.set("sessions", "s1", { id: "s1", n: 3 }),
    ]);
    const got = (await vault.get("sessions", "s1")) as { id: string; n: number };
    expect(got.id).toBe("s1");
    expect([1, 2, 3]).toContain(got.n);
    // No leftover temp files either.
    expect(await readdir(join(root, "sessions"))).toEqual(["s1.json"]);
  });
});

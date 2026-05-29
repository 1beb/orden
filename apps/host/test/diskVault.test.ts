import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
});

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHost } from "../src/nodeHost";

let root: string;
let host: NodeHost;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-host-"));
  host = new NodeHost({ vaultRoot: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NodeHost", () => {
  test("vault is disk-backed and round-trips values", async () => {
    await host.vault.set("settings", "theme", { mode: "dark" });
    expect(await host.vault.get("settings", "theme")).toEqual({ mode: "dark" });
  });

  test("reports a persistent vault in capabilities", async () => {
    expect(host.capabilities().persistentVault).toBe(true);
  });

  test("identity reports a local node user", async () => {
    const me = await host.identity.me();
    expect(me).not.toBeNull();
    expect(typeof me!.id).toBe("string");
  });
});

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHost } from "../src/nodeHost";
import { pageList, pageRead, pageWrite, vaultGet, vaultSet, vaultList } from "@orden/mcp";

// The MCP tools operate on a real Host. We test the tool functions directly
// (the MCP transport is verified separately/live) against a disk-backed NodeHost.

let root: string;
let host: NodeHost;
const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-tools-"));
  host = new NodeHost({ vaultRoot: root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("MCP tools over the Host", () => {
  test("page_write then page_read round-trips markdown", async () => {
    await pageWrite(host, "Ideas", "# Ideas\n\n- one");
    expect(textOf(await pageRead(host, "Ideas"))).toBe("# Ideas\n\n- one");
  });

  test("page_write persists into the vault 'pages' namespace (visible to the app)", async () => {
    await pageWrite(host, "Ideas", "# Ideas");
    expect(await host.vault.get("pages", "Ideas")).toBe("# Ideas");
  });

  test("page_list shows written pages", async () => {
    await pageWrite(host, "A", "a");
    await pageWrite(host, "B", "b");
    expect(textOf(await pageList(host)).split("\n").sort()).toEqual(["A", "B"]);
  });

  test("page_read reports not-found for a missing page", async () => {
    expect(textOf(await pageRead(host, "Nope")).toLowerCase()).toContain("not found");
  });

  test("vault_set (JSON) then vault_get round-trips a structured value", async () => {
    await vaultSet(host, "notes", "n1", '{"done":true,"n":3}');
    expect(textOf(await vaultGet(host, "notes", "n1"))).toBe('{"done":true,"n":3}');
    expect(await host.vault.get("notes", "n1")).toEqual({ done: true, n: 3 });
  });

  test("vault_set falls back to a raw string when the value isn't JSON", async () => {
    await vaultSet(host, "notes", "raw", "just text");
    expect(await host.vault.get("notes", "raw")).toBe("just text");
  });

  test("vault_list lists keys in a namespace", async () => {
    await vaultSet(host, "ns", "a", "1");
    await vaultSet(host, "ns", "b", "2");
    expect(textOf(await vaultList(host, "ns")).split("\n").sort()).toEqual(["a", "b"]);
  });
});

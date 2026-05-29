import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@orden/host-api";
import { NodeHost } from "../src/nodeHost";
import { connectHostClient } from "../src/rpc";
import { startHostServer } from "../src/wsServer";
import { createWsTransport } from "../src/wsTransport";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-change-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NodeHost change events", () => {
  test("onChange fires with {ns,key} when the vault is written", async () => {
    const host = new NodeHost({ vaultRoot: root });
    const seen: { ns: string; key: string }[] = [];
    host.onChange((e) => seen.push(e));
    await host.vault.set("pages", "Hello", "# hi");
    await host.vault.delete("pages", "Hello");
    expect(seen).toEqual([
      { ns: "pages", key: "Hello" },
      { ns: "pages", key: "Hello" },
    ]);
  });

  test("onChange returns an unsubscribe", async () => {
    const host = new NodeHost({ vaultRoot: root });
    const seen: unknown[] = [];
    const off = host.onChange((e) => seen.push(e));
    off();
    await host.vault.set("ns", "k", 1);
    expect(seen).toEqual([]);
  });
});

describe("change feed over the ws bus", () => {
  test("a client receives a change frame when the vault is written", async () => {
    const server = await startHostServer(new NodeHost({ vaultRoot: root }), { port: 0 });
    const conn = await createWsTransport(`ws://127.0.0.1:${server.port}`);
    const client: Host = await connectHostClient(conn.transport);

    const events: { type: string; ns: string; key: string }[] = [];
    conn.onEvent((e) => events.push(e));

    await client.vault.set("pages", "Live", "# live");
    // give the broadcast a tick to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toContainEqual({ type: "change", ns: "pages", key: "Live" });

    await conn.close();
    await server.close();
  });
});

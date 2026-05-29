import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@orden/host-api";
import { NodeHost } from "../src/nodeHost";
import { connectHostClient } from "../src/rpc";
import { startHostServer } from "../src/wsServer";
import { createWsTransport } from "../src/wsTransport";

// End-to-end over a real WebSocket: a ws server in front of a NodeHost, a
// client connected by socket. This is the actual production transport — the
// in-process rpc test proves the dispatch logic; this proves the wire.

let root: string;
let server: Awaited<ReturnType<typeof startHostServer>>;
let conn: Awaited<ReturnType<typeof createWsTransport>>;
let client: Host;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-ws-"));
  server = await startHostServer(new NodeHost({ vaultRoot: root }), { port: 0 });
  conn = await createWsTransport(`ws://127.0.0.1:${server.port}`);
  client = await connectHostClient(conn.transport);
});

afterEach(async () => {
  await conn.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("Host over WebSocket", () => {
  test("vault round-trips over the socket and persists on the server", async () => {
    await client.vault.set("settings", "theme", { mode: "dark" });
    expect(await client.vault.get("settings", "theme")).toEqual({ mode: "dark" });
  });

  test("capabilities() resolves over the socket", () => {
    expect(client.capabilities().persistentVault).toBe(true);
  });

  test("concurrent requests are matched to their own responses by id", async () => {
    await Promise.all([
      client.vault.set("ns", "a", 1),
      client.vault.set("ns", "b", 2),
      client.vault.set("ns", "c", 3),
    ]);
    const [a, b, c] = await Promise.all([
      client.vault.get("ns", "a"),
      client.vault.get("ns", "b"),
      client.vault.get("ns", "c"),
    ]);
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  test("a host-side error propagates to the client over the socket", async () => {
    await expect(
      client.sessions.spawn("p1", { title: "x", agent: "claude" }),
    ).rejects.toThrow(/not implemented yet/);
  });
});

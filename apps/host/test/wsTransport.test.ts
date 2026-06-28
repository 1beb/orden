import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
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
    ).rejects.toThrow(/create sessions from the UI/);
  });
});

// A controllable fake socket for transport-resilience tests: opens on a
// microtask after construction (like a real ws), send() throws unless OPEN,
// close() fires onclose. Lets us exercise the drop/reconnect window without a
// real server or real timers. Records every instance so a test can grab the
// live socket to drop it.
class FakeSock {
  static instances: FakeSock[] = [];
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  open = false;
  constructor(url: string) {
    this.url = url;
    FakeSock.instances.push(this);
    queueMicrotask(() => {
      this.open = true;
      this.onopen?.({});
    });
  }
  send(data: string): void {
    void data;
    if (!this.open) throw new Error("InvalidStateError");
  }
  close(): void {
    this.open = false;
    this.onclose?.({});
  }
}

describe("wsTransport resilience", () => {
  beforeEach(() => {
    FakeSock.instances = [];
  });

  test("a request fired while the socket is down fails fast instead of hanging", async () => {
    // Regression: a request made during the reconnect window used to be added
    // to `pending` then orphaned (send threw, was swallowed), so it never
    // settled and the caller hung — a doc click that did nothing. It must now
    // reject immediately with "connection lost".
    vi.useFakeTimers();
    try {
      const c = await createWsTransport("ws://fake", FakeSock);
      // Drop the live socket: failPending runs, a reconnect is scheduled on a
      // faked timer we never advance, so no replacement socket appears yet.
      FakeSock.instances[FakeSock.instances.length - 1].close();
      // A request fired in that dead window must settle, not hang.
      const res = await c.transport({ id: 1, path: ["vault", "get"], args: [] });
      expect(res).toEqual({ id: 1, ok: false, error: "connection lost" });
      await c.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a request sent while the socket is open is still tracked normally", async () => {
    // Guard against the fix over-correcting: an OPEN socket must still record
    // the request so its response can settle it.
    vi.useFakeTimers();
    try {
      const c = await createWsTransport("ws://fake", FakeSock);
      const live = FakeSock.instances[FakeSock.instances.length - 1];
      const p = c.transport({ id: 2, path: ["vault", "get"], args: [] });
      // Socket was open → request is on the wire; deliver a response by hand.
      live.onmessage?.({ data: JSON.stringify({ id: 2, ok: true, result: 42 }) });
      await expect(p).resolves.toEqual({ id: 2, ok: true, result: 42 });
      await c.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

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
  // The change feed is for FOREIGN writes: a connection is its own subscription,
  // so the server must NOT echo a client's own write back to it (the client
  // already updated its synchronous cache). Echoing self was the source of a
  // flaky bug — a host-side state flip (e.g. a hook moving a card to
  // in-progress) landing on a key the client had just written looked
  // indistinguishable from a self-echo and got dropped client-side. The fix is
  // server-side origin attribution: don't send a change to the connection that
  // caused it; send it to everyone else.
  test("the originating client does NOT receive its own write back", async () => {
    const server = await startHostServer(new NodeHost({ vaultRoot: root }), { port: 0 });
    const conn = await createWsTransport(`ws://127.0.0.1:${server.port}`);
    const client: Host = await connectHostClient(conn.transport);

    const events: { type: string; ns: string; key: string }[] = [];
    conn.onEvent((e) => events.push(e));

    await client.vault.set("pages", "Live", "# live");
    // give any (erroneous) broadcast a tick to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(events).not.toContainEqual({ type: "change", ns: "pages", key: "Live" });

    await conn.close();
    await server.close();
  });

  test("a second client DOES receive another client's write", async () => {
    const server = await startHostServer(new NodeHost({ vaultRoot: root }), { port: 0 });
    const connA = await createWsTransport(`ws://127.0.0.1:${server.port}`);
    const connB = await createWsTransport(`ws://127.0.0.1:${server.port}`);
    const clientA: Host = await connectHostClient(connA.transport);

    const seenByA: { type: string; ns: string; key: string }[] = [];
    const seenByB: { type: string; ns: string; key: string }[] = [];
    connA.onEvent((e) => seenByA.push(e));
    connB.onEvent((e) => seenByB.push(e));
    // let both connections settle so the server has wired both change listeners
    await new Promise((r) => setTimeout(r, 20));

    await clientA.vault.set("pages", "Live", "# live");
    await new Promise((r) => setTimeout(r, 50));

    // B (the observer) sees A's write; A (the author) does not get its own echo.
    expect(seenByB).toContainEqual({ type: "change", ns: "pages", key: "Live" });
    expect(seenByA).not.toContainEqual({ type: "change", ns: "pages", key: "Live" });

    await connA.close();
    await connB.close();
    await server.close();
  });

  test("a host-side write (no originating client) reaches every client", async () => {
    // Reactors, hooks, MCP agents and the idle reconciler write straight through
    // host.vault — not over any client's RPC — so they have no origin and MUST
    // broadcast to all connected clients (this is how an agent's card_move
    // reaches the board).
    const host = new NodeHost({ vaultRoot: root });
    const server = await startHostServer(host, { port: 0 });
    const conn = await createWsTransport(`ws://127.0.0.1:${server.port}`);
    await connectHostClient(conn.transport);

    const events: { type: string; ns: string; key: string }[] = [];
    conn.onEvent((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 20));

    await host.vault.set("cards", "item_x", { state: "in-progress" });
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toContainEqual({ type: "change", ns: "cards", key: "item_x" });

    await conn.close();
    await server.close();
  });

  test("a files change carrying projectId round-trips over the feed", async () => {
    // The watcher (Task 4) is what will set projectId on real `files` changes;
    // here we drive the feed directly through a fake ChangeSource host to prove
    // the projectId survives the wsServer send + wsTransport receive plumbing.
    let emit: ((change: { ns: string; key: string; projectId?: string }) => void) | undefined;
    const fakeHost = {
      onChange(listener: (change: { ns: string; key: string; projectId?: string }) => void) {
        emit = listener;
        return () => {
          emit = undefined;
        };
      },
    } as unknown as Host;

    const server = await startHostServer(fakeHost, { port: 0 });
    const conn = await createWsTransport(`ws://127.0.0.1:${server.port}`);

    const events: { type: string; ns: string; key: string; projectId?: string }[] = [];
    conn.onEvent((e) => events.push(e));
    // let the connection settle so the server has wired the change listener
    await new Promise((r) => setTimeout(r, 20));

    emit?.({ ns: "files", key: "docs/readme.md", projectId: "proj_x" });
    await new Promise((r) => setTimeout(r, 50));

    const received = events.find((e) => e.ns === "files");
    expect(received).toBeDefined();
    expect(received?.projectId).toBe("proj_x");

    await conn.close();
    await server.close();
  });
});

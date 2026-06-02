import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@orden/host-api";
import { NodeHost } from "../src/nodeHost";
import { dispatch, connectHostClient } from "../src/rpc";

// The whole point of the RPC layer: a client built over a transport is a
// drop-in Host, indistinguishable from a local one to the UI. We prove that
// against a *real* NodeHost wired through an in-process transport (the WS
// transport is just another implementation of the same Transport function).

let root: string;
let server: NodeHost;
let client: Host;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-rpc-"));
  server = new NodeHost({ vaultRoot: root });
  client = await connectHostClient((req) => dispatch(server, req));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Host RPC", () => {
  test("a nested capability method round-trips through the transport", async () => {
    await client.vault.set("settings", "theme", { mode: "dark" });
    expect(await client.vault.get("settings", "theme")).toEqual({ mode: "dark" });
    // ...and it actually hit the server's disk vault, not a client-side cache.
    expect(await server.vault.get("settings", "theme")).toEqual({ mode: "dark" });
  });

  test("capabilities() is available synchronously on the client", () => {
    expect(client.capabilities()).toEqual(server.capabilities());
  });

  test("chat is exposed: the client proxy forwards chat.listModels", async () => {
    // Proves "chat" is in CAPABILITIES — the client proxy only forwards names it
    // knows. listModels is static on the real claude adapter (spawns nothing).
    const models = await client.chat!.listModels("claude");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.harness === "claude")).toBe(true);
  });

  test("a method that throws on the host rejects on the client with its message", async () => {
    await expect(
      client.sessions.spawn("p1", { title: "x", agent: "claude" }),
    ).rejects.toThrow(/create sessions from the UI/);
  });
});

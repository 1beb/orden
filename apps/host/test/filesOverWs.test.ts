import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@orden/host-api";
import { NodeHost } from "../src/nodeHost";
import { connectHostClient } from "../src/rpc";
import { startHostServer } from "../src/wsServer";
import { createWsTransport } from "../src/wsTransport";

// The web app's boot path: getHost() -> NodeHost over ws -> host.files.list().
// Prove repo files come across the wire (this is what unblocks running the web
// app against the NodeHost).

let vaultRoot: string;
let filesRoot: string;
let server: Awaited<ReturnType<typeof startHostServer>>;
let conn: Awaited<ReturnType<typeof createWsTransport>>;
let client: Host;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "orden-vault-"));
  filesRoot = await mkdtemp(join(tmpdir(), "orden-files-"));
  await writeFile(join(filesRoot, "readme.md"), "# Readme\n\nhi");
  await mkdir(join(filesRoot, "docs"), { recursive: true });
  await writeFile(join(filesRoot, "docs", "plan.md"), "# The Plan");
  server = await startHostServer(new NodeHost({ vaultRoot, filesRoot }), { port: 0 });
  conn = await createWsTransport(`ws://127.0.0.1:${server.port}`);
  client = await connectHostClient(conn.transport);
});
afterEach(async () => {
  await conn.close();
  await server.close();
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(filesRoot, { recursive: true, force: true });
});

describe("files over ws (web boot path)", () => {
  test("files.list returns the host's markdown files across the wire", async () => {
    const list = await client.files.list("repo");
    expect(list.map((f) => f.path).sort()).toEqual(["docs/plan.md", "readme.md"]);
    expect(list.find((f) => f.path === "docs/plan.md")?.title).toBe("The Plan");
  });

  test("files.read returns content across the wire", async () => {
    expect(await client.files.read("repo", "readme.md")).toBe("# Readme\n\nhi");
  });
});

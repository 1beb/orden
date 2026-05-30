import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskVault } from "../src/diskVault";
import { NodeSessions } from "../src/nodeSessions";

let root: string;
let vault: DiskVault;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-sess-"));
  vault = new DiskVault(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NodeSessions", () => {
  // Chat mode (the `claude -p` prompt path) was removed — sessions run as the
  // interactive TUI (terminal.ts). prompt() must surface loudly, never silently
  // shell out to `claude -p`.
  test("prompt() is no longer supported (TUI-only)", async () => {
    const sessions = new NodeSessions({ vault, defaultCwd: root });
    await expect(sessions.prompt("s1", "hello")).rejects.toThrow(/TUI/);
  });

  test("list() returns nothing — the web reads sessions from the vault", async () => {
    const sessions = new NodeSessions({ vault, defaultCwd: root });
    expect(await sessions.list()).toEqual([]);
  });
});

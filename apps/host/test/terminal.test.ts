import { describe, test, expect, afterEach } from "vitest";
import { mcpConfigArg, settingsArg, launchDetached } from "../src/terminal";
import type { Host } from "@orden/host-api";

const ORIGINAL_PORT = process.env.ORDEN_PORT;
afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.ORDEN_PORT;
  else process.env.ORDEN_PORT = ORIGINAL_PORT;
});

// Parse the JSON back out of the `--mcp-config '<json>'` fragment.
function parseConfig(arg: string): { mcpServers: Record<string, { type: string; url: string }> } {
  const m = arg.match(/^--mcp-config '(.*)'$/s);
  if (!m) throw new Error(`unexpected fragment: ${arg}`);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

describe("mcpConfigArg", () => {
  test("binds an 'orden' http server to the session-scoped /mcp/<convId> path", () => {
    delete process.env.ORDEN_PORT;
    const arg = mcpConfigArg("conv-123");
    expect(arg.startsWith("--mcp-config ")).toBe(true);
    const cfg = parseConfig(arg);
    expect(cfg.mcpServers.orden).toEqual({
      type: "http",
      url: "http://127.0.0.1:4319/mcp/conv-123",
    });
  });

  test("uses ORDEN_PORT when set", () => {
    process.env.ORDEN_PORT = "5555";
    const cfg = parseConfig(mcpConfigArg("abc"));
    expect(cfg.mcpServers.orden.url).toBe("http://127.0.0.1:5555/mcp/abc");
  });
});

// Reverse shquote's single-quote escaping (`'` -> `'\''`) to recover the inline
// JSON. settingsArg's curl commands contain single quotes (around the URL), so
// this exercises the escaping path mcpConfigArg's quote-free JSON never hits.
function parseSettings(arg: string): {
  hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
} {
  const m = arg.match(/^--settings '(.*)'$/s);
  if (!m) throw new Error(`unexpected fragment: ${arg}`);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

describe("settingsArg", () => {
  test("injects the kanban state + subagent-tracking hooks, port-templated", () => {
    delete process.env.ORDEN_PORT;
    const arg = settingsArg();
    expect(arg.startsWith("--settings ")).toBe(true);
    const s = parseSettings(arg);
    // The state edges that drive the automatic working/waiting cycle, plus the
    // SubagentStart/Stop pair that gates Stop on in-flight background work.
    expect(Object.keys(s.hooks).sort()).toEqual(
      [
        "Notification",
        "PostToolUse",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    const cmdOf = (e: string) => s.hooks[e][0].hooks[0].command;
    expect(cmdOf("UserPromptSubmit")).toContain("/hooks/session-state?state=in-progress");
    expect(cmdOf("PostToolUse")).toContain("/hooks/session-state?state=in-progress");
    expect(cmdOf("Stop")).toContain("/hooks/session-state?state=blocked");
    expect(cmdOf("SubagentStart")).toContain("/hooks/session-subagent?delta=start");
    expect(cmdOf("SubagentStop")).toContain("/hooks/session-subagent?delta=stop");
    expect(cmdOf("Notification")).toContain("/hooks/notification");
    expect(cmdOf("Stop")).toContain("http://127.0.0.1:4319/");
  });

  test("uses ORDEN_PORT when set", () => {
    process.env.ORDEN_PORT = "5555";
    const s = parseSettings(settingsArg());
    expect(s.hooks.PostToolUse[0].hooks[0].command).toContain("http://127.0.0.1:5555/");
  });
});

describe("launchDetached", () => {
  // Guard path only: a missing session record short-circuits BEFORE any tmux
  // spawn, so this never touches tmux (which we must not run in tests).
  test("returns without spawning when the session record is missing", async () => {
    let getCalled = false;
    const host = {
      vault: {
        get: async () => {
          getCalled = true;
          return null;
        },
        set: async () => {
          throw new Error("set should not be called for a missing session");
        },
        list: async () => [],
        delete: async () => {},
      },
    } as unknown as Host;
    await expect(launchDetached(host, "/tmp", "sess_missing")).resolves.toBeUndefined();
    expect(getCalled).toBe(true);
  });
});

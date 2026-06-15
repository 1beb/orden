import { describe, it, expect, afterEach } from "vitest";
import { playwrightMcpPids, killPlaywrightMcp, type Proc } from "../src/killPlaywrightMcp";

// The three real Playwright MCP shapes (server npm exec, server bin, MCP browser)
// plus processes that must NOT be touched (the orden host, an unrelated chrome,
// a claude agent session).
const PROCS: Proc[] = [
  { pid: 17630, cmd: "npm exec @playwright/mcp@latest --browser chromium --headless" },
  { pid: 17798, cmd: "node /home/b/.npm/_npx/abc/node_modules/.bin/playwright-mcp --browser chromium" },
  {
    pid: 124819,
    cmd: "/home/b/.cache/ms-playwright/chromium-1226/chrome-linux64/chrome --user-data-dir=/home/b/.cache/ms-playwright-mcp/mcp-chrome-for-testing-81f8963 --headless",
  },
  { pid: 255655, cmd: "/usr/bin/node --import tsx src/serve.ts" }, // orden host
  { pid: 196553, cmd: "/opt/helium/helium --type=renderer" }, // user's browser
  { pid: 244583, cmd: "claude --mcp-config {orden} --session-id abc the task prompt" }, // agent
];

describe("playwrightMcpPids", () => {
  it("matches all three Playwright MCP shapes and nothing else", () => {
    expect(playwrightMcpPids(PROCS, /*self*/ 999).sort((a, b) => a - b)).toEqual([
      17630, 17798, 124819,
    ]);
  });

  it("never returns its own pid (so the host can't kill itself)", () => {
    // If the host's own cmdline somehow matched, self-exclusion still protects it.
    const withSelf: Proc[] = [{ pid: 4242, cmd: "node playwright-mcp serve" }];
    expect(playwrightMcpPids(withSelf, 4242)).toEqual([]);
  });

  it("excludes init/pid<=1", () => {
    expect(playwrightMcpPids([{ pid: 1, cmd: "playwright-mcp" }], 999)).toEqual([]);
  });
});

describe("killPlaywrightMcp", () => {
  afterEach(() => {
    delete process.env.ORDEN_KEEP_PLAYWRIGHT;
  });

  it("kills each matching pid and reports them", () => {
    const killed: number[] = [];
    const logs: string[] = [];
    const result = killPlaywrightMcp({
      list: () => PROCS,
      selfPid: 255655,
      kill: (pid) => killed.push(pid),
      log: (m) => logs.push(m),
    });
    expect(result.sort((a, b) => a - b)).toEqual([17630, 17798, 124819]);
    expect(killed.sort((a, b) => a - b)).toEqual([17630, 17798, 124819]);
    expect(logs[0]).toMatch(/killed 3 stray Playwright MCP/);
  });

  it("is a no-op (kills nothing, logs nothing) when ORDEN_KEEP_PLAYWRIGHT=1", () => {
    process.env.ORDEN_KEEP_PLAYWRIGHT = "1";
    const killed: number[] = [];
    const logs: string[] = [];
    const result = killPlaywrightMcp({
      list: () => PROCS,
      kill: (pid) => killed.push(pid),
      log: (m) => logs.push(m),
    });
    expect(result).toEqual([]);
    expect(killed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("does not log when there is nothing to kill", () => {
    const logs: string[] = [];
    killPlaywrightMcp({ list: () => [], kill: () => {}, log: (m) => logs.push(m) });
    expect(logs).toEqual([]);
  });
});

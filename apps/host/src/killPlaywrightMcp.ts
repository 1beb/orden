// On host (re)start, terminate stray Playwright MCP services.
//
// A Playwright MCP browser left open from an earlier agent run keeps whatever tab
// it last had — including an orden tab pointed at this host. After the host
// restarts, that tab reconnects and re-hydrates in a tight loop, flooding the WS
// RPC with vault reads until a core is pegged (observed 2026-06-15). We don't try
// to preserve Playwright across a restart: an agent that still needs it is simply
// relaunched by the operator (the session blocks; the operator tells it to redo).
//
// So at boot we SIGKILL every Playwright MCP process. Matches all three shapes
// seen in the wild via one pattern, `playwright[/-]mcp`:
//   npm exec @playwright/mcp@latest ...                      (playwright/mcp)
//   sh -c playwright-mcp / node .../playwright-mcp            (playwright-mcp)
//   chrome --user-data-dir=.../ms-playwright-mcp/...          (ms-playwright-mcp)
//
// Opt out with ORDEN_KEEP_PLAYWRIGHT=1.
import { readdirSync, readFileSync } from "node:fs";

const PLAYWRIGHT_MCP = /playwright[/-]mcp/;

export interface Proc {
  pid: number;
  cmd: string;
}

// Pure: which pids to kill from a process list. Excludes self, init, and any
// cmdline that doesn't name a Playwright MCP service/browser. Injectable so the
// match logic is unit-tested without touching /proc or signalling anything.
export function playwrightMcpPids(procs: Proc[], selfPid: number): number[] {
  return procs
    .filter((p) => p.pid > 1 && p.pid !== selfPid && PLAYWRIGHT_MCP.test(p.cmd))
    .map((p) => p.pid);
}

// Enumerate /proc into {pid, cmd}. Linux-only; returns [] where /proc is absent.
function listProcs(): Proc[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const out: Proc[] = [];
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid)) continue;
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!raw) continue; // kernel threads have an empty cmdline
      out.push({ pid, cmd: raw.replace(/\0/g, " ").trim() });
    } catch {
      // process exited between readdir and read, or unreadable — skip.
    }
  }
  return out;
}

export interface KillPlaywrightDeps {
  list?: () => Proc[];
  kill?: (pid: number) => void;
  selfPid?: number;
  log?: (msg: string) => void;
}

// Best-effort: SIGKILL every stray Playwright MCP service/browser. Returns the
// pids it killed (for logging/tests). No-op when ORDEN_KEEP_PLAYWRIGHT=1.
export function killPlaywrightMcp(deps: KillPlaywrightDeps = {}): number[] {
  if (process.env.ORDEN_KEEP_PLAYWRIGHT === "1") return [];
  const list = deps.list ?? listProcs;
  const selfPid = deps.selfPid ?? process.pid;
  const log = deps.log ?? ((m: string) => console.log(m));
  const kill =
    deps.kill ??
    ((pid: number) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone / not ours — nothing to do.
      }
    });
  const pids = playwrightMcpPids(list(), selfPid);
  for (const pid of pids) kill(pid);
  if (pids.length) log(`orden: killed ${pids.length} stray Playwright MCP process(es) on boot`);
  return pids;
}

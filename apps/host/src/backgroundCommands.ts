// Background-command liveness: "does this claude session still have a shell
// running?" — the signal that keeps a card in-progress while a long command
// works, instead of parking it at blocked.
//
// WHY a process check and not a hook. A `run_in_background: true` Bash command
// returns its tool call immediately ("Command running in background with ID: X")
// and keeps running AFTER the agent ends its turn. The turn-end fires Stop, which
// would normally block the card — but the shell is plainly still working. Claude
// auto-wakes the agent when the shell finishes (an injected
// "[SYSTEM NOTIFICATION - NOT USER INPUT]"), but that wake fires NO hook we can
// catch (not UserPromptSubmit, not a dedicated TaskCompleted — those are for the
// teammate/todo task store, not background shells). The shell's `.output` file
// mtime goes stale while a quiet command runs, and claude holds no fd on it. So
// the only durable, reliable truth is the OS process tree.
//
// HOW we read it. The host can't see the claude pid directly — claude runs under
// a tmux pane — so we find it by the `--session-id <conversationId>` it was
// launched with (terminal.ts bakes it in). A Bash tool invocation runs as a
// DIRECT child of claude: `/bin/bash -c source <shell-snapshots/snapshot-*.sh>
// ... && eval '<command>' ... && pwd -P >| /tmp/claude-*-cwd`. That snapshot
// wrapper is unique to claude's Bash tool — MCP servers, the playwright node, and
// every other child lack it. At a Stop or an idle-reconcile moment the agent is
// running no FOREGROUND tool, so a live wrapper child can only be a
// run_in_background command still going. (During a long FOREGROUND command the
// same child exists, which is equally correct: the card should be in-progress.)
//
// Linux-only (reads /proc); the orden host runs on Linux. On any platform without
// /proc this degrades to "no live command" (false), i.e. the prior behavior.

import { readdirSync, readFileSync } from "node:fs";

/** One process: its pid, parent pid, and NUL-normalized cmdline. */
export interface ProcRow {
  pid: number;
  ppid: number;
  cmdline: string;
}

// The claude Bash-tool wrapper sources a per-session shell snapshot; nothing else
// claude spawns does. Matching this substring on a direct child of the session's
// claude pinpoints a live command without false positives from MCP servers.
const WRAPPER_SIGNATURE = "shell-snapshots/snapshot-";

/**
 * Pure core (injectable for tests): given a process snapshot, does the claude
 * process running `conversationId` have a live Bash-wrapper child? Empty
 * conversationId never matches (a blank substring would match every cmdline).
 */
export function hasLiveBackgroundCommandIn(procs: ProcRow[], conversationId: string): boolean {
  if (!conversationId) return false;
  const claudePids = new Set<number>();
  for (const p of procs) {
    if (p.cmdline.includes(`--session-id ${conversationId}`)) claudePids.add(p.pid);
  }
  if (claudePids.size === 0) return false;
  return procs.some((p) => claudePids.has(p.ppid) && p.cmdline.includes(WRAPPER_SIGNATURE));
}

/** Read a process table from /proc. Returns [] off Linux or on any read error. */
export function readProcTable(): ProcRow[] {
  const rows: ProcRow[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return rows; // no /proc (non-Linux) — degrade to "no live command"
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let cmdline: string;
    try {
      // /proc/<pid>/cmdline is NUL-separated; normalize to spaces for matching.
      cmdline = readFileSync(`/proc/${name}/cmdline`).toString("utf8").replace(/\0/g, " ").trim();
    } catch {
      continue; // process exited between readdir and read — skip
    }
    if (!cmdline) continue; // kernel threads have an empty cmdline
    let ppid = 0;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // Fields: pid (comm) state ppid ...  — comm can contain spaces/parens, so
      // parse after the LAST ')': [state, ppid, ...].
      const rparen = stat.lastIndexOf(")");
      const after = stat.slice(rparen + 2).split(" ");
      ppid = Number(after[1]);
    } catch {
      continue;
    }
    rows.push({ pid: Number(name), ppid, cmdline });
  }
  return rows;
}

/**
 * Is a background (or long foreground) command still running for the claude
 * session identified by `conversationId`? Reads the live /proc table. Never
 * throws — any failure degrades to false (prior block-on-Stop behavior).
 */
export function hasLiveBackgroundCommand(conversationId: string): boolean {
  if (!conversationId) return false;
  try {
    return hasLiveBackgroundCommandIn(readProcTable(), conversationId);
  } catch {
    return false;
  }
}

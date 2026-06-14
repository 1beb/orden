import { describe, test, expect } from "vitest";
import { hasLiveBackgroundCommandIn, type ProcRow } from "../src/backgroundCommands";

// A claude process for a session carries `--session-id <conversationId>` in its
// cmdline; the host can't see the claude pid directly (claude runs under a tmux
// pane), so it finds it by that substring. A run_in_background Bash command runs
// as a DIRECT child whose cmdline carries the Bash-tool wrapper signature
// (`shell-snapshots/snapshot-`). MCP servers and other children never do.
const CONV = "da05bc3d-cb03-4a9e-bf84-a7b0aa1a7b59";
const claudeCmd = `/home/b/.local/bin/claude --mcp-config {...} --settings {...} --session-id ${CONV} please run`;
const wrapperCmd =
  "/bin/bash -c source /home/b/.claude/shell-snapshots/snapshot-bash-1781185087879-061cm8.sh 2>/dev/null || true && eval 'uv run yggpu run 20' < /dev/null && pwd -P >| /tmp/claude-1000/claude-6e42-cwd";

function rows(...rs: ProcRow[]): ProcRow[] {
  return rs;
}

describe("hasLiveBackgroundCommandIn (process-tree liveness for background shells)", () => {
  test("true when the session's claude has a live Bash-wrapper child", () => {
    const procs = rows(
      { pid: 100, ppid: 1, cmdline: claudeCmd },
      { pid: 200, ppid: 100, cmdline: wrapperCmd },
    );
    expect(hasLiveBackgroundCommandIn(procs, CONV)).toBe(true);
  });

  test("false when the claude has only MCP-server children (no wrapper)", () => {
    const procs = rows(
      { pid: 100, ppid: 1, cmdline: claudeCmd },
      { pid: 201, ppid: 100, cmdline: "npm exec @playwright/mcp@latest --headless" },
      { pid: 202, ppid: 100, cmdline: "node /home/b/.npm-global/bin/codegraph serve --mcp" },
      { pid: 203, ppid: 100, cmdline: "/home/b/.local/bin/uv tool uvx voice-mode" },
    );
    expect(hasLiveBackgroundCommandIn(procs, CONV)).toBe(false);
  });

  test("false when no claude process matches the conversation id", () => {
    const procs = rows({ pid: 200, ppid: 999, cmdline: wrapperCmd });
    expect(hasLiveBackgroundCommandIn(procs, CONV)).toBe(false);
  });

  test("false for an empty conversation id (never matches everything)", () => {
    const procs = rows({ pid: 100, ppid: 1, cmdline: claudeCmd }, { pid: 200, ppid: 100, cmdline: wrapperCmd });
    expect(hasLiveBackgroundCommandIn(procs, "")).toBe(false);
  });

  test("does not cross sessions: a wrapper under a DIFFERENT claude doesn't count", () => {
    const otherConv = "aaaaaaaa-0000-0000-0000-000000000000";
    const procs = rows(
      { pid: 100, ppid: 1, cmdline: claudeCmd }, // our session, no wrapper child
      { pid: 110, ppid: 1, cmdline: `/home/b/.local/bin/claude --session-id ${otherConv} other` },
      { pid: 210, ppid: 110, cmdline: wrapperCmd }, // wrapper belongs to the OTHER claude
    );
    expect(hasLiveBackgroundCommandIn(procs, CONV)).toBe(false);
  });

  test("only a DIRECT child counts, not a deeper descendant", () => {
    // The wrapper bash is always a direct child of claude; its own children
    // (uv, python) carry the work but not the wrapper signature, so matching the
    // signature on direct children is the precise test.
    const procs = rows(
      { pid: 100, ppid: 1, cmdline: claudeCmd },
      { pid: 200, ppid: 100, cmdline: wrapperCmd }, // direct child wrapper -> counts
      { pid: 300, ppid: 200, cmdline: "uv run yggpu run 20" }, // grandchild, no signature
    );
    expect(hasLiveBackgroundCommandIn(procs, CONV)).toBe(true);
  });
});

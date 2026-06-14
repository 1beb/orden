// opencode kanban state plugin GENERATOR: mirrors what settingsArg() does for
// Claude hooks. Opencode has no inline --settings, so we generate a tiny plugin
// file and point opencode at it via OPENCODE_CONFIG_DIR. The plugin uses
// fetch() (Bun's in-process HTTP) to POST state transitions to the host.
// Sessions are mapped via ORDEN_SESSION_ID (not conversationId) so the host
// doesn't need the opencode session id to be pre-registered — the first event
// (session.created) carries the opencode id and the host persists it then.
//
// Event mapping:
//   session.created / session.updated / tool.execute.after -> in-progress
//   session.idle                                          -> blocked
//
// Subagent gating (Claude's SubagentStart/Stop) is not wired for opencode yet;
// session.idle fires even while child sessions run, which may cause premature
// blocked transitions during subagent workflows.
//
// The plugin also carries the destructive-git guardrail (tool.execute.before):
// in a SHARED checkout (ORDEN_WORKTREE != 1) it throws on the git commands
// that wipe uncommitted state, mirroring the claude PreToolUse deny in
// hooks.ts. The patterns and denial text are EMBEDDED from the shared
// destructiveGit module at generation time, so the two consumers cannot drift.
// Throwing in tool.execute.before aborts the call in opencode's plugin
// protocol; if a future opencode version changes that, the guard degrades to a
// logged error — instructions remain the fallback layer.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { destructiveGitArrayLiteral, DESTRUCTIVE_GIT_DENY_REASON } from "./destructiveGit";

export function opencodePluginSource(): string {
  return `// auto-generated orden kanban plugin — do not edit
export const OrdenKanban = async () => {
  const PORT = process.env.ORDEN_PORT || "4319"
  const ORDEN_SID = process.env.ORDEN_SESSION_ID || ""
  const DESTRUCTIVE_GIT = ${destructiveGitArrayLiteral()}

  const post = async (path, extra) => {
    try {
      await fetch("http://127.0.0.1:" + PORT + "/hooks/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...extra, orden_session_id: ORDEN_SID }),
      })
    } catch (e) {
      console.error("[orden-kanban] hook post failed:", String(e))
    }
  }

  return {
    event: async ({ event }) => {
      if (!event?.type) return
      if (event.type === "session.created") {
        await post("session-state?state=in-progress", { session_id: event.properties?.id })
      }
      if (event.type === "session.idle") {
        await post("session-state?state=blocked")
      }
      if (event.type === "session.updated") {
        await post("session-state?state=in-progress")
      }
    },
    "tool.execute.before": async (input, output) => {
      if (process.env.ORDEN_WORKTREE === "1") return
      if (input?.tool !== "bash") return
      const cmd = String(output?.args?.command ?? "")
      if (DESTRUCTIVE_GIT.some((re) => re.test(cmd))) {
        throw new Error(${JSON.stringify(DESTRUCTIVE_GIT_DENY_REASON)})
      }
    },
    "tool.execute.after": async () => {
      await post("session-state?state=in-progress")
    },
  }
}
`;
}

// Create the plugin directory for an opencode session. Returns the path that
// should be set as OPENCODE_CONFIG_DIR. Idempotent — reattach reuses the same
// directory so the plugin file is only written once per session id.
//
// Also writes an opencode.json that scopes the orden MCP server to this session
// (via /mcp/<sessionId>), overriding any global orden MCP entry. Without this,
// opencode connects to the global /mcp (unbound) and tools like learning_propose
// and card_complete can't resolve "my card" automatically — they need the session
// binding that the URL path provides. The global config's OTHER MCP servers (e.g.
// codegraph) are preserved because opencode merges configs.
export function ensureOpencodePluginDir(sessionId: string): string {
  const dir = `${homedir()}/.orden/opencode-plugins/${sessionId}`;
  const pluginsDir = `${dir}/plugins`;
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ type: "module" }), "utf8");
  writeFileSync(`${pluginsDir}/orden-kanban.js`, opencodePluginSource(), "utf8");
  const port = process.env.ORDEN_PORT ?? 4319;
  writeFileSync(
    `${dir}/opencode.json`,
    JSON.stringify(
      {
        mcp: {
          orden: {
            type: "remote",
            url: `http://127.0.0.1:${port}/mcp/${sessionId}`,
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

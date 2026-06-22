// opencode kanban state plugin GENERATOR: mirrors what settingsArg() does for
// Claude hooks. Opencode has no inline --settings, so we generate a tiny plugin
// file and point opencode at it via OPENCODE_CONFIG_DIR. The plugin uses
// fetch() (Bun's in-process HTTP) to POST state transitions to the host.
// Sessions are mapped via ORDEN_SESSION_ID (not conversationId) so the host
// doesn't need the opencode session id to be pre-registered — the first event
// (session.created) carries the opencode id and the host persists it then.
//
// Event mapping (driven by opencode's authoritative session.status enum):
//   session.status{busy|retry} / tool.execute.after / permission.replied -> in-progress
//   session.status{idle} (ROOT session only) / permission.{asked,updated} -> blocked
//   session.created (root, no parentID)                                   -> in-progress (+ carries the id)
//
// Subagent gating: opencode runs subagents as separate CHILD sessions (each
// carries a parentID), and EACH session emits its own idle when it finishes.
// Blocking on any idle would knock the card to blocked the moment a subagent's
// turn ends, while the parent is still working. So we remember the ROOT session
// (seeded from ORDEN_OPENCODE_ROOT on resume, else the first session.created with
// no parentID) and only treat ITS status{idle} as a real turn boundary — the
// opencode analogue of Claude's gated Stop. retry (provider stall) stays
// in-progress: it is waiting on tokens, not the user.
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

  let rootId = process.env.ORDEN_OPENCODE_ROOT || ""

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
      const t = event.type
      if (t === "session.created") {
        // The root session (no parentID) drives the card and IS the conversationId.
        // Send its id so the host can persist the mapping. Child sessions are not
        // posted here — mid-turn the root is already busy (so the card is
        // in-progress), and a post-turn title/compaction child must not re-open it.
        const info = event.properties?.info
        if (info && !info.parentID) {
          rootId = info.id
          await post("session-state?state=in-progress", { session_id: info.id })
        }
        return
      }
      if (t === "session.status") {
        // opencode's authoritative work state. busy and retry both mean "working"
        // (retry = waiting to receive more tokens after a provider stall — NOT
        // waiting on the user). Only a turn-ending idle blocks, and only for the
        // ROOT session: every child/subagent (and title/compaction) session emits
        // its own idle, which must not block the card. rootId is seeded from
        // ORDEN_OPENCODE_ROOT on resume, else learned from the root's
        // session.created above; before it is known we block (degrade safely).
        const st = event.properties?.status?.type
        if (st === "busy" || st === "retry") {
          await post("session-state?state=in-progress")
        } else if (st === "idle") {
          if (!rootId || event.properties?.sessionID === rootId) {
            await post("session-state?state=blocked")
          }
        }
        return
      }
      if (t === "permission.asked" || t === "permission.updated") {
        // A real prompt is up (auto-allowed tools emit no permission event) =>
        // genuinely waiting on the user. ("asked" is current opencode; "updated"
        // is the older SDK name — handle both.) Deliberately NOT root-gated
        // (unlike session.status{idle}): a child/subagent's permission prompt
        // still needs the user, so any permission event blocks the card.
        await post("session-state?state=blocked")
        return
      }
      if (t === "permission.replied") {
        await post("session-state?state=in-progress")
        return
      }
      // session.idle is intentionally ignored: session.status{idle} is the turn
      // boundary and carries the sessionID we gate on. session.updated is ignored:
      // status{busy} already covers liveness, and a post-turn metadata update
      // (title/summary) must never un-block a blocked card.
    },
    "tool.execute.before": async (input, output) => {
      if (process.env.ORDEN_WORKTREE === "1") return
      if (input?.tool !== "bash") return
      const cmd = String(output?.args?.command ?? "")
      if (DESTRUCTIVE_GIT.some((re) => re.test(cmd))) {
        throw new Error(${JSON.stringify(DESTRUCTIVE_GIT_DENY_REASON)})
      }
    },
    // Intentionally un-gated (no root/sessionID check): any tool finishing —
    // root OR child/subagent — means the tree is actively working, so it is safe
    // to (re)assert in-progress regardless of which session ran the tool.
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

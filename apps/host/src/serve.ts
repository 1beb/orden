// Service entrypoint: one HTTP server, one NodeHost, serving everything —
//   - GET /              → the built web app (static files from apps/web/dist)
//   - WebSocket upgrades → the web UI's HostClient RPC + live change feed
//   - POST /mcp          → agents (claude/opencode) over MCP
// One process, one URL. Local: open http://localhost:<port>. Remote: same, on a
// server. Run with `npm run dev` (watch) or `npm start`.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { join, dirname, resolve, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { NodeHost } from "./nodeHost";
import { NodeTerminalChat } from "./chat/nodeTerminalChat";
import { createHostWss } from "./wsServer";
import { createTerminalWss, launchDetached } from "./terminal";
import { startIdleReconciler } from "./idleReconciler";
import { killPlaywrightMcp } from "./killPlaywrightMcp";
import { reconcileUntitledSessions } from "./sessionTitles";
import { reapCompletedCard } from "./cardReaper";
import { publishCompletedCard } from "./publishReactor";
import { journalCompletedCard } from "./cardJournal";
import { registerMergeCoordinator } from "./integrationReactor";
import { tickRunbook, handleSignal, hostRunnerDeps, WORKFLOW_SIGNAL_NS } from "./runbookRunner";
import { handleMcpRequest } from "@orden/mcp";
import { handleAgentRequest } from "./agentRoute";
import { handleHookRequest } from "./hooks";
import { handleRepoFileRequest } from "./repoFileRoute";
import { makeProjectRootResolver } from "./projectRoots";
import { DiskSnapshotStore } from "./clipper/snapshotStore";
import { applyCapture } from "./clipper/applyCapture";
import type { CaptureBundle } from "./clipper/applyCapture";
import { isClipperRequest, handleCaptureRequest, handlePingRequest } from "./clipper/captureRoute";
import { handleSnapshotRequest } from "./clipper/snapshotServe";
import { journalKey } from "@orden/outliner";

const here = dirname(fileURLToPath(import.meta.url)); // apps/host/src
const repoRoot = resolve(here, "../../..");

const port = Number(process.env.ORDEN_PORT ?? 4319);
const vaultRoot = process.env.ORDEN_VAULT ?? join(homedir(), ".orden", "vault");
const filesRoot = process.env.ORDEN_FILES_ROOT ?? repoRoot;
const webDist = process.env.ORDEN_WEB_DIST ?? resolve(repoRoot, "apps/web/dist");
const devCss = process.env.ORDEN_DEV_CSS === "1";
const devCssSrc = devCss ? resolve(repoRoot, "apps/web/src/styles.css") : null;
const host = new NodeHost({ vaultRoot, filesRoot });

// Backfill the search index from existing vault content (no-op once built).
// Non-blocking: the server starts immediately and live writes are indexed via
// the change feed regardless; this only catches up content from before boot.
void host.initSearchIndex().catch((err) => console.error("search index build failed:", err));

// Persists clipper snapshots (and per-highlight screenshots) under vaultRoot for
// the POST /capture route.
const snapshotStore = new DiskSnapshotStore(vaultRoot);

// Resolve a projectId to its files root for the /repo-file/ byte route ("repo"
// aliases filesRoot for back-compat; local projects use their source.path).
const resolveRoot = makeProjectRootResolver(host, filesRoot);

// Kill any Playwright MCP browser/service left over from a prior run: a stale
// orden tab in such a browser reconnects in a re-hydrate loop and floods this
// host's WS RPC. An agent that still needs Playwright is relaunched by the
// operator. Opt out with ORDEN_KEEP_PLAYWRIGHT=1.
killPlaywrightMcp();

// Eagerly mirror every claude session that has a transcript, so a pending
// AskUserQuestion (or any turn) shows up in the Chat tab without the user first
// opening that session. Fire-and-forget; mirror() is idempotent, so a later tab
// open just reuses the running mirror.
if (host.terminalChat instanceof NodeTerminalChat) {
  void host.terminalChat.mirrorAll();
}

// Launch-on-create reactor: the MCP session_create tool flags new sessions with
// pendingLaunch when auto-launch is on. Watch the vault, clear the flag, and
// spawn a detached agent for it. Web-created sessions never set the flag, so
// they're unaffected (they still launch when their panel opens).
async function maybeLaunch(host: NodeHost, defaultCwd: string, sessionId: string): Promise<void> {
  try {
    const rec = await host.vault.get<{
      pendingLaunch?: boolean;
      conversationId?: string;
      mode?: string;
    }>("sessions", sessionId);
    if (!rec?.pendingLaunch) return;
    // Clear the flag FIRST to avoid a re-entrant loop. The clearing write fires
    // another "sessions" change, but it has no pendingLaunch so this returns early.
    const { pendingLaunch: _drop, ...rest } = rec;
    await host.vault.set("sessions", sessionId, rest);
    // GUI sessions have no tmux — they stream via the SDK agent path, launched
    // lazily when the Chat surface mounts. A stray pendingLaunch on a GUI record
    // (e.g. MCP-flagged) must clear the flag (above) but NOT spawn a terminal.
    if (rest.mode === "gui") return;
    await launchDetached(host, defaultCwd, sessionId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`orden: maybeLaunch failed for ${sessionId}:`, err);
  }
}
host.onChange((change) => {
  if (change.ns !== "sessions") return;
  void maybeLaunch(host, filesRoot, change.key);
});

// Reap-on-complete reactor: when a card reaches Done (agent's card_complete, or
// a user drag in the web UI), exit any agent sessions still running for it.
const reapedCards = new Set<string>();
host.onChange((change) => {
  if (change.ns !== "cards") return;
  void reapCompletedCard(host, change.key, reapedCards).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`orden: reapCompletedCard failed for ${change.key}:`, err);
  });
});

// Publish-on-complete reactor: the web drag-to-Done path skips the MCP
// card_complete publish gate, so publish best-effort here (never blocks — the
// drag is the user's explicit override). The MCP path stamps publishState,
// which this reactor skips on, so the two never double-publish.
const publishedCards = new Set<string>();
host.onChange((change) => {
  if (change.ns !== "cards") return;
  void publishCompletedCard(host, change.key, publishedCards).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`orden: publishCompletedCard failed for ${change.key}:`, err);
  });
});

// Journal-on-complete reactor: log a completion to the journal + card log for
// EITHER completion path. The MCP card_complete tool logs directly too; this
// catches the web-UI drag-to-Done path, which only sets card state. Duplicate
// writes collapse in logCardCompletion, so running both is safe.
const journaledCards = new Set<string>();
host.onChange((change) => {
  if (change.ns !== "cards") return;
  void journalCompletedCard(host, change.key, journaledCards).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`orden: journalCompletedCard failed for ${change.key}:`, err);
  });
});

// Merge-coordinator reactor: on completion, enqueue the card's branch and drain
// the project's integration queue — order branches, resolve conflicts with intent
// context, gate the combined state, and (per integrationMode) merge to local main
// + rebuild, or push + open a PR. Supersedes per-session eager publish (NodeHost
// .publish is now checkOnly). Drains are single-flight per project.
registerMergeCoordinator(host);

// Runbook-engine reactors (OPT-IN): for cards under a non-default workflow, the
// engine drives the runbook — board projection from the active step's role,
// terminal primitives as executors, and gates as durable vault suspensions. A
// default-workflow card never has a run-state, so these are no-ops for it (the
// unconditional reactors above fire exactly as before = behavior-neutral).
host.onChange((change) => {
  if (change.ns !== "cards") return;
  void tickRunbook(host, change.key, hostRunnerDeps()).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`orden: runbook tick failed for ${change.key}:`, err);
  });
});
// Operator/agent signals (gate decisions, prose-step completion) land on the
// workflow-signal namespace; route them to the runner to advance the runbook.
host.onChange((change) => {
  if (change.ns !== WORKFLOW_SIGNAL_NS) return;
  void (async () => {
    const sig = await host.vault.get<{ signal?: string }>(WORKFLOW_SIGNAL_NS, change.key);
    if (sig && typeof sig.signal === "string") {
      await handleSignal(host, change.key, sig.signal as never, hostRunnerDeps()).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`orden: runbook signal failed for ${change.key}:`, err);
      });
    }
  })();
});

// Idle reconciler: the hook cycle's safety net. A periodic sweep moves any
// "in-progress" card whose agent has stopped producing output (stale transcript
// mtime / no recent hook) to "blocked" — recovering cards left stuck by a missed
// Stop edge or a host restart. Self-heals: a still-working agent's next hook
// flips it back. Runs for the process lifetime (interval is unref'd).
startIdleReconciler(host, filesRoot);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let filePath = normalize(join(webDist, urlPath));
  if (!filePath.startsWith(webDist)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    // unknown path: SPA fallback to index.html (only for extension-less routes)
    if (extname(filePath)) {
      res.writeHead(404).end("not found");
      return;
    }
    filePath = join(webDist, "index.html");
  }
  try {
    let body: string | Buffer = await readFile(filePath);
    const isIndexHtml = filePath === join(webDist, "index.html");
    if (devCss && isIndexHtml) {
      body = body
        .toString("utf-8")
        .replace("</head>", '<link rel="stylesheet" href="/dev-styles.css"></head>');
    }
    // Content-hashed assets/* are immutable — cache them hard. Everything else
    // (above all index.html, including the SPA fallback) must revalidate every
    // load, or the browser pins a stale bundle that points at old asset hashes
    // and no plain reload can dislodge it.
    const immutable = filePath.startsWith(join(webDist, "assets") + "/");
    const cacheControl = immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate";
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": cacheControl,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// The agent terminal pty (/term) and the Host RPC + change feed are both shared
// across every bound address.
const rpcWss = createHostWss(host);
const termWss = createTerminalWss(host, filesRoot);

function makeServer() {
  const server = createServer((req, res) => {
    if (req.url && req.url.startsWith("/mcp")) {
      void handleMcpRequest(host, req, res);
      return;
    }
    if (req.url && req.url.startsWith("/hooks/")) {
      void handleHookRequest(host, req, res);
      return;
    }
    // Plain-HTTP fallback for panel_open / card_* when an agent's MCP transport
    // drops mid-session (the tools vanish but the host is still up). Mirrors the
    // same @orden/mcp tool fns, keyed by ?orden_session_id=. See agentRoute.ts.
    if (req.url && req.url.startsWith("/agent/")) {
      void handleAgentRequest(host, req, res);
      return;
    }
    if (req.url && req.url.startsWith("/repo-file/")) {
      void handleRepoFileRequest(resolveRoot, req, res);
      return;
    }
    // Read-only, same-origin serving of stored capture snapshots + screenshots out
    // of the vault (the /repo-file/ route serves PROJECT roots, not the vault). The
    // handler enforces the strict traversal guard internally.
    if (req.url && req.url.startsWith("/snapshot/")) {
      void handleSnapshotRequest(snapshotStore, req, res);
      return;
    }
    // Browser clipper ingestion. The path is matched exactly (query string
    // ignored) so it can't be reached as a static-file prefix. OPTIONS is the
    // CORS preflight a cross-origin page would send before a custom-header POST —
    // answer it 403 with NO cors headers so the real request never fires. The
    // header guard (isClipperRequest) is the CSRF gate; see captureRoute.ts.
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Detection ping: the extension probes this to auto-detect a reachable orden
    // host. GET-only and gated on the clipper header (can't reuse isClipperRequest,
    // which requires POST) so arbitrary pages can't fingerprint localhost.
    if (pathname === "/orden-clipper/ping") {
      if (req.method === "GET" && req.headers["x-orden-clipper"] === "1") {
        handlePingRequest(res);
        return;
      }
      res.writeHead(403).end();
      return;
    }
    if (req.url === "/build-info") {
      readFile(join(webDist, "build-info.json"))
        .then((body) => {
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-cache, must-revalidate",
          });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(404).end("not found");
        });
      return;
    }
    if (devCss && req.url === "/dev-styles.css") {
      readFile(devCssSrc!)
        .then((body) => {
          res.writeHead(200, {
            "content-type": "text/css",
            "cache-control": "no-cache, must-revalidate",
          });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(404).end("not found");
        });
      return;
    }
    if (pathname === "/capture") {
      if (req.method === "OPTIONS") {
        res.writeHead(403).end();
        return;
      }
      if (isClipperRequest(req)) {
        const apply = (bundle: CaptureBundle) =>
          applyCapture(
            {
              vault: host.vault,
              store: snapshotStore,
              mintId: () => randomUUID(),
              now: () => new Date().toISOString(),
              journalKeyFor: () => journalKey(new Date()),
              // createSession intentionally omitted for now — session-from-capture
              // routing lands with the extension submit flow (plan Tasks 12/16).
              // applyCapture treats it as optional.
            },
            bundle,
          );
        void handleCaptureRequest(req, res, apply);
        return;
      }
      res.writeHead(403).end();
      return;
    }
    void serveStatic(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const wss = (req.url ?? "").startsWith("/term") ? termWss : rpcWss;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return server;
}

// The tailnet IP (Tailscale hands out 100.64.0.0/10, the CGNAT range). Binding
// it — instead of 0.0.0.0 — keeps the host OFF any LAN/public NIC: reachable
// only from other tailnet devices.
function tailscaleIp(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return undefined;
}

// Bind loopback (so the local MCP agent bus on 127.0.0.1 keeps working) plus the
// tailnet IP (so other tailnet devices can reach it). ORDEN_BIND overrides with a
// comma-separated address list. We never default to 0.0.0.0 — no LAN/public
// exposure unless you ask for it explicitly.
function resolveBinds(): string[] {
  const override = process.env.ORDEN_BIND?.trim();
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  const ts = tailscaleIp();
  if (!ts) {
    // eslint-disable-next-line no-console
    console.warn("orden: no tailnet IP found — binding loopback only (set ORDEN_BIND to override)");
    return ["127.0.0.1"];
  }
  return ["127.0.0.1", ts];
}

const binds = resolveBinds();
for (const addr of binds) {
  makeServer().listen(port, addr, () => {
    // eslint-disable-next-line no-console
    console.log(
      `orden on http://${addr}:${port}  (app + ws + /mcp, one process)\n  vault: ${vaultRoot}\n  files: ${filesRoot}\n  webDist: ${webDist}`,
    );
  });
}

// Service entrypoint: one HTTP server, one NodeHost, serving everything —
//   - GET /              → the built web app (static files from apps/web/dist)
//   - WebSocket upgrades → the web UI's HostClient RPC + live change feed
//   - POST /mcp          → agents (claude/opencode) over MCP
// One process, one URL. Local: open http://localhost:<port>. Remote: same, on a
// server. Run with `npm run dev` (watch) or `npm start`.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, dirname, resolve, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { NodeHost } from "./nodeHost";
import { createHostWss } from "./wsServer";
import { createTerminalWss } from "./terminal";
import { handleMcpRequest } from "./mcpHttp";

const here = dirname(fileURLToPath(import.meta.url)); // apps/host/src
const repoRoot = resolve(here, "../../..");

const port = Number(process.env.ORDEN_PORT ?? 4319);
const vaultRoot = process.env.ORDEN_VAULT ?? join(homedir(), ".orden", "vault");
const filesRoot = process.env.ORDEN_FILES_ROOT ?? repoRoot;
const webDist = process.env.ORDEN_WEB_DIST ?? resolve(repoRoot, "apps/web/dist");
const host = new NodeHost({ vaultRoot, filesRoot });

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
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const httpServer = createServer((req, res) => {
  if (req.url && req.url.startsWith("/mcp")) {
    void handleMcpRequest(host, req, res);
    return;
  }
  void serveStatic(req, res);
});

// Route WebSocket upgrades: /term → the agent terminal pty, everything else →
// the Host RPC + change feed.
const rpcWss = createHostWss(host);
const termWss = createTerminalWss(host, filesRoot);
httpServer.on("upgrade", (req, socket, head) => {
  const wss = (req.url ?? "").startsWith("/term") ? termWss : rpcWss;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

httpServer.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `orden on http://127.0.0.1:${port}  (app + ws + /mcp, one process)\n  vault: ${vaultRoot}\n  files: ${filesRoot}\n  webDist: ${webDist}`,
  );
});

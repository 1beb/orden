// Service entrypoint: one HTTP server, one NodeHost, two buses —
//   - WebSocket upgrades  → the web UI (HostClient RPC)
//   - POST /mcp           → agents (claude/opencode) over MCP
// Both share the same vault. Run with `npm run dev` (watch) or `npm start`.
// The web app connects with VITE_ORDEN_HOST=ws://127.0.0.1:<port>; agents point
// their MCP config at http://127.0.0.1:<port>/mcp.

import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeHost } from "./nodeHost";
import { attachWs } from "./wsServer";
import { handleMcpRequest } from "./mcpHttp";

const port = Number(process.env.ORDEN_PORT ?? 4319);
const vaultRoot = process.env.ORDEN_VAULT ?? join(homedir(), ".orden", "vault");
const host = new NodeHost({ vaultRoot });

const httpServer = createServer((req, res) => {
  if (req.url && req.url.startsWith("/mcp")) {
    void handleMcpRequest(host, req, res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("orden host: WebSocket = web UI, POST /mcp = agents");
});

attachWs(host, httpServer);

httpServer.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `orden host on http://127.0.0.1:${port}  (ws: web UI · /mcp: agents)  vault: ${vaultRoot}`,
  );
});

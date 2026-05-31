// HTTP mount for the MCP bus, using the standard session-managed Streamable
// HTTP transport (what claude/opencode's MCP clients expect): an `initialize`
// POST with no session id spins up a transport keyed by a generated session id;
// later POST/GET/DELETE carry that id (Mcp-Session-Id). All sessions share the
// one Host, so the agent bus and the ws (web) bus hit the same vault.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Host } from "@orden/host-api";
import { createMcpServer } from "./server";

const transports: Record<string, StreamableHTTPServerTransport> = {};

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function handleMcpRequest(
  host: Host,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    const body = await readJsonBody(req).catch(() => undefined);
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      await createMcpServer(host).connect(transport);
    }

    if (!transport) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session; send an initialize request first." },
          id: null,
        }),
      );
      return;
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  // GET (SSE stream) / DELETE (teardown) require an existing session.
  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.writeHead(400).end("missing or unknown Mcp-Session-Id");
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405).end();
}

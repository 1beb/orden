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

/**
 * Pull the orden session uuid that binds this MCP connection to a card. An
 * `x-orden-session` header wins; otherwise the first path segment after /mcp
 * (e.g. `/mcp/<uuid>`) is used. Pure for testability.
 */
export function parseSessionBinding(req: {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const header = req.headers["x-orden-session"];
  if (typeof header === "string" && header) return header;
  const m = (req.url ?? "").match(/^\/mcp\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

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
      await createMcpServer(host, { conversationId: parseSessionBinding(req) }).connect(transport);
    }

    if (!transport) {
      // A session id we don't know about means the session was terminated —
      // typically because the host restarted and lost the in-memory transports
      // map while a long-lived agent kept its cached Mcp-Session-Id. The MCP
      // Streamable HTTP spec says answer 404 here; that is the client's signal
      // to transparently re-initialize (a fresh POST with no session id). A 400
      // instead leaves the agent stuck repeating the same failed call — the
      // recurrent "No valid session" errors after restart. The /mcp/<convId>
      // card binding lives in the URL, so it survives the re-initialize.
      const status = sessionId ? 404 : 400;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session; send an initialize request first." },
          id: null,
        }),
      );
      return;
    }

    // The Streamable HTTP transport (via @hono/node-server) reads from
    // req.rawHeaders, not req.headers. Some MCP clients send Accept headers
    // that don't include both required media types (application/json and
    // text/event-stream). Replace with the exact required value so the MCP
    // SDK's handshake succeeds.
    const acceptIdx = req.rawHeaders.findIndex(
      (h, i) => i % 2 === 0 && h.toLowerCase() === "accept",
    );
    if (acceptIdx === -1) {
      req.rawHeaders.push("Accept", "application/json, text/event-stream");
    } else {
      req.rawHeaders[acceptIdx + 1] = "application/json, text/event-stream";
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

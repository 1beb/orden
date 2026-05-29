// WebSocket server: puts a NodeHost behind a socket. Each text frame is one
// RpcRequest; the reply is the matching RpcResponse. Server-only (imports the
// `ws` package) — never import this from the browser app.

import { WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";
import type { Host } from "@orden/host-api";
import { dispatch, type RpcRequest } from "./rpc";

export interface HostServer {
  /** The actual port (resolved when port 0 was requested). */
  port: number;
  close(): Promise<void>;
}

function wireConnections(wss: WebSocketServer, host: Host): void {
  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frames
      }
      const res = await dispatch(host, req);
      socket.send(JSON.stringify(res));
    });
  });
}

/** Attach the ws Host bus to an existing HTTP server (shares the port with MCP). */
export function attachWs(host: Host, server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server });
  wireConnections(wss, host);
  return wss;
}

/** Standalone ws server on its own port (used by tests). */
export function startHostServer(host: Host, opts: { port: number }): Promise<HostServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: opts.port, host: "127.0.0.1" });
    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () => new Promise<void>((res) => wss.close(() => res())),
      });
    });
    wireConnections(wss, host);
  });
}

// WebSocket server: puts a NodeHost behind a socket. Each text frame is one
// RpcRequest; the reply is the matching RpcResponse. Server-only (imports the
// `ws` package) — never import this from the browser app.

import { WebSocketServer } from "ws";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server as HttpServer } from "node:http";
import type { Host } from "@orden/host-api";
import { dispatch, type RpcRequest } from "./rpc";

// A connection is its own change subscription: the server must not echo a
// client's own write back to it (the client already updated its synchronous
// cache, and a self-echo is indistinguishable from a genuine host write to the
// same key — the bug that left freshly-created cards stuck in "planning"). We
// attribute each vault change to the connection whose RPC caused it by running
// dispatch inside an AsyncLocalStorage scope: the change is emitted (after an
// await) inside EmittingVault.set, still within that scope, so every socket's
// change listener can read the origin id and skip its own. Writes with no
// origin (hooks, reactors, MCP agents, the idle reconciler) fall through and
// broadcast to all clients, which is how an agent's card_move reaches the board.
const originStore = new AsyncLocalStorage<number>();
let connSeq = 0;

export interface HostServer {
  /** The actual port (resolved when port 0 was requested). */
  port: number;
  close(): Promise<void>;
}

// A Host that can notify of vault writes (NodeHost). Optional — the change feed
// is only pushed when the host supports it.
interface ChangeSource {
  onChange(listener: (change: { ns: string; key: string; projectId?: string }) => void): () => void;
}
function isChangeSource(host: Host): host is Host & ChangeSource {
  return typeof (host as Partial<ChangeSource>).onChange === "function";
}

function wireConnections(wss: WebSocketServer, host: Host): void {
  wss.on("connection", (socket) => {
    const connId = ++connSeq; // stable id for this connection, used to skip self-echoes
    // Open-doc watches (files.watch) create host-side fs.watch handles keyed by
    // path, with no per-connection owner. Track what THIS connection opened so a
    // closed/reloaded tab releases them — otherwise every reload would leak a
    // watch, which is exactly the fs.watch accumulation this design avoids.
    const watched = new Set<string>(); // `${projectId}\0${path}`
    socket.on("message", async (data) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frames
      }
      // Mirror files.watch/unwatch into the per-connection set up front, so a
      // close mid-flight still releases the watch.
      if (req.path?.[0] === "files" && (req.path[1] === "watch" || req.path[1] === "unwatch")) {
        const [pid, p] = req.args as unknown[];
        if (typeof pid === "string" && typeof p === "string") {
          if (req.path[1] === "watch") watched.add(`${pid}\0${p}`);
          else watched.delete(`${pid}\0${p}`);
        }
      }
      // Run the dispatch inside this connection's origin scope so any vault
      // change it emits is attributed back here and not echoed to this socket.
      const res = await originStore.run(connId, () => dispatch(host, req));
      socket.send(JSON.stringify(res));
    });

    // Release any open-doc watches this connection still held when it drops.
    socket.on("close", () => {
      for (const key of watched) {
        const sep = key.indexOf("\0");
        void host.files.unwatch(key.slice(0, sep), key.slice(sep + 1));
      }
      watched.clear();
    });

    // Push vault-change frames so clients can live-update without polling.
    if (isChangeSource(host)) {
      const unsubscribe = host.onChange((change) => {
        // Skip changes THIS connection's own RPC caused (origin == connId).
        // Foreign client writes and origin-less host writes both fall through.
        if (originStore.getStore() === connId) return;
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({ type: "change", ns: change.ns, key: change.key, projectId: change.projectId }),
          );
        }
      });
      socket.on("close", unsubscribe);
    }
  });
}

/** The ws Host bus as a noServer WebSocketServer; serve.ts routes upgrades to it. */
export function createHostWss(host: Host): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
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

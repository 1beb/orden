// Browser-clean WebSocket transport for the Host RPC. Multiplexes many
// request/response pairs over one socket, surfaces server-pushed frames (the
// change feed) via onEvent, and AUTO-RECONNECTS: if the socket drops (e.g. the
// host restarts), in-flight requests reject (so callers fail fast instead of
// hanging) and a fresh socket is opened; onReconnect fires so the app can
// re-hydrate. Typed structurally so it needs no DOM lib.

import type { Transport, RpcRequest, RpcResponse } from "./rpc";

interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
interface SocketCtor {
  new (url: string): SocketLike;
}

export interface ServerEvent {
  type: "change";
  ns: string;
  key: string;
  /** For `files` changes: which project's file changed. */
  projectId?: string;
}

export interface WsConnection {
  transport: Transport;
  onEvent(handler: (event: ServerEvent) => void): () => void;
  /** Fires after the socket drops and successfully reconnects. */
  onReconnect(handler: () => void): () => void;
  close(): Promise<void>;
}

export function createWsTransport(
  url: string,
  WebSocketImpl: SocketCtor = (globalThis as { WebSocket: SocketCtor }).WebSocket,
): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const pending = new Map<number, (res: RpcResponse) => void>();
    const eventHandlers = new Set<(event: ServerEvent) => void>();
    const reconnectHandlers = new Set<() => void>();
    let ws: SocketLike;
    let firstOpen = true;
    let closedByUser = false;
    let attempts = 0;

    const failPending = (): void => {
      for (const [id, settle] of pending) settle({ id, ok: false, error: "connection lost" });
      pending.clear();
    };

    const wire = (): void => {
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        if (!raw) return;
        let msg: RpcResponse | ServerEvent;
        try {
          msg = JSON.parse(raw) as RpcResponse | ServerEvent;
        } catch {
          return;
        }
        if ((msg as ServerEvent).type === "change") {
          for (const h of eventHandlers) h(msg as ServerEvent);
          return;
        }
        const res = msg as RpcResponse;
        const settle = pending.get(res.id);
        if (settle) {
          pending.delete(res.id);
          settle(res);
        }
      };
      ws.onerror = () => {
        if (firstOpen) reject(new Error(`ws transport: connection to ${url} failed`));
      };
      ws.onopen = () => {
        attempts = 0;
        if (firstOpen) {
          firstOpen = false;
          resolve(connection);
        } else {
          for (const h of reconnectHandlers) h();
        }
      };
      ws.onclose = () => {
        failPending(); // don't leave callers hanging on a dead socket
        if (!closedByUser) {
          attempts += 1;
          const delay = Math.min(5000, 500 * 2 ** Math.min(attempts, 4));
          setTimeout(connect, delay);
        }
      };
    };

    const connect = (): void => {
      ws = new WebSocketImpl(url);
      wire();
    };

    const transport: Transport = (req: RpcRequest) =>
      new Promise<RpcResponse>((res) => {
        try {
          ws.send(JSON.stringify(req));
          pending.set(req.id, res); // only track requests actually on the wire
        } catch {
          // Socket isn't OPEN (dropped, mid-reconnect). Settle now so the caller
          // fails fast instead of hanging: a reconnected socket never re-sends a
          // request queued before it opened, so leaving it in `pending` would
          // never resolve. Without this, a request fired during the reconnect
          // window (e.g. over a flaky link, or right after a host restart) hangs
          // forever — which is why clicking a doc sometimes does nothing.
          res({ id: req.id, ok: false, error: "connection lost" });
        }
      });

    const connection: WsConnection = {
      transport,
      onEvent: (handler) => {
        eventHandlers.add(handler);
        return () => eventHandlers.delete(handler);
      },
      onReconnect: (handler) => {
        reconnectHandlers.add(handler);
        return () => reconnectHandlers.delete(handler);
      },
      close: () =>
        new Promise<void>((res) => {
          closedByUser = true;
          ws.onclose = () => res();
          ws.close();
        }),
    };

    connect();
  });
}

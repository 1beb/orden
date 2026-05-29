// Browser-clean WebSocket transport for the Host RPC. Multiplexes many
// request/response pairs over one socket, matching replies to requests by id.
// Also surfaces server-pushed frames (the vault change feed) via onEvent.
// Typed structurally against the standard WebSocket API so it needs no DOM lib
// and runs unchanged in the browser and under Node's global WebSocket.

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

/** A server-pushed frame (not a response to a request) — e.g. a vault change. */
export interface ServerEvent {
  type: "change";
  ns: string;
  key: string;
}

export interface WsConnection {
  transport: Transport;
  onEvent(handler: (event: ServerEvent) => void): () => void;
  close(): Promise<void>;
}

export function createWsTransport(
  url: string,
  WebSocketImpl: SocketCtor = (globalThis as { WebSocket: SocketCtor }).WebSocket,
): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const pending = new Map<number, (res: RpcResponse) => void>();
    const eventHandlers = new Set<(event: ServerEvent) => void>();

    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const msg = JSON.parse(raw) as RpcResponse | ServerEvent;
      if ((msg as ServerEvent).type === "change") {
        for (const handler of eventHandlers) handler(msg as ServerEvent);
        return;
      }
      const res = msg as RpcResponse;
      const settle = pending.get(res.id);
      if (settle) {
        pending.delete(res.id);
        settle(res);
      }
    };
    ws.onerror = () => reject(new Error(`ws transport: connection to ${url} failed`));
    ws.onopen = () => {
      const transport: Transport = (req: RpcRequest) =>
        new Promise<RpcResponse>((res) => {
          pending.set(req.id, res);
          ws.send(JSON.stringify(req));
        });
      resolve({
        transport,
        onEvent: (handler) => {
          eventHandlers.add(handler);
          return () => eventHandlers.delete(handler);
        },
        close: () =>
          new Promise<void>((res) => {
            ws.onclose = () => res();
            ws.close();
          }),
      });
    };
  });
}

// Transport-agnostic RPC for the Host interface.
//
// A request names a method by path — ["vault","get"] for a capability method,
// or ["capabilities"] for a top-level one — plus its args. `dispatch` resolves
// the path against a real Host and runs it. `connectHostClient` returns a Host
// whose every method forwards over a Transport, so the web app can talk to a
// remote NodeHost through the exact same interface as a local one. The WS
// transport is just one Transport function; the tests use an in-process one.

import type { Host, HostCapabilities } from "@orden/host-api";

export interface RpcRequest {
  id: number;
  path: string[];
  args: unknown[];
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type Transport = (req: RpcRequest) => Promise<RpcResponse>;

// The capability objects on Host that expose async methods. capabilities() is
// handled separately (it is synchronous and cached on the client).
const CAPABILITIES = [
  "identity",
  "vault",
  "projects",
  "files",
  "sessions",
  "locks",
  "chat",
  "terminalChat",
] as const;

export async function dispatch(host: Host, req: RpcRequest): Promise<RpcResponse> {
  try {
    const [head, method] = req.path;
    let fn: (...a: unknown[]) => unknown;
    let thisArg: unknown;

    if (req.path.length === 1) {
      thisArg = host;
      fn = (host as unknown as Record<string, unknown>)[head] as typeof fn;
    } else {
      thisArg = (host as unknown as Record<string, unknown>)[head];
      if (thisArg == null) throw new Error(`unknown capability: ${head}`);
      fn = (thisArg as Record<string, unknown>)[method] as typeof fn;
    }

    if (typeof fn !== "function") {
      throw new Error(`unknown method: ${req.path.join(".")}`);
    }

    const result = await fn.apply(thisArg, req.args);
    return { id: req.id, ok: true, result };
  } catch (err: unknown) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function capProxy(capName: string, transport: Transport, nextId: () => number) {
  return new Proxy(
    {},
    {
      get(_target, method: string) {
        return async (...args: unknown[]) => {
          const res = await transport({ id: nextId(), path: [capName, method], args });
          if (!res.ok) throw new Error(res.error);
          return res.result;
        };
      },
    },
  );
}

export async function connectHostClient(transport: Transport): Promise<Host> {
  let counter = 0;
  const nextId = () => ++counter;

  // capabilities() is synchronous in the Host interface, so fetch it once now
  // and serve it from cache. Capabilities are static for a given host.
  const capsRes = await transport({ id: nextId(), path: ["capabilities"], args: [] });
  if (!capsRes.ok) throw new Error(capsRes.error);
  const caps = capsRes.result as HostCapabilities;

  const client = { capabilities: () => caps } as Record<string, unknown>;
  for (const cap of CAPABILITIES) {
    client[cap] = capProxy(cap, transport, nextId);
  }

  // Top-level Host methods (path length 1) aren't covered by the capability
  // proxies, so each needs an explicit forwarder. `dispatch` already resolves
  // ["applyLearning"] against host.applyLearning server-side.
  client.applyLearning = async (learningId: string) => {
    const res = await transport({ id: nextId(), path: ["applyLearning"], args: [learningId] });
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };
  client.deliverLearningComment = async (learningId: string, text: string) => {
    const res = await transport({
      id: nextId(),
      path: ["deliverLearningComment"],
      args: [learningId, text],
    });
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };

  return client as unknown as Host;
}

// Browser-safe entrypoint: the bits the web app needs to talk to a NodeHost.
// Deliberately excludes wsServer/nodeHost/diskVault (Node-only) so importing
// this never pulls `ws` or `node:fs` into the browser bundle.

export { connectHostClient } from "./rpc";
export type { Transport, RpcRequest, RpcResponse } from "./rpc";
export { createWsTransport } from "./wsTransport";
export type { WsConnection, ServerEvent } from "./wsTransport";

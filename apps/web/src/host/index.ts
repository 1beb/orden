// The app's single source for "which Host am I talking to?". Defaults to the
// in-browser host; set VITE_ORDEN_HOST=ws://127.0.0.1:4319 to run against a
// NodeHost instead, with no other code change.
//
// onVaultChange lets the app live-update when the vault changes (e.g. an agent
// writes over the MCP bus). It's a no-op on BrowserHost (single writer) and
// driven by the ws change feed on NodeHost.

import type { Host } from "@orden/host-api";
import { connectHostClient, createWsTransport } from "@orden/host-client";
import { browserHost } from "./browserHost";
import { selectHost } from "./selectHost";

let subscribe: (cb: (ns: string, key: string) => void) => void = () => {};

/** Register a listener for vault changes pushed by the host (NodeHost only). */
export function onVaultChange(cb: (ns: string, key: string) => void): void {
  subscribe(cb);
}

export function getHost(): Promise<Host> {
  return selectHost(import.meta.env.VITE_ORDEN_HOST, {
    makeBrowser: () => browserHost,
    connectNode: async (url) => {
      const conn = await createWsTransport(url);
      subscribe = (cb) => conn.onEvent((e) => cb(e.ns, e.key));
      return connectHostClient(conn.transport);
    },
  });
}

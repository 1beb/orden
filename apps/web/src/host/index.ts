// The app's single source for "which Host am I talking to?". Defaults to the
// in-browser host; set VITE_ORDEN_HOST=ws://127.0.0.1:4319 to run against a
// NodeHost instead, with no other code change. This is the swap point H0.3
// routing will funnel the app's stores through.

import type { Host } from "@orden/host-api";
import { connectHostClient, createWsTransport } from "@orden/host-client";
import { browserHost } from "./browserHost";
import { selectHost } from "./selectHost";

export function getHost(): Promise<Host> {
  return selectHost(import.meta.env.VITE_ORDEN_HOST, {
    makeBrowser: () => browserHost,
    connectNode: async (url) => {
      const conn = await createWsTransport(url);
      return connectHostClient(conn.transport);
    },
  });
}

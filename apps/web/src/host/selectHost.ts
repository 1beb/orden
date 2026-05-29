// Host selection: one flag decides whether the app runs on the in-browser
// host or connects to a NodeHost over WebSocket. The factories are injected so
// the decision is testable without a real socket. See getHost() in ./index.ts
// for the wired version.

import type { Host } from "@orden/host-api";

export interface HostFactories {
  makeBrowser: () => Host;
  connectNode: (url: string) => Promise<Host>;
}

export async function selectHost(
  hostUrl: string | undefined,
  factories: HostFactories,
): Promise<Host> {
  if (hostUrl && hostUrl.trim() !== "") {
    return factories.connectNode(hostUrl);
  }
  return factories.makeBrowser();
}

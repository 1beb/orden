// Service entrypoint: boots a NodeHost behind a WebSocket. Run with `npm run
// dev` (watch) or `npm start`. The web app connects by setting
// VITE_ORDEN_HOST=ws://127.0.0.1:<port>.

import { homedir } from "node:os";
import { join } from "node:path";
import { NodeHost } from "./nodeHost";
import { startHostServer } from "./wsServer";

const port = Number(process.env.ORDEN_PORT ?? 4319);
const vaultRoot = process.env.ORDEN_VAULT ?? join(homedir(), ".orden", "vault");

const host = new NodeHost({ vaultRoot });

startHostServer(host, { port }).then((server) => {
  // eslint-disable-next-line no-console
  console.log(`orden host listening on ws://127.0.0.1:${server.port} (vault: ${vaultRoot})`);
});

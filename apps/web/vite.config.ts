import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // main.ts boots with top-level await (await getHost()); esnext keeps it in the
  // production bundle. All current browsers support top-level await.
  build: { target: "esnext" },
  // Allow serving/reading the repo's docs (two levels up) so we can open the
  // project's own files in the app (dogfooding).
  server: {
    fs: { allow: [resolve(__dirname, "../..")] },
  },
  resolve: {
    alias: {
      "@orden/annotation-core": resolve(
        __dirname,
        "../../packages/annotation-core/src/index.ts",
      ),
      "@orden/outliner": resolve(__dirname, "../../packages/outliner/src/index.ts"),
      "@orden/host-api": resolve(__dirname, "../../packages/host-api/src/index.ts"),
      "@orden/host-client": resolve(__dirname, "../host/src/client.ts"),
    },
  },
});

import { defineConfig } from "vite";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const BUILD_TIME = Date.now();

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
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
      // Subpath aliases must precede the bare-package alias: vite matches the
      // first prefix, and "@orden/outliner" would otherwise swallow these into
      // src/index.ts/page. host-api re-exports via these DOM-free subpaths.
      "@orden/outliner/page": resolve(__dirname, "../../packages/outliner/src/page.ts"),
      "@orden/outliner/markdown": resolve(
        __dirname,
        "../../packages/outliner/src/markdown.ts",
      ),
      "@orden/outliner": resolve(__dirname, "../../packages/outliner/src/index.ts"),
      "@orden/chat-core": resolve(__dirname, "../../packages/chat-core/src/index.ts"),
      "@orden/chat-ui": resolve(__dirname, "../../packages/chat-ui/src/index.ts"),
      "@orden/host-api": resolve(__dirname, "../../packages/host-api/src/index.ts"),
      "@orden/host-client": resolve(__dirname, "../host/src/client.ts"),
    },
  },
  plugins: [
    {
      name: "write-build-info",
      writeBundle() {
        const distDir = resolve(__dirname, "dist");
        mkdirSync(distDir, { recursive: true });
        writeFileSync(
          resolve(distDir, "build-info.json"),
          JSON.stringify({ buildTime: BUILD_TIME }),
        );
      },
    },
  ],
});

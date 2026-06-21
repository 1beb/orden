import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "happy-dom",
  },
  resolve: {
    alias: {
      "@orden/annotation-core": resolve(
        __dirname,
        "../../packages/annotation-core/src/index.ts",
      ),
      // Subpath aliases must precede the bare-package alias: vitest matches the
      // first prefix, and "@orden/outliner" would otherwise swallow these into
      // ".../src/index.ts/page" (mirrors vite.config.ts; host-api imports them).
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
});

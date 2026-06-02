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
      "@orden/outliner": resolve(__dirname, "../../packages/outliner/src/index.ts"),
      "@orden/chat-core": resolve(__dirname, "../../packages/chat-core/src/index.ts"),
      "@orden/chat-ui": resolve(__dirname, "../../packages/chat-ui/src/index.ts"),
      "@orden/host-api": resolve(__dirname, "../../packages/host-api/src/index.ts"),
      "@orden/host-client": resolve(__dirname, "../host/src/client.ts"),
    },
  },
});

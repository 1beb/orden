import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@orden/host-api": resolve(__dirname, "../../packages/host-api/src/index.ts"),
      "@orden/mcp": resolve(__dirname, "../../packages/mcp/src/index.ts"),
      "@orden/chat-core/testing": resolve(
        __dirname,
        "../../packages/chat-core/src/testing/adapterContract.ts",
      ),
      "@orden/chat-core": resolve(__dirname, "../../packages/chat-core/src/index.ts"),
    },
  },
});

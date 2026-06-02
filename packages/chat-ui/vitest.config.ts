import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "happy-dom",
  },
  resolve: {
    alias: {
      "@orden/chat-core": resolve(__dirname, "../chat-core/src/index.ts"),
    },
  },
});

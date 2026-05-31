import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@orden/host-api": resolve(__dirname, "../host-api/src/index.ts"),
    },
  },
});

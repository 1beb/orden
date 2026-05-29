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
      "@orden/host-api": resolve(__dirname, "../../packages/host-api/src/index.ts"),
    },
  },
});

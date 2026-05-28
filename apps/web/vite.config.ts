import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@orden/annotation-core": resolve(
        __dirname,
        "../../packages/annotation-core/src/index.ts",
      ),
    },
  },
});

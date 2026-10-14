import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@your-scope/scene-editor": fileURLToPath(
        new URL("../../packages/scene-editor/src/index.ts", import.meta.url),
      ),
      "@your-scope/scene-editor/element": fileURLToPath(
        new URL("../../packages/scene-editor/src/element-entry.ts", import.meta.url),
      ),
    },
  },
  server: { fs: { allow: ["../.."] } },
});

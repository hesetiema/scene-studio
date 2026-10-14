import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pkg = (path: string) =>
  fileURLToPath(new URL(`../../packages/scene-editor/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@your-scope/scene-editor/element", replacement: pkg("element-entry.ts") },
      { find: "@your-scope/scene-editor/three", replacement: pkg("three-entry.ts") },
      { find: "@your-scope/scene-editor", replacement: pkg("index.ts") },
    ],
  },
  server: { fs: { allow: ["../.."] } },
});

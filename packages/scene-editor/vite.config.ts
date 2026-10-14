import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        "three-entry": "src/three-entry.ts",
        "element-entry": "src/element-entry.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["three", /^three\//, "zod"],
    },
    cssCodeSplit: false,
    cssFileName: "scene-editor",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

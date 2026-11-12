import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        "three-entry": "src/three-entry.ts",
        "element-entry": "src/element-entry.ts",
        "bim-entry": "src/bim/bim-entry.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["three", /^three\//, "zod"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

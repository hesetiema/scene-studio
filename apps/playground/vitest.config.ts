import { defineConfig } from "vitest/config";

/**
 * The icon layer under `src/vent/graph/` is framework-free by construction: it
 * knows rectangles, weights and a projection callback, and nothing about three
 * or the DOM. Only the DOM media needs a document, so the rest is tested here in
 * plain node — no browser, no SwiftShader, no flake.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

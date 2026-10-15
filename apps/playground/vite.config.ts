import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pkg = (path: string) =>
  fileURLToPath(new URL(`../../packages/scene-editor/src/${path}`, import.meta.url));

const html = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    // order matters: longer subpaths first (D4 entry map)
    alias: [
      { find: "@your-scope/scene-editor/element", replacement: pkg("element-entry.ts") },
      { find: "@your-scope/scene-editor/three", replacement: pkg("three-entry.ts") },
      { find: "@your-scope/scene-editor", replacement: pkg("index.ts") },
    ],
  },
  // one optimizer run for all three.js subpaths keeps three.core shared
  // (class identity between `three` and `three/webgpu` — D1 probe verifies)
  optimizeDeps: {
    include: [
      "three",
      "three/webgpu",
      "three/examples/jsm/loaders/GLTFLoader.js",
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/controls/TransformControls.js",
    ],
  },
  build: {
    rollupOptions: {
      input: {
        main: html("index.html"),
        webgpu: html("webgpu.html"),
      },
    },
  },
  server: {
    fs: { allow: ["../.."] },
  },
});

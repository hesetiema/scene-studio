import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pkg = (path: string) =>
  fileURLToPath(new URL(`../../packages/scene-editor/src/${path}`, import.meta.url));

const html = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/** Focused SDK demos (`/demos/*.html`) — one page per API surface. */
const demoPages = ["index", "host-api", "document", "headless", "assets"];

export default defineConfig({
  resolve: {
    // order matters: longer subpaths first (D4 entry map)
    alias: [
      { find: "@scenio/scene-editor/element", replacement: pkg("element-entry.ts") },
      { find: "@scenio/scene-editor/three", replacement: pkg("three-entry.ts") },
      { find: "@scenio/scene-editor", replacement: pkg("index.ts") },
    ],
  },
  // one optimizer run for all three.js subpaths keeps three.core shared
  optimizeDeps: {
    include: [
      "three",
      "three/examples/jsm/loaders/GLTFLoader.js",
      "three/examples/jsm/loaders/DRACOLoader.js",
      "three/examples/jsm/loaders/OBJLoader.js",
      "three/examples/jsm/loaders/STLLoader.js",
      "three/examples/jsm/libs/meshopt_decoder.module.js",
      "three/examples/jsm/controls/OrbitControls.js",
      "three/examples/jsm/controls/TransformControls.js",
      "three/examples/jsm/exporters/GLTFExporter.js",
      "three/examples/jsm/exporters/OBJExporter.js",
    ],
  },
  build: {
    rollupOptions: {
      input: {
        main: html("index.html"),
        perf: html("perf.html"),
        minimal: html("minimal.html"),
        ...Object.fromEntries(
          demoPages.map((page) => [`demo-${page}`, html(`demos/${page}.html`)]),
        ),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    fs: { allow: ["../.."] },
  },
});

import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const pkg = (path: string) =>
  fileURLToPath(new URL(`../../packages/scene-editor/src/${path}`, import.meta.url));

const html = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/**
 * `public/` is shared by both surfaces, so it also holds things the public site
 * must not carry: the live snapshot (`data/`, `bim/`), the demo thumbnails
 * (`demos/`) for a page that is not published, and nothing else. Vite copies
 * `public/` wholesale, so the pages build swaps that content out after the
 * bundle is written: `demos/` disappears, and `data/` + `bim/` are replaced by
 * `demo-data/` — the sanitized snapshot produced by `scripts/make-demo-data.mjs`
 * and committed to the repo. Same URLs, so the vent page loads it without a
 * single line of runtime branching; a local pages build then produces the same
 * artifact as CI instead of shipping whatever happens to be on disk.
 */
function pagesDataSurface(): Plugin {
  let outDir = "";
  let root = process.cwd();

  return {
    name: "pages-data-surface",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    async closeBundle() {
      for (const dir of ["data", "bim", "demos"]) {
        await rm(join(outDir, dir), { recursive: true, force: true });
      }
      for (const dir of ["data", "bim"]) {
        const from = join(root, "demo-data", dir);
        if (!existsSync(from)) {
          throw new Error(
            `pages build needs ${from} — run \`node scripts/make-demo-data.mjs\` where the live snapshot exists`,
          );
        }
        await cp(from, join(outDir, dir), { recursive: true });
      }
    },
  };
}

/**
 * Two build surfaces share this config.
 *
 * The default (`vite dev` / `vite build`) is the full six-entry surface — the one
 * CI and the e2e/perf suites drive, so every page must stay buildable.
 *
 * `--mode pages` is the public GitHub Pages site: the studio (`index.html`) and
 * the vent demo (`vent-demo.html`, served from the sanitized snapshot). The rest
 * do not answer a stranger's first question — `perf` is an instrument, `minimal`
 * and `embed` are integration references whose value is their source file, and
 * `demos` is a local index. Removing them from the repo would remove test hosts;
 * removing them from this surface only removes noise.
 *
 * Project pages are served from `/<repo>/`, so the pages build carries a base
 * prefix. Anything resolved at runtime (asset URLs in TS) must go through
 * `import.meta.env.BASE_URL` — vite only rewrites build-time references, and it
 * does not touch custom-element attributes such as `<scene-editor src>`.
 */
export default defineConfig(({ mode }) => {
  const pages = mode === "pages";

  return {
    base: pages ? "/scene-studio/" : "/",
    plugins: pages ? [pagesDataSurface()] : [],

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
        // `decoder-path` imports these on demand; pre-bundling them keeps the dev
        // server from re-optimizing (and reloading the page) mid-load.
        "three/examples/jsm/loaders/KTX2Loader.js",
        "three/examples/jsm/loaders/OBJLoader.js",
        "three/examples/jsm/loaders/STLLoader.js",
        "three/examples/jsm/libs/meshopt_decoder.module.js",
        "three/examples/jsm/controls/OrbitControls.js",
        "three/examples/jsm/controls/TransformControls.js",
        "three/examples/jsm/exporters/GLTFExporter.js",
        "three/examples/jsm/exporters/OBJExporter.js",
        // The picker imports this lazily (heavy meshes only). Pre-bundling it
        // keeps the first click from triggering a re-optimize + full reload.
        "three-mesh-bvh",
      ],
    },

    build: {
      rollupOptions: {
        input: pages
          ? { main: html("index.html"), ventDemo: html("vent-demo.html") }
          : {
              demos: html("demos.html"),
              main: html("index.html"),
              perf: html("perf.html"),
              minimal: html("minimal.html"),
              embed: html("embed.html"),
              ventDemo: html("vent-demo.html"),
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
  };
});

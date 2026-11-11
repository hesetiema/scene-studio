# scene-studio

Embeddable 3D scene editor and model viewer for the web. Published as
[`@scenio/scene-editor`](https://www.npmjs.com/package/@scenio/scene-editor) — the `@scenio` scope is a placeholder.
This repo tracks `0.7.0`; the latest version published to npm is `0.6.0`.

**Docs:** English (this page) · [简体中文](README.zh-CN.md) · [Architecture & benchmarks](docs/ARCHITECTURE.md) · [Package quick start](packages/scene-editor/README.md) · [API reference](packages/scene-editor/API.md)

## What this is

One document model, one runtime contract, three ways to use it:

| Shape | Entry | Use when |
|---|---|---|
| **Viewer** | `<scene-editor src="model.glb">` | You only need the model on screen, orbitable, model-viewer style |
| **Editor** | `<scene-editor>` + `loadDocument(doc)` | The scene is editable: select, gizmo, add/remove, undo/redo, host save |
| **Headless** | `createSceneEditor({ runtime })` | You bring your own UI and inputs — zero DOM |

A preview is not a second code path: the element synthesizes a one-object document and drives
the same load/select/history pipeline, so a viewer can be upgraded to an editor without a rewrite.

The two shapes are **visually distinct by construction**: a `src` preview is `mode="viewer"` and
owns no authoring chrome — no transform gizmo, no click-to-select, no editor keystrokes — while a
host document is `mode="editor"`. `mode="viewer"` forces a read-only viewport for a saved scene;
the effective value is mirrored to `data-mode` for CSS.

```html
<!-- Viewer: one line, auto-framed; lifecycle via progress → load → error -->
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>

<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // idempotent, SSR-safe

  const el = document.querySelector("scene-editor");
  el.addEventListener("load", ({ detail }) => console.log("ready", detail.url));
  el.addEventListener("error", ({ detail }) => console.log(detail.code));
</script>
```

Declarative viewer chrome (all attribute-only, never written to the document):

```html
<scene-editor
  src="/models/robot.glb"
  loading="lazy"
  auto-rotate
  camera-orbit="0deg 75deg 2m"
  field-of-view="auto"
  environment-image="neutral"
  shadow-intensity="0.8"
  autoplay
  animation-name="Idle"
  reveal="interaction"
>
  <img slot="poster" src="/poster.jpg" alt="" />
  <div slot="progress-bar">Loading…</div>
  <div slot="error">Could not load the model</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">Lens</button>
</scene-editor>
```

`load` fires after the camera is framed, and a failure shows `slot="error"` (or a built-in message)
instead of leaving an empty canvas. Compressed glTF (Draco / KTX2 / Meshopt) needs one more attribute —
`decoder-path="/decoders/"` for a self-hosted payload directory or `decoder-cdn` for the pinned CDN;
without it a Draco model still fails, but now names the missing decoder instead of showing a blank
canvas.

Editing is document-driven (`loadDocument` with a schema-v3 JSON), headless-first, and host-owned
for persistence. Document shape, element API, assets, plugins and the save/conflict flow live in
[`packages/scene-editor/README.md`](packages/scene-editor/README.md); every symbol is in
[`API.md`](packages/scene-editor/API.md).

## Layout

```
packages/scene-editor/   the npm package (headless core + element + three adapter)
apps/playground/         reference host, ?demo= SDK scenarios, perf bench, visual fixtures
e2e/                     Playwright specs (critical, SDK, studio, visual, perf)
docs/                    architecture, highlights, measured benchmarks
scripts/                 release-metadata guard and npm pack smoke test
```

`three` is a peer dependency and only imported under `packages/scene-editor/src/three/`;
the core and element entries never touch a renderer.

## Develop

Requires Node 24+ and pnpm 11+.

```bash
pnpm install
pnpm typecheck    # tsc across packages that define the script
pnpm test         # 748 vitest unit tests
pnpm build        # vite build + .d.ts for every package
```

| Gate | Command | Covers |
|---|---|---|
| Unit | `pnpm test` | 81 test files, `three` version matrix in CI (`0.186.0` + `latest`) |
| E2E | `pnpm test:e2e` | critical flows + SDK scenarios on `minimal.html?demo=` + studio tools |
| Visual | `pnpm test:e2e:visual` | canvas-only baselines, SwiftShader, 1% tolerance |
| Perf | `pnpm test:perf` | first-interactive, p95 frame time, unload-zero |
| Release | `pnpm test:release` | package/README/LICENSE/repository consistency |
| Packaging | `pnpm test:pack` | `npm pack` → fresh consumer install/typecheck/build |

A red `latest` leg on a new `three` minor is the intended early warning for the peer range.
Playground: `pnpm --filter @scenio/playground dev` → <http://127.0.0.1:3000>
(see [apps/playground/README.md](apps/playground/README.md)). A loaded model opens in
**viewer** mode there; the header's 编辑 switch reveals the authoring chrome
(`?mode=editor` boots straight into it). The host-shaped API regression surface
now lives on `minimal.html?demo=<name>` — seven scenarios, the same 25 Playwright
cases and the same `window.__*` hooks as before. The standalone `demos/` pages
are gone; the coverage is not.

## Status and roadmap

`0.7.0` alpha (unreleased); npm `latest` is `0.6.0`. The API may still shift before `1.0.0`;
after that, semver applies.

- **`0.7.0`** — schema v3: real `parentId` hierarchy, `type: "primitive"` (8 procedural kinds),
  per-object `material` overrides, `view.lights.additional`; undoable `addObject` / `removeObject` /
  `reparent` / `setMaterial`, validated by the same `validateHierarchy` used on load.
- **`0.6.0`** — one-line glTF preview (`src`), auto-framing, `progress`/`load` lifecycle,
  tone mapping / exposure, `visibility-change` and opt-in `view-changing`.
- **Unreleased viewer surface** (element attributes + optional runtime methods, `view` schema
  untouched): `camera-orbit` / `field-of-view` with easing, `environment-image` presets and HDR URLs,
  contact shadows, embedded glTF cameras, morph targets, playback transport with `play` / `pause` /
  `loop` / `finished`, hotspots with normals, pointer sensitivities, `loaded` / `modelIsVisible`.
- **Unreleased viewer performance** — refcounted placeholder resources (5 000 objects: 11 MB of heap
  instead of 26 MB), per-asset static merge (200 same-material meshes → 1), BVH-accelerated picking
  above 2 000 triangles (12.0 ms → 0.10 ms, loaded on demand in its own chunk), and multi-clip
  blending on a single mixer.
- **Unreleased integration ergonomics** — the host-side "upload → edit → export" boilerplate moved
  into the SDK: `createSceneDocument` / `createDocumentFromAsset`, `createFileBundleUrl` +
  `el.loadFiles()` (with `assetFormatHint` so `blob:` URLs parse correctly), `el.exportDocument()`
  exporting document transforms rather than preview state, `downloadBlob()` and `el.toBlob()`.
  Viewport overlays are pure attributes now: `display-mode` (shading — batching-aware) and
  `explode` (component explode, document-preserving), plus `LIGHTING_PRESETS` as exportable data.

Next: see [TODOS.md](TODOS.md) for the prioritised viewer gaps, editing gaps and explicit non-goals
(no CRDT collaboration, no plugin panel slots, no per-product package split).

## Documentation

| Document | Language | Covers |
|---|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 简体中文 | Layers, design decisions, highlights, measured benchmarks |
| [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md) | EN / 中文 | Project overview, development, gates, release |
| [packages/scene-editor/README.md](packages/scene-editor/README.md) | English | Install, viewer + editor usage, document model, assets, plugins |
| [packages/scene-editor/README.zh-CN.md](packages/scene-editor/README.zh-CN.md) | 简体中文 | Quick start and core concepts |
| [packages/scene-editor/API.md](packages/scene-editor/API.md) | English | Full API reference |
| [apps/playground/README.md](apps/playground/README.md) | English | Reference host and module map |
| [e2e/visual/README.md](e2e/visual/README.md) | 简体中文 | Visual regression workflow |
| [TODOS.md](TODOS.md) | 简体中文 | Prioritised gaps and explicit non-goals |

## License

MIT — see [LICENSE](LICENSE).

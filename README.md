# scene-studio

Embeddable 3D scene editor SDK for the web. Published as [`@scenio/scene-editor`](https://www.npmjs.com/package/@scenio/scene-editor) — the `@scenio` scope is a placeholder. This repo tracks `0.5.0`; the latest published version is `0.3.0`.

**Docs:** English (this page) · [简体中文](README.zh-CN.md) · [Package quick start](packages/scene-editor/README.md) · [API reference](packages/scene-editor/API.md)

## What this is

`<scene-editor>` is a web component that gives any page an editable 3D viewport: load a JSON scene document, orbit and zoom, click-select, transform with gizmos, undo/redo, and save through a host-owned transport with structured conflicts. glTF/GLB assets and animation clips are supported.

Prefer your own UI? `createSceneEditor()` exposes the same editing logic — document state, history, selection, plugins, typed events — with zero DOM. Rendering sits behind a small `RuntimeContract`, so unit tests can use `FakeRuntime` and hosts can use `ThreeRuntime` or a custom runtime. WebGL2 is the default; WebGPU is available through the documented `rendererFactory` seam.

**Current editing scope:** transforms and view state. Creating, deleting, duplicating or reparenting objects, material editing, morph targets and HDR environments are not part of the document API yet. See [Status and roadmap](#status-and-roadmap).

## Quick start

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // idempotent and SSR-safe

  const el = document.querySelector("scene-editor");
  await el.ready;

  await el.loadDocument({
    schemaVersion: 2,
    sceneId: "demo",
    revision: 0,
    objects: [
      {
        id: "box-1",
        type: "mesh",
        name: "Box",
        position: [0, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    view: {
      camera: { position: [6, 5, 10], target: [0, 0, 0], fov: 60 },
      lights: {
        ambient: { color: "#ffffff", intensity: 0.55 },
        directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
      },
      environment: { background: null, gridVisible: true, iblIntensity: 1 },
    },
  });
</script>

<scene-editor style="width: 640px; height: 400px"></scene-editor>
```

Drag to orbit, scroll to zoom, click to select (`Shift`/`Ctrl`/`Cmd`+click toggles multi-select), drag the gizmo to transform, and use `Ctrl+Z` / `Ctrl+Shift+Z` while focus is inside the element.

### Headless

```ts
import { createSceneEditor, FakeRuntime } from "@scenio/scene-editor";

const editor = createSceneEditor({ runtime: new FakeRuntime() });

await editor.loadDocument(doc);
editor.select(["box-1"]);
editor.applyTransform("box-1", from, to); // one undoable command
editor.undo();

editor.on("save-request", ({ document }) => {
  // the SDK never talks to your backend
  fetch("/api/scene", { method: "PUT", body: JSON.stringify(document) });
});

editor.requestSave();
```

## Layout

```
packages/scene-editor/   the npm package (headless core + element + three adapter)
apps/playground/         reference host, SDK demos, perf bench, visual fixtures
e2e/                     Playwright specs (critical, SDK, studio, visual, perf)
scripts/                 release metadata guard and npm pack smoke test
```

## Playground

`apps/playground` is the reference host and the place where integration problems show up first. It loads GLB/GLTF/OBJ/STL (including multi-file `.gltf` bundles), offers shading modes (studio / X-Ray / wireframe / normal / clay), skeleton overlay, explode preview, analytic lights plus built-in IBL, backdrop presets, exposure and tone mapping, camera presets, turntable, animation transport, gizmo tools, snapshots and GLB/OBJ export.

The viewer architecture is intentionally boring: one `ViewerStore` fans out to `ViewerController.update*()`, and HUD panels only patch state.

Focused SDK demos live under `/demos/` (host editing API, document model, headless facade, assets) and are asserted by `e2e/sdk-coverage.spec.ts`; `minimal.html` is the smallest end-to-end integration.

- `?scene=default` loads the deterministic `box-1 / box-2 / gem-1` fixture used by the e2e suites.
- `?model=<id>` jumps straight to a Khronos sample.
- `?select=<id>` selects an object and optionally applies `&move=x,y,z&rot=x,y,z&scale=x,y,z` for reproducible screenshots.
- The bare URL opens a minimal home screen with drag-and-drop and sample links.

Host wiring lives in `src/main.ts`; view state lives in `src/viewer/`; HUD chrome is composed from `src/ui/panels/` by `src/ui/studio-shell.ts`.

## Develop

Requires Node 24+ and pnpm 11+.

```bash
pnpm install
pnpm typecheck           # tsc across packages that define the script
pnpm test                # vitest unit tests
pnpm build               # vite build + .d.ts for every package
```

### E2E and quality gates

```bash
pnpm test:e2e            # full suite: critical + visual + perf
pnpm test:e2e:visual     # visual regression only (SwiftShader, canvas-only)
pnpm test:perf           # first-interactive + p95 frame-time gate
pnpm test:release        # package/README/LICENSE/repository consistency
pnpm test:pack           # npm pack -> fresh consumer install/typecheck/build
```

CI (`.github/workflows/ci.yml`) runs unit tests on a `three` version matrix (`0.186.0` pinned plus `latest`), critical e2e flows, the visual regression gate, the perf gate with relaxed thresholds, the release-metadata check, and the pack smoke. A red `latest` leg on a new three minor is the intended early warning for the peer range.

### Playwright notes

- Config: `e2e/playwright.config.ts`. Projects: `chromium` (critical), `visual` (software-rendered screenshots, CI-gated), and `perf` (runs alone to avoid frame-time contention).
- Local runs reuse an already-serving dev server on port 4173; CI starts its own.
- Visual baselines live under `e2e/visual/__screenshots__/visual/`. They are canvas-only captures rendered with SwiftShader, so they do not depend on the host GPU or fonts. Refresh with `pnpm test:e2e:visual --update-snapshots` and commit the PNGs.

## Versioning and release

- Every completed phase bumps the minor (`0.x.0`) and tags it; the first stable release is `1.0.0` once the public API is locked.
- `.github/workflows/publish.yml` publishes when a `0.*` tag matching the package version is pushed (`next` for prereleases, `latest` for stable).
- `pnpm test:release` keeps package metadata, README version and status, LICENSE, and the repository URL in sync. It runs in CI and before publishing.
- `npm pack` must stay green (`pnpm test:pack`) — it is the release gate for consumer-facing package contents.

## Status and roadmap

`0.5.0` alpha in this repo. The latest published version is `0.3.0`; `0.4.0`/`0.5.0` have not been released yet. The API may still shift before `1.0.0`; after that, semver applies.

Planned next steps ([TODOS.md](TODOS.md)):

- HDR environment maps and environment presets.
- Switching to cameras embedded in a glTF asset.
- Morph-target controls.

Known gaps before this is a general-purpose scene editor:

- Object creation, deletion, duplication and reparenting.
- Material edits persisted in the document (the playground material panel is preview-only).
- Multi-object transform.

Explicitly not planned: CRDT/real-time collaboration, plugin panel slots, and splitting the package per product.

## Documentation

| Document | Language | Covers |
|---|---|---|
| [README.md](README.md) | English | Project overview, development, release |
| [README.zh-CN.md](README.zh-CN.md) | 简体中文 | Project overview, development, release |
| [packages/scene-editor/README.md](packages/scene-editor/README.md) | English | Install, usage, document model, assets, plugins |
| [packages/scene-editor/README.zh-CN.md](packages/scene-editor/README.zh-CN.md) | 简体中文 | Quick start and core concepts |
| [packages/scene-editor/API.md](packages/scene-editor/API.md) | English | Full API reference |
| [apps/playground/README.md](apps/playground/README.md) | English | Reference host and module map |
| [e2e/visual/README.md](e2e/visual/README.md) | 简体中文 | Visual regression workflow |
| [TODOS.md](TODOS.md) | 简体中文 | Roadmap and explicit non-goals |

## License

MIT — see [LICENSE](LICENSE).

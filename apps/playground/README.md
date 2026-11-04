# Playground

Reference host for `@scenio/scene-editor`: a full-screen viewport with the chrome a
real integration needs. Not published — it exists to exercise the SDK and to back
the Playwright visual/perf baselines.

```bash
pnpm --filter @scenio/playground dev      # http://127.0.0.1:3000
pnpm --filter @scenio/playground typecheck
```

## Module map

| Path | Responsibility |
|---|---|
| `src/main.ts` | Composition root: runtime factory, document boot, host save/conflict store, viewer store/controller, `window.__*` e2e hooks |
| `src/bootstrap.ts` | Deterministic scene documents (`mechaAssemblyDoc`, `defaultMultiDoc`, single-model presets) |
| `src/assets/model-loader.ts` | Asset registry, lazy GLTF/Draco/Meshopt loading, custom file → `SceneDocument`, multi-file `.gltf` bundle inlining |
| `src/viewer/viewer-state.ts` | Single viewer state + store (`ViewerState`); panels patch it, the controller subscribes |
| `src/viewer/viewer-controller.ts` | State → engine: display mode, skeleton overlay, backdrop/grid, lighting preset, exposure/tone mapping, turntable, animation transport |
| `src/viewer/display-modes.ts` | Studio / X-Ray / wireframe / normal / clay shading; owns and disposes its material overrides |
| `src/viewer/presets.ts` | Lighting, backdrop and grid presets — persisted through `view` (D22), applied idempotently |
| `src/camera/camera-controller.ts` | Frame / preset / turntable. Preview frames go through `runtime.applyViewState()`; the document is written once per gesture |
| `src/ui/studio-shell.ts` | Composes panels, hotkeys, explode preview, drag & drop; `onDocumentLoaded()` re-sync hook |
| `src/ui/panel.ts` | `BasePanel`: listener collection + single destroy path for every HUD panel |
| `src/ui/panels/*.ts` | Model, transform, camera, display, lighting, animation and document panels (one concern each) |
| `src/ui/drop-zone.ts` | Window-level multi-file drop with depth-counted overlay |
| `src/ui/explode-controller.ts` | Component-explode preview (runtime-only offsets, document positions stay the baseline) |
| `src/ui/scene-export.ts` | GLB / OBJ export from document transforms + PNG snapshot |
| `src/ui/hud-controller.ts` | Telemetry panel, selection inspector, dirty state, toasts, FPS meter |
| `src/interaction/hotkeys.ts` | Declarative single-key shortcuts (modifier combos belong to the element, D20) |
| `src/styles/{base,controls,hud}.css` | HUD styling extracted from the 680-line inline `<style>` block |
| `src/demos/*.ts` | Focused SDK demos — one API surface per page (see below) |
| `src/demos/shared.ts` | Demo plumbing: DOM lookups, log panel, fixture document, transform helper |
| `minimal.html` + `src/minimal.ts` | Smallest end-to-end integration (element + load + save loop) |

Additional entries: `perf.html` (D10 bench) and `demos/` (SDK coverage pages).

## SDK coverage demos

`demos/` is the "full coverage" regression surface: the studio exercises the
viewer-shaped API, these pages exercise the host-shaped API. Each page is
asserted by `e2e/sdk-coverage.spec.ts`; hostile input and hostile timing are
covered by `e2e/demos-adversarial.spec.ts` (injection through document data,
undo storms, concurrent/interleaved `loadDocument`, resolver trust boundary,
prototype pollution, malformed JSON).

| Page | Surface |
|---|---|
| `demos/host-api.html` | multi-select (`select` / `addToSelection` / `removeFromSelection` / `toggleSelection`), `executeCommand`, `applyRemote` fast-forward + structured conflict resolution |
| `demos/document.html` | `migrateSceneDocument` (v1→v2), `parseSceneDocument`, `validateHierarchy`, import into the editor |
| `demos/headless.html` | `createSceneEditor` + `FakeRuntime`: document, history, selection, save, remote sync, keyboard map, plugins, teardown — no DOM/GPU |
| `demos/assets.html` | `element.assetResolver` (allowlist trust boundary) + GLB instantiation, `AssetCache` refcounts, `asset-resolve-failed` / `asset-unsupported-format` / `asset-load-failed` codes |

```bash
pnpm --filter @scenio/playground dev
# http://127.0.0.1:3000/demos/            hub
# http://127.0.0.1:3000/demos/host-api.html
```

Each page exposes a `window.__demo` / `__docDemo` / `__coverage` / `__assets`
hook so Playwright asserts behavior, not pixels.

WebGPU is still supported through the SDK's `rendererFactory` seam (see
`packages/scene-editor/README.md`); the evaluation probe page was removed once
the seam was documented and covered by the runtime contract.

## URL parameters

| Parameter | Effect |
|---|---|
| *(none)* | Mecha showcase scene |
| `?scene=default` | Deterministic `box-1 / box-2 / gem-1` fixture used by e2e |
| `?select=<id>` | Load the fixture and select an object |
| `&move=x,y,z` `&rot=x,y,z` `&scale=x,y,z` | Apply one undoable transform (screenshot fixtures) |

## Design notes

- **View state is persisted, previews are not.** Camera flight, turntable and explode
  render through runtime-only paths; a single `setViewState()` commits when the
  gesture ends. This keeps `view-change` / dirty events at human granularity instead
  of 60 per second.
- **One state, one update path (viewer pattern).** Panels never call the runtime for
  view concerns; they patch `ViewerStore`. `ViewerController` diffs the slice and runs
  a single `update*()` (display, environment, render settings, animation). This is the
  three-gltf-viewer split: `state` → `Viewer#update*` → engine.
- **Shading overrides are owned.** `createDisplayModes` caches the original material
  per mesh, tracks generated materials and disposes them on mode change, and only
  traverses document objects (never the grid, lights or gizmo helper).
- **Animation is a runtime concern.** Clip lists come from `LoadedAsset.animations`;
  the panel only selects/plays/pauses/scubs through `ThreeRuntime`. The demo preset
  `kinetic-orb` ships `Orbit` + `Breathe` clips so the transport has e2e coverage.
- **Multi-file drops are inlined.** A dropped `.gltf` has its `buffers[].uri` and
  `images[].uri` rewritten to Blob URLs before loading, so `.bin` + textures resolve
  without a custom `LoadingManager` (the standalone viewer's `assetMap` equivalent).
- **Export uses the document, not the viewport.** Objects are cloned with their stored
  transforms, so an exploded preview or an in-flight drag never leaks into the file.

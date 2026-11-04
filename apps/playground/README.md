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
| `src/bootstrap.ts` | Deterministic scene documents (`showcaseDoc`, `defaultMultiDoc`, single-model presets) |
| `src/assets/model-loader.ts` | Asset registry, lazy GLTF/Draco/Meshopt loading, custom file → `SceneDocument`, multi-file `.gltf` bundle inlining |
| `src/viewer/viewer-state.ts` | Single viewer state + store (`ViewerState`) backed by a valtio proxy (vanilla): panels patch it, the controller subscribes, `snapshot()` copies form the undo stack |
| `src/viewer/history-coordinator.ts` | Unified undo/redo across viewer settings and document commands (most-recent-first), plus the capture-phase Ctrl+Z/Ctrl+Y binding |
| `src/viewer/viewer-controller.ts` | State → engine: display mode, skeleton overlay, backdrop/grid, lighting preset + intensity/colour tuning, camera-follow light, exposure/tone mapping, turntable, animation transport |
| `src/viewer/display-modes.ts` | Studio / X-Ray / wireframe / normal / clay shading; owns and disposes its material overrides |
| `src/viewer/presets.ts` | Lighting, backdrop and grid presets — persisted through `view`, applied idempotently |
| `src/camera/camera-controller.ts` | Frame / preset / turntable. Preview frames go through `runtime.applyViewState()`; the document is written once per gesture |
| `src/ui/studio-shell.ts` | Composes panels, hotkeys, explode preview, drag & drop; `onDocumentLoaded()` re-sync hook |
| `src/ui/panel.ts` | `BasePanel`: listener collection + single destroy path for every HUD panel |
| `src/ui/panels/*.ts` | Lighting, material, background, display, model, camera, transform, animation, document and chrome (panel collapse) panels (one concern each) |
| `src/ui/welcome-screen.ts` | Minimal home screen: drop target + 选择文件 + inline sample links; the control panel, footer, save button and panel-restore icon stay hidden until a document with objects loads, and header home icon returns to it |
| `src/ui/drop-zone.ts` | Window-level multi-file drop with depth-counted overlay |
| `src/ui/explode-controller.ts` | Component-explode preview (runtime-only offsets, document positions stay the baseline) |
| `src/ui/material-controller.ts` | Selected-part material override (colour / opacity / metalness / roughness); snapshots originals for restore, never touches the document |
| `src/ui/scene-export.ts` | GLB / OBJ export from document transforms + PNG snapshot |
| `src/ui/hud-controller.ts` | Telemetry panel, selection inspector, dirty state, toasts, FPS meter |
| `src/interaction/hotkeys.ts` | Declarative single-key shortcuts (modifier combos belong to the element) |
| `src/styles/{base,controls,hud}.css` | HUD styling extracted from the 680-line inline `<style>` block |
| `src/demos/*.ts` | Focused SDK demos — one API surface per page (see below) |
| `src/demos/shared.ts` | Demo plumbing: DOM lookups, log panel, fixture document, transform helper |
| `minimal.html` + `src/minimal.ts` | Smallest end-to-end integration (element + load + save loop) |

Additional entries: `perf.html` (performance bench) and `demos/` (SDK coverage pages).

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

## Sample models

`public/assets/*.glb` are the Khronos glTF sample assets used by
[`GLTF-Sample-Viewer`](https://github.com/KhronosGroup/GLTF-Sample-Viewer); the
binaries come from [`glTF-Sample-Assets`](https://github.com/KhronosGroup/glTF-Sample-Assets)
(`Models/<Name>/glTF-Binary/`). Per-asset attribution and licences live in that
repository (`Models/<Name>/LICENSE.md`); `tri.glb` is a local test fixture.

## URL parameters

| Parameter | Effect |
|---|---|
| *(none)* | Minimal home screen (drop target + sample links); nothing loads until the user acts |
| `?model=<id>` | Jump straight to a sample: `damaged-helmet` / `boom-box` / `fox` / `water-bottle` / `milk-truck` |
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
- **Undo/redo has two stacks behind one pair of buttons.** Panel settings live in the
  valtio store, so `snapshot()` copies give them a history of their own (a continuous
  slider drag within 400ms collapses to one step; play/pause and turntable are
  transient and skipped). Document commands stay in the SDK history.
  `HistoryCoordinator` undoes whichever side changed last (timestamps), replays redo in
  reverse undo order, and owns Ctrl+Z/Ctrl+Y at the window capture phase so the
  element's own handler never double-undoes. Text fields keep native undo. Undo/redo
  are two icon buttons in the panel header — they apply to every group, so they must
  not hide inside a collapsible group. The header's `?` button reveals the keyboard
  map on hover/focus instead of printing it inside 文件与导出.
- **Normalization sits inside an identity wrapper.** `instantiateAsset` overwrites the
  root transform with the document values, so the universal loader's center/scale has to
  live one level below the returned root — otherwise a 154-unit sample snaps back to raw
  scale and the camera frames it from 200 units away. Skinned assets are cloned through
  `SkeletonUtils.clone`, so animation drives the instance's own bones instead of the
  cached skeleton.
- **Lighting is analytic + IBL.** Ambient/directional lights follow `view.lights`;
  `view.environment.iblIntensity` drives a PMREM-prefiltered `RoomEnvironment`
  (built into three, no asset to fetch) so metals and glass reflect something
  instead of going black. The 灯光 panel's 环境光照 slider writes that field —
  dirty, not undoable, same channel as the backdrop. `0%` is the pre-IBL look;
  WebGPU and GPU-less runtimes skip the map silently.
- **Shading overrides are owned.** `createDisplayModes` caches the original material
  per mesh, tracks generated materials and disposes them on mode change, and only
  traverses document objects (never the grid, lights or gizmo helper).
- **Animation is a runtime concern.** Clip lists come from `LoadedAsset.animations`;
  the panel only selects/plays/pauses/scubs through `ThreeRuntime`. The `fox` sample
  ships three clips (`Survey` / `Walk` / `Run`) and `milk-truck` one (`Wheels`), so
  the transport has e2e coverage without a procedural fixture.
- **Multi-file drops are inlined.** A dropped `.gltf` has its `buffers[].uri` and
  `images[].uri` rewritten to Blob URLs before loading, so `.bin` + textures resolve
  without a custom `LoadingManager` (the standalone viewer's `assetMap` equivalent).
- **Framing is model-driven, clip planes follow the camera.** Sample assets are authored
  at very different scales, so a hard-coded camera distance cannot fit them. The
  fit distance comes from the bounding sphere and the narrower FOV, and near/far are
  re-derived each frame from the live camera distance — wheel zoom never clips the
  model. The auto-fit on open only moves the camera (no `setViewState`), so a freshly
  loaded scene stays "未修改".
- **Export uses the document, not the viewport.** Objects are cloned with their stored
  transforms, so an exploded preview or an in-flight drag never leaks into the file.
- **Lighting/material tweaks are previews too.** Preset selection persists through
  `view.lights`; the per-light intensity/colour overrides and the selected-part material
  override only go through `runtime.applyViewState()` / material snapshots. "主光跟随视角"
  is a rAF head-light that skips re-rendering while the camera is still.

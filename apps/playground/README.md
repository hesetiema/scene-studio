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
| `src/bootstrap.ts` | Deterministic scene documents — built with the SDK's `createDocumentFromAsset` / `createSceneDocument` (the envelope is no longer hand-written) |
| `src/assets/model-loader.ts` | Asset registry, lazy GLTF/Draco/Meshopt loading, custom file → `SceneDocument`; `.gltf` sidecar inlining delegates to the SDK's `createFileBundleUrl` |
| `src/viewer/viewer-state.ts` | Single viewer state + store (`ViewerState`) backed by a valtio proxy (vanilla): panels patch it, the controller subscribes, `snapshot()` copies form the undo stack |
| `src/viewer/history-coordinator.ts` | Unified undo/redo across viewer settings and document commands (most-recent-first), plus the capture-phase Ctrl+Z/Ctrl+Y binding |
| `src/viewer/viewer-controller.ts` | State → engine: skeleton overlay, backdrop/grid, lighting preset + intensity/colour tuning, camera-follow light, animation transport. Display mode, explode, tone mapping, exposure and the turntable all go through the contract (`setDisplayMode` / `setExplode` / `setToneMapping` / `setExposure` / `setAutoRotate`), never a direct renderer or scene mutation |
| `src/viewer/presets.ts` | Lighting, backdrop and grid presets — persisted through `view`, applied idempotently |
| `src/camera/camera-controller.ts` | Frame / presets / fly-to. Preview frames go through `runtime.applyViewState()`; the flight easing is the SDK's `smoothViewTo()` (the document is still written once, after the fade settles). Clip planes and turntable are SDK-owned (`render()` / `setAutoRotate`) — no host-side rAF tickers |
| `src/ui/studio-shell.ts` | Composes panels, hotkeys, drag & drop; `onDocumentLoaded()` re-sync hook |
| `src/ui/panel.ts` | `BasePanel`: listener collection + single destroy path for every HUD panel |
| `src/ui/panels/*.ts` | Lighting, material, background, display, model, camera, transform, animation, document and chrome (panel collapse) panels (one concern each) |
| `src/ui/welcome-screen.ts` | Minimal home screen: drop target + 选择文件 + inline sample links; the control panel, footer, save button and panel-restore icon stay hidden until a document with objects loads, and header home icon returns to it |
| `src/ui/mode-switch.ts` | Top-bar 查看 / 编辑 switch: writes `el.mode`, mirrors `body[data-studio-mode]`, gates host-side editing hotkeys/save; no document writes |
| `src/styles/mode.css` | Segmented mode switch styling + the viewer-only chrome rules (hide panel, footer, save and panel-restore) |
| `src/ui/drop-zone.ts` | Window-level multi-file drop with depth-counted overlay |
| `src/ui/material-controller.ts` | Selected-part material override (colour / opacity / metalness / roughness); snapshots originals for restore, never touches the document |
| `src/ui/scene-export.ts` | Thin wrapper over the SDK's `el.exportDocument()` + `downloadBlob()` (GLB / OBJ, document transforms) + PNG snapshot via `el.toBlob()` |
| `src/ui/hud-controller.ts` | Telemetry panel, selection inspector, dirty state, toasts, FPS meter |
| `src/interaction/hotkeys.ts` | Declarative single-key shortcuts (modifier combos belong to the element) |
| `src/styles/{base,controls,hud,welcome,mode}.css` | HUD styling extracted from the 680-line inline `<style>` block, plus the home-screen and viewer/editor chrome rules |
| `minimal.html` + `src/minimal.ts` | Smallest end-to-end integration (element + load + save loop), run synchronously on the bare URL |

Additional entries: `perf.html` (performance bench — `?objects=5000&instancing=0` for the
unbatched control; the report also carries a close-up pass that proves chunked batching still
culls, and the shared-resource pool size as `sharedResources` / `sharedGeo`+`sharedMat`, which is
what keeps 5 000 placeholders at ~11 MB of heap instead of ~26 MB).

## Viewer-first workflow

The studio boots with a host document, so the SDK would derive `mode="editor"`.
The page deliberately overrides that: **every model opens as a viewer** —
full-bleed canvas, no gizmo, no click-to-select, no authoring chrome. The header
segmented control (`#mode-viewer` / `#mode-editor`) is the only way in; switching
to 编辑 restores the panels, footer, save/undo/redo and the transform gizmo.

- `main.ts` sets `mode` **before** `defineSceneEditor()` upgrades the element, so
  `#init()` builds the runtime with the correct `interactive` flag (no gizmo
  mount-then-teardown). `ModeSwitch` then owns `el.mode` +
  `body[data-studio-mode]`; `mode.css` keys the chrome off that dataset value.
- Viewing is read-only end to end: `G`/`R`/`S` and Ctrl+Z/Y are gated in the
  host too, `save-request` is ignored in viewer mode, and the SDK clears the
  selection on the way back. Flipping modes writes nothing to the document.
- `?mode=editor` starts in the editor — the deterministic e2e/visual fixtures
  use it so screenshots and gizmo tests stay unchanged. The choice is sticky
  while loading other models, and resets to viewer on 回到首页.
- Switching editor → viewer only changes the layout; the camera keeps its orbit
  (press `F` to re-fit to the narrower viewport).

## Regression surface

`vite.config.ts` has three HTML entries (`index.html`, `perf.html`,
`minimal.html`). SDK-level coverage lives in `packages/scene-editor/test/`;
browser-level regression lives in `e2e/*.spec.ts` against the studio, the
minimal page and the perf bench. The former `?demo=` scenario pages and their
Playwright suites (`sdk-coverage.spec.ts` / `demos-adversarial.spec.ts`) have
been removed — the SDK surfaces they exercised are covered by unit tests.

```bash
pnpm --filter @scenio/playground dev
# http://127.0.0.1:3000/                           studio (viewer-first)
# http://127.0.0.1:3000/minimal.html               smallest host integration
# http://127.0.0.1:3000/perf.html?objects=5000     performance bench
```

WebGPU is still supported through the SDK's `rendererFactory` seam (see
`packages/scene-editor/README.md`); the evaluation probe page was removed once
the seam was documented and covered by the runtime contract.

## Sample models

`public/assets/*.glb` are the Khronos glTF sample assets used by
[`GLTF-Sample-Viewer`](https://github.com/KhronosGroup/GLTF-Sample-Viewer); the
binaries come from [`glTF-Sample-Assets`](https://github.com/KhronosGroup/glTF-Sample-Assets)
(`Models/<Name>/glTF-Binary/`). Per-asset attribution and licences live in that
repository (`Models/<Name>/LICENSE.md`). `tri-draco.glb` is a local test fixture
compressed with `pnpm dlx @gltf-transform/cli draco` so `decoder-path` has a
fixture that three cannot parse without a decoder.

`public/decoders/` mirrors three's payload layout (`draco/gltf` + `basis`, copied
from `three/examples/jsm/libs`) so `e2e/decoders.spec.ts` runs offline. It is not
part of the SDK: a host points `decoder-path` at its own copy or at
`decoder-cdn`.

## URL parameters

| Parameter | Effect |
|---|---|
| *(none)* | Minimal home screen (drop target + sample links); nothing loads until the user acts |
| `?model=<id>` | Jump straight to a sample: `damaged-helmet` / `boom-box` / `fox` / `water-bottle` / `milk-truck`. Opens in **viewer** mode |
| `?mode=editor` | Boot straight into the editor (gizmo + full panel chrome). Default is viewer; `?mode=viewer` is a no-op |
| `?scene=default` | Deterministic `box-1 / box-2 / gem-1` fixture used by e2e |
| `?select=<id>` | Load the fixture and select an object |
| `&move=x,y,z` `&rot=x,y,z` `&scale=x,y,z` | Apply one undoable transform (screenshot fixtures) |

## Design notes

- **View state is persisted, previews are not.** Camera flight and explode render
  through runtime-only paths; a single `setViewState()` commits when the gesture ends
  (the flight commits once, after the SDK's `smoothViewTo()` fade settles). Turntable is
  the SDK's rig-level `setAutoRotate` — presentational like model-viewer's, so a spin
  never dirties the document. This keeps `view-change` / dirty events at human
  granularity instead of 60 per second.
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
- **Shading and explode are SDK rigs.** `setDisplayMode` / `setExplode` own the override materials
  (one shared material per mode), cover the instancing chunks, restore exactly on `studio` / `0`,
  and re-cover content mounted later. The studio only routes viewer-state slices to them.
- **Animation is a runtime concern.** Clip lists come from `LoadedAsset.animations`;
  the panel only selects/plays/pauses/scubs through `ThreeRuntime`. The `fox` sample
  ships three clips (`Survey` / `Walk` / `Run`) and `milk-truck` one (`Wheels`), so
  the transport has e2e coverage without a procedural fixture.
- **Multi-file drops are inlined — by the SDK.** `el.loadFiles()` runs the dropped files
  through `createFileBundleUrl()`, which rewrites a `.gltf`'s `buffers[].uri` and
  `images[].uri` to Blob URLs (the standalone viewer's `assetMap` equivalent) and mints
  an `upload-<n>-<name>` asset id; the studio keeps only its "which files did the user
  drop" bookkeeping.
- **Framing is model-driven; clip planes are the SDK's.** Sample assets are authored
  at very different scales, so a hard-coded camera distance cannot fit them: the
  fit distance comes from the bounding sphere and the narrower FOV, and the
  auto-fit on open only moves the camera (no `setViewState`), so a freshly
  loaded scene stays "未修改". `near/far` are re-derived by the runtime on every
  render from the camera→target distance and the content radius, so millimetre
  CAD and kilometre terrain both stay visible and a wheel zoom never clips the
  model — no host-side per-frame sync.
- **Viewer vs editor is a mode, not a page.** The studio uses a host document but
  explicitly pins `mode="viewer"` before the element upgrades, so a loaded model
  starts read-only; the header switch writes `el.mode = "editor"` to bring back the
  gizmo, click-to-select, `G`/`R`/`S` and the undo keys, plus the panel/footer chrome
  (`body[data-studio-mode]`). A `src`-driven element derives `mode="viewer"` on
  its own (see `e2e/decoders.spec.ts`). The effective SDK mode is mirrored
  to `data-mode`, so a page can style the two differently.
- **`load` waits for framing.** The `src` path dispatches `load` after `frameViewer()`,
  so a callback that reads `getDimensions()` or the camera already sees the final fit.
- **Export uses the document, not the viewport — via the SDK.** `el.exportDocument()`
  serializes stored transforms, so an exploded preview or an in-flight drag never leaks
  into the file; `downloadBlob()` handles naming and saving.
- **Lighting tweaks are previews; material edits are not.** Preset selection persists through
  `view.lights`; the per-light intensity/colour overrides only go through
  `runtime.applyViewState()`. Material edits go through `editor.setMaterial()`, so they land in
  the document and the undo stack — and a slider drag collapses into a single undo step
  (`SetMaterialCommand.mergeWith`). "主光跟随视角" is a rAF head-light that skips re-rendering
  while the camera is still.

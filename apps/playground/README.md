# Playground

Reference host for `@scenio/scene-editor`: a full-screen viewport with the chrome a
real integration needs. Not published — it exists to exercise the SDK and to back
the Playwright visual/perf baselines.

```bash
pnpm --filter @scenio/playground dev      # http://127.0.0.1:3000
pnpm --filter @scenio/playground typecheck
```

## Directory layout

`src/` mirrors the pages: **one directory per HTML entry**, and the pages share nothing but the
SDK. A module belongs to the page that uses it, so adding a page means adding a directory — not
threading a new top-level folder through the others.

```text
apps/playground/
  index.html      studio（产品本身，唯一对外发布的一页）
  vent-demo.html  通风感知 demo
  embed.html      声明式接入参考
  minimal.html    最小宿主
  perf.html       性能仪器（CI）
  demos.html      本地示例索引

  src/
    studio/   ← index.html
      main.ts        合成根：runtime 工厂、文档启动、保存/冲突、e2e 钩子
      bootstrap.ts   确定性场景文档
      assets/        资产注册表 + 懒加载 GLTF/Draco/Meshopt
      camera/        取景 / 预设 / 飞向
      interaction/   快捷键
      styles/        HUD、欢迎屏、查看/编辑模式样式
      ui/            shell、panels/、HUD、冲突条、拖放、导出
      viewer/        视图状态与 store、撤销栈、预设、状态 → 引擎
    vent/     ← vent-demo.html
      main.ts        页面：双视图、图元层装配、包围盒取景、相机
      bim/           结构装载（应用级，不进 SDK）
      graph/         与框架无关的图元 / 聚合 / 碰撞层
    embed/    ← embed.html      main.ts
    minimal/  ← minimal.html    main.ts
    perf/     ← perf.html       main.ts

  public/       静态资源（assets、demos 缩略图入库；data、bim 不入库）
  scripts/      缩略图重拍脚本
```

The HTML files stay at the package root because **their filenames are URLs**, and those URLs are
the contract the e2e suite, the perf report and the visual baselines drive (`/`, `/embed.html`,
`/minimal.html`, `/perf.html`, `/vent-demo.html`). Filing them under `pages/` would rename every
fixture for no structural gain; the entry module is one line inside each page's directory instead.

## Module map

### `src/studio/` — the studio page

| Path | Responsibility |
|---|---|
| `src/studio/main.ts` | Composition root: runtime factory, document boot, host save/conflict store, viewer store/controller, `window.__*` e2e hooks |
| `src/studio/bootstrap.ts` | Deterministic scene documents — built with the SDK's `createDocumentFromAsset` / `createSceneDocument` (the envelope is no longer hand-written) |
| `src/studio/assets/model-loader.ts` | Asset registry, lazy GLTF/Draco/Meshopt loading, custom file → `SceneDocument`; `.gltf` sidecar inlining delegates to the SDK's `createFileBundleUrl` |
| `src/studio/viewer/viewer-state.ts` | Single viewer state + store (`ViewerState`) backed by a valtio proxy (vanilla): panels patch it, the controller subscribes, `snapshot()` copies form the undo stack |
| `src/studio/viewer/history-coordinator.ts` | Unified undo/redo across viewer settings, document commands and camera poses (most-recent-first), plus the capture-phase Ctrl+Z/Ctrl+Y binding |
| `src/studio/viewer/viewer-controller.ts` | State → engine: skeleton overlay, backdrop/grid, lighting preset + intensity/colour tuning, camera-follow light, animation transport. Display mode, explode, tone mapping, exposure and the turntable all go through the contract (`setDisplayMode` / `setExplode` / `setToneMapping` / `setExposure` / `setAutoRotate`), never a direct renderer or scene mutation |
| `src/studio/viewer/presets.ts` | Lighting, backdrop and grid presets — persisted through `view`, applied idempotently |
| `src/studio/camera/camera-controller.ts` | Frame / presets / fly-to. Preview frames go through `runtime.applyViewState()`; the flight easing is the SDK's `smoothViewTo()` (the document is still written once, after the fade settles). Clip planes and turntable are SDK-owned (`render()` / `setAutoRotate`) — no host-side rAF tickers. A `commit: false` frame reports through `onProgrammaticView` so the undo stack can move its camera baseline without recording a step |
| `src/studio/ui/studio-shell.ts` | Composes panels, hotkeys, drag & drop; `onDocumentLoaded()` re-sync hook |
| `src/studio/ui/panel.ts` | `BasePanel`: listener collection + single destroy path for every HUD panel |
| `src/studio/ui/panels/*.ts` | Lighting, material, background, display, model, camera, transform, animation, document, chrome (panel collapse), **object** (add/duplicate/remove/reparent) and **variant** (KHR variants, asset cameras, morph targets) panels (one concern each) |
| `src/studio/ui/conflict-controller.ts` | The decision surface for a `conflict` error: shows the bar, offers 覆盖远端 / 采纳远端 / 稍后, and mirrors the split into the footer via `hud.setConflict()`. The only place that calls the host's `overwriteRemote` / `adoptRemote` |
| `src/studio/ui/welcome-screen.ts` | Home screen: one line of positioning (`@scenio/scene-editor` 演示宿主) + drop target + 选择文件 + annotated sample links + GitHub / npm / API links; the control panel, footer, save button and panel-restore icon stay hidden until a document with objects loads, and header home icon returns to it |
| `src/studio/ui/mode-switch.ts` | Top-bar 查看 / 编辑 switch: writes `el.mode`, mirrors `body[data-studio-mode]`, gates host-side editing hotkeys/save; no document writes |
| `src/studio/ui/drop-zone.ts` | Window-level multi-file drop with depth-counted overlay |
| `src/studio/ui/material-controller.ts` | Selected-part material override (colour / opacity / metalness / roughness); snapshots originals for restore, never touches the document |
| `src/studio/ui/scene-export.ts` | Thin wrapper over the SDK's `el.exportDocument()` + `downloadBlob()` (GLB / OBJ, document transforms) + PNG snapshot via `el.toBlob()` |
| `src/studio/ui/hud-controller.ts` | Footer sync state (`已保存 rN` / `rN · 未保存改动` / `冲突 · 本地 rN / 远端 rM`), live camera readout, FPS meter, selection inspector, toasts |
| `src/studio/interaction/hotkeys.ts` | Declarative single-key shortcuts (modifier combos belong to the element) |
| `src/studio/styles/{base,controls,hud,welcome,mode}.css` | HUD styling extracted from the 680-line inline `<style>` block, plus the home-screen and viewer/editor chrome rules. `mode.css` also owns the segmented switch and the viewer-only chrome rules (hide panel, footer, save and panel-restore) |

### `src/vent/` — the BIM demo

| Path | Responsibility |
|---|---|
| `src/vent/main.ts` | The page: dual view (white massing ↔ floor plan), space double geometry, room outlines, equipment icons, AABB collision folding, bbox framing, camera. No panel, no filter |
| `src/vent/bim/` | Structure loaders (`Scene.json` + revit floor geometry) — app-level, not SDK. Reads `public/data/vent/` + `public/bim/`, both gitignored; a missing snapshot renders the 准备提示 card |
| `src/vent/graph/` | The icon layer, framework-agnostic: aggregation chains, quadtree collision, DOM media overlay, state styles |

### Standalone entries

| Path | Responsibility |
|---|---|
| `minimal.html` + `src/minimal/main.ts` | Smallest end-to-end integration (element + load + save loop), run synchronously on the bare URL. Also the neutral host `decoders.spec.ts` / `viewer-mode.spec.ts` probe — the studio would not do, it registers a runtime with an asset cache |
| `embed.html` + `src/embed/main.ts` | The declarative surface, and nothing else: a single `<scene-editor src=… camera-orbit=… field-of-view=…>` tag with `poster` / `progress-bar` / `error` slots, plus a click-to-hotspot pass (`positionAndNormalFromPoint` → `slot="hotspot-*"` → `updateHotspot`). No panel, no document code — it exists to prove the embed story is three attributes deep |
| `perf.html` + `src/perf/main.ts` | The CI instrument: `?objects=5000&instancing=0` unbatched control, two-phase handshake (`ready` → metrics → `finish`) driven by `pnpm test:perf`. The report also carries a close-up pass (chunked batching still culls) and the shared-resource pool size (`sharedResources` / `sharedGeo`+`sharedMat`), which keeps 5 000 placeholders at ~11 MB of heap instead of ~26 MB. Not an example — it is not on `demos.html` |
| `demos.html` + `public/demos/*.jpg` | The entry page, split by intent rather than by file: **示例** (studio + vent demo, with screenshots) and **接入参考** (embed / minimal — linked by source file first, page second, because their value is the code, not the picture). Only the two 示例 carry thumbnails. Pure navigation — no JS, no shared modules, and no change to the five pages themselves (each keeps its own URL, so the e2e fixtures and the perf/visual baselines are unaffected). Re-shoot with `node apps/playground/scripts/capture-demo-thumbs.mjs` while the dev server runs. **Local only**: the Pages build emits `index.html` and nothing else, and hides this page's link from the welcome screen |

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

`vite.config.ts` has six HTML entries (`index.html`, `embed.html`, `perf.html`,
`minimal.html`, `vent-demo.html`, plus the `demos.html` index). SDK-level coverage lives in
`packages/scene-editor/test/`;
browser-level regression lives in `e2e/*.spec.ts` against the studio, the
minimal page, the embed page and the perf bench. The former `?demo=` scenario pages and their
Playwright suites (`sdk-coverage.spec.ts` / `demos-adversarial.spec.ts`) have
been removed — the SDK surfaces they exercised are covered by unit tests.
`demos.html` is deliberately a link list, not a router: the five pages stay separate documents
because they share nothing but the SDK, and collapsing them into one SPA would put the
perf/unload measurements and the URL-addressed e2e fixtures at risk. It also does not present
them as five equal examples — `embed` and `minimal` are integration references (the page is just
the proof that the code runs), so they get no screenshot and their rows link the source file
before the URL. `perf` is not listed there at all; this file is its only user-facing entry point.

### Two build surfaces

`vite build` emits all six entries. That is the surface CI and the e2e/perf suites drive, so
every page has to stay buildable — `minimal.html` is the neutral host `decoders.spec.ts` and
`viewer-mode.spec.ts` need, `perf.html` is the driver `perf.spec.ts` measures, `embed.html` is
what `embed.spec.ts` holds the declarative surface against.

`vite build --mode pages` (`pnpm --filter @scenio/playground build:pages`) emits the public
GitHub Pages site, and only `index.html`. The other five do not answer a stranger's first
question: `perf` is an instrument, `minimal` / `embed` are integration references whose value is
their source file, `vent-demo` needs a data snapshot that is deliberately not in the repo, and
`demos` is a local index. Removing them from the repo would remove test hosts; removing them
from this surface only removes noise.

Two things the pages build has to handle, both because project pages are served from
`/<repo>/`:

- `base: "/scene-studio/"`, so anything resolved at runtime must go through
  `import.meta.env.BASE_URL`. Vite rewrites build-time references only — it does not touch
  custom-element attributes such as `<scene-editor src>`, and it certainly does not touch
  strings inside modules (`src/studio/assets/model-loader.ts`).
- `public/` is shared with the local surface, so a plugin prunes `public/data`, `public/bim`
  and `public/demos` from the output. The first two are gitignored *because* they contain real
  project identifiers, and a local build should not quietly publish whatever is on disk.
  `main.ts` also sets `data-surface="public"`, which hides the welcome-screen links to pages
  this build does not emit.

```bash
pnpm --filter @scenio/playground dev
# http://127.0.0.1:3000/demos.html                 demo index (all six entries)
# http://127.0.0.1:3000/                           studio (viewer-first) — the published page
# http://127.0.0.1:3000/embed.html                 三行集成 / declarative embed
# http://127.0.0.1:3000/minimal.html               smallest host integration
# http://127.0.0.1:3000/perf.html?objects=5000     performance bench

pnpm --filter @scenio/playground build:pages       # what GitHub Pages serves
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

Three of them are there for a **capability**, not for their looks — the studio's
样例 chips and the 变体 group only light up when the asset actually declares
something:

| Asset | Declares | Exercises |
|---|---|---|
| `MaterialsVariantsShoe.glb` | `KHR_materials_variants` (3 套) | `availableVariants` / `variantName` — three does not parse the extension, so the SDK reads it out of the glTF JSON (`collectMaterialVariants`) |
| `MorphPrimitivesTest.glb` | 2 个静态 morph target，**0 条动画** | `morphTargets` / `setMorphInfluence` — a weight only sticks when no clip is driving that channel (an animated morph asset makes the slider read 被动画驱动) |
| `Cameras.gltf` + `.bin` | 两个具名相机 | `cameras` / `camera-name` / `setCameraByName` |

`public/decoders/` mirrors three's payload layout (`draco/gltf` + `basis`, copied
from `three/examples/jsm/libs`) so `e2e/decoders.spec.ts` runs offline. It is not
part of the SDK: a host points `decoder-path` at its own copy or at
`decoder-cdn`.

## URL parameters

| Parameter | Effect |
|---|---|
| *(none)* | Minimal home screen (drop target + sample links); nothing loads until the user acts |
| `?model=<id>` | Jump straight to a sample: `damaged-helmet` / `boom-box` / `fox` / `water-bottle` / `milk-truck` / `variants-shoe` / `morph-targets` / `cameras`. Opens in **viewer** mode |
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
- **Undo/redo has three stacks behind one pair of buttons.** Panel settings live in the
  valtio store, so `snapshot()` copies give them a history of their own (a continuous
  slider drag within 400ms collapses to one step; play/pause and turntable are
  transient and skipped). Document commands stay in the SDK history. Camera poses get
  a third stack of their own: the SDK deliberately persists `view` without putting it
  in the command stack (D22), but "I just orbited, Ctrl+Z should take me back" is too
  strong an expectation to break, so the host samples `view-change` — one event per
  gesture end, one per settled fly-to — and replays poses through `setViewState()`.
  The auto-fit after a load and a document load both move the baseline instead of
  recording a step, so the first undo returns to what the user actually saw. That fit is
  **committed** (`frameScene(false)`, not a preview) and immediately re-based with
  `markSaved()`: if only the runtime camera moved, the document would keep the fixture's
  pose while the screen showed another, and the first camera undo would write the fitted
  pose into the document — leaving "unsaved changes" on a scene nobody edited. Arrow-key / `+`-`-` orbit goes through `setCameraOrbit()` →
  `applyViewState()` (by design no event, no dirty) and is therefore not undoable.
  `HistoryCoordinator` undoes whichever side changed last (timestamps), replays redo in
  reverse undo order, and owns Ctrl+Z/Ctrl+Y at the window capture phase so the
  element's own handler never double-undoes. Text fields keep native undo. Editing
  stays gated: document commands are skipped while `el.mode !== "editor"`, which is what
  lets viewer mode keep undo for view-only changes. Undo/redo are two icon buttons in
  the panel header — they apply to every group, so they must not hide inside a
  collapsible group. The header's `?` button reveals the keyboard map on hover/focus
  instead of printing it inside 文件与导出.
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
  fit distance comes from the bounding sphere and the narrower FOV. The auto-fit
  writes the pose into the document and then re-bases the clean point, so a freshly
  loaded scene is both "未修改" and round-trip faithful — reopen it and the camera is
  where you left it. `near/far` are re-derived by the runtime on every
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
- **The footer is a sync status, not a telemetry dump.** It carried four items —
  修订 / 状态 / 物体 / 相机透视 FOV — and three were dead weight: 修订 and 状态 are the
  same question ("is my work on the server?"), 物体 could never change (the studio had no
  `addObject` / `removeObject` / `reparent` caller), and 相机 透视 · FOV 48° was a **static
  string in the HTML** that a preset click overwrote with a *different* format and never
  refreshed afterwards. It is now two groups: one sync state that has three meaningful
  values (`已保存 rN` — `revision` only moves on load / save / `applyRemote`; `rN · 未保存改动`
  — the dirty flag; `冲突 · 本地 rN / 远端 rM` — the split, pushed by `ConflictController`),
  and one live readout written from `getCameraOrbit()` + `getFieldOfView()` on a rAF tick.
  `updateDirtyUI()` became `updateDocumentState()` because it now owns more than the dirty bit.
  The middle state is trustworthy again in both directions: `dirty` used to be a latch for
  view edits, so undoing an orbit left `未保存改动` on screen forever. It is now a comparison
  against the saved pose (see the `dirty` note in `API.md`), which is what makes the host's
  camera-undo stack able to end at 已保存 instead of at a permanently lit badge.
- **Object-graph edits go through the commands, never the scene.** 复制 / 删除 / 加立方体 /
  改父级 all call `addObject` / `removeObject` / `reparent` with DTOs, so each is one undo
  step and the viewer rebuilds from the document. The id is re-minted (`uniqueId`) rather
  than reused, and `subtreeIds()` blocks a reparent that would make a cycle — the element
  would throw, but a dropdown that offers an impossible option is a worse UI than one that
  does not.
- **A conflict is a decision, not a failure.** `applyRemote()` throws synchronously (a
  structured `SceneEditorError` with `detail = { base, incoming, local }`), which is why
  `simulateRemoteChange()` wraps it in try/catch — `.catch()` sees nothing. The studio
  then has to *do* something with it: 保留本地 writes `max(local, remote) + 1` to the host's
  server copy and `markSaved()`s, 采用远端 calls `applyRemote` with the remote documents and
  resets the camera baseline, 稍后 only hides the bar (the footer keeps saying 冲突 and the
  next save asks again). The element deliberately paints **no error overlay** for
  `code === "conflict"` (the `error` event still fires) — a merge decision must not look
  like a broken document. Both halves are covered by unit tests.
- **model-viewer parity is asset-driven.** The 变体 group stays hidden unless the loaded
  asset declares at least one of the three surfaces, and the counts land in its summary
  (`变体 · 3 套`) — all of them come from data, not from the editor.
  `KHR_materials_variants` is **not** parsed by three's loader, so the SDK reads the glTF
  JSON (`collectMaterialVariants`) in *both* asset loaders; the universal one used here
  dropped it until 2026-11, which is why the shoe's 材质变体 list was empty.
  `setMorphInfluence()` returns `false` when a clip drives that channel, and the panel
  prints 被动画驱动 rather than silently ignoring the drag (the sample is therefore a
  static-morph asset, zero animations). The swap itself is the runtime's job and it
  **repaints on its own** — rendering is on demand, so `setVariant()` ends with a frame
  request; without it the canvas kept the previous variant until the camera moved,
  which looked like "the switch did nothing" on a touchpad and like a wrong model state
  when switching quickly (`e2e/variants.spec.ts` asserts the pixels, not the materials).
  Hotspots are the one piece not in the studio UI —
  they belong to the embed surface, so `embed.html` owns them, and the slot protocol
  requires `data-position` / `data-normal` to be present **before** `refreshSlots()`
  registers the anchor.

## 通风感知 demo（vent-demo.html）与 BIM 资产接入

`vent-demo.html` + `src/vent/main.ts` 用 **@scenio/scene-editor** 逐项对齐参考产品
（某通风感知页面）的**模型层**（仅看模型：无右侧面板、无顶部筛选，左侧楼栋/楼层
选择器精简为「项目/楼栋/楼层/全部建筑」）。数据是**运行环境采样**（73 空间 /
70 设备 / 3 栋楼），与逐层几何一起**不入库**：`public/data/vent/*.json` +
`public/bim/`（见文末「本地数据准备」；缺文件时 demo 渲染提示卡而不是白屏）。

模型三件套与真实页逐项对齐（**两个视图用两套土建数据源**）：

- **土建模型**：
  · 建筑视图 = `07_building_relation` 场景：Shell 外墙壳（opacity 0.1）+ 逐层
    `Board_*` 楼板（白色半透明 0.45，**必须半透明否则上层盖住下层、看不出堆叠**）
    + 逐层楼板 EdgesGeometry 轮廓；俯角 28°、斜距 1300 等轴测取景，逐层线框整体隐藏。
  · 楼层视图 = **Revit 轻量化几何**（`public/bim/revit/{floorId}.json`，来自内部
    3D 对象服务的 `{scene,meshes}` 接口，与参考页的楼层加载器同一批数据），
    按类别合并成整层网格。材质逐项照抄参考页：
    · 楼板 `CFCSFL` = `MeshBasicMaterial('#DFE6EE')`（楼层加载时把楼板材
      质整个换掉并压扁到标高 −0.1ft）。不吃光，屏幕色就是材质色；它比背景
      `#D4DDE5` 略亮，所以整层像一块浮起来的浅板。
    · 墙 `CFCSWL` / 柱 `CFCSCL` / 楼梯 `CFCSSW` = `MeshStandardMaterial({
      color:'#BFBFBF', roughness:0.85, metalness:0, side:DoubleSide,
      flatShading:true })`（参考页的墙面材质 +
      类别色表里 `CF` 专业色 `#D0D7E3`，这里按屏幕目标
      反解成本色 `#BFBFBF`）。fit 视图的墙带是**两段灰**：侧面 `#C0C0C0` +
      顶面 `#D8D8D8`~`#F0F0F0`（双倍率游程实测，3× 放大即白顶 + 深灰边），
      不是一层平灰——早期"墙无白"结论是单倍率游程误读，已推翻（见「楼层光照」）。
      **`flatShading` 不能省**：离线烘焙做了顶点合并 + 平滑法线，侧立面会从亮到暗
      渐变，3× 放大像糊了一圈软边；Revit 原始几何是逐面法线、硬边。
      前几版用 MeshBasic 平涂 + 1px 描边，墙会糊成线。
    · 设备/家具 `ACVTSF`（通风空间体）/ `FFSCMF`/`FFSCAF`（家具）=
      `MeshStandardMaterial({ color:'#EDEDED', roughness:0.6, metalness:0,
      side:DoubleSide, flatShading:true })`。真实页这几类走 advanced-mesh 路径
      保留 FBX 自带材质，屏幕实测是白色块 + 灰描边，`#EDEDED` 即其反解。
      （专业色表里 AC 青 `#82DACE` / FF 粉 `#FA9B96`
      不适用于 advanced mesh，实测为白。）
    · **不要叠 `EdgesGeometry` 描边**：真实页 CF 没有 EdgeMaterial，那圈灰是侧面背光。
    07 场景在楼层视图整组隐藏（`group.visible=false`）。
  · 07 楼层 mesh 名形如 `{前缀}{项目ID}_{楼栋ID}_F6` / `0xiankuang_B3`，
    楼层后缀在末尾，需自定义 `resolveFloorKey`（默认 `floorKeyOf` 只认 `1F`/`B2F`）。
    线框 chunk 在 Scene.json 里 `isMainBuilding=false`，必须
    `mainBuildingsOnly: false`。
- **空间模型**：outline 双几何——建筑=层高×0.6 体块、楼层=**平面**（不是 0.01 挤出，
  见下）。状态色 `#9BD6DE/#C9B79B/#C4C9CF`（建筑 0.7 / 楼层 1，原 `floorMode.alpha:1`），
  薄片抬到标高 +0.8ft（平面视图垂直位移只带来 tan(4°)≈7% 的平面偏移），上方挂
  房间轮廓线（`EdgesGeometry`）。**楼层薄片不能再用 0.01ft 挤出**：楼层相机
  near≈1ft / far≈10⁵ft，深度精度约 0.25ft，3mm 的顶底两层必然自相交出条纹；
  改用 `outlinePlaneGeometry` 单层三角化平面后条纹消失。
- **设备模型**：建筑视图隐藏（原「全楼视角默认不展示设备」）；楼层视图 24×24
  图标图元（开 `#09B3B5` / 关 `#424C59` / 离线 `#8B949E`，7px 圆角 + 轻投影 +
  18px 单色白 SVG），**名称默认不显示、hover 才浮出**——真实页同一位置也只有图标，
  常驻文字会把平面图糊成一片。图标按设备语义选：`GraphModel.icon` 由 `classCode`
  派生，`CFC*` 窗类走格子窗、其余走三叶风扇（快照中 59/70 台是通风风机）；
  `dom-media.ts` 里的 `EQUIP_ICONS` 表可继续加图标名，媒体自己映射 SVG，不改碰撞。
- **图元展示**：`src/vent/graph/` 的默认 DOM Media（设备图标+名称、空间 IoT 值+名称，
  12px `#1B2129` 白描边），锚点 Y=标高+0.1；可整键换成其他框架。
- **碰撞规则**（`collision.ts` + `quadtree.ts`，相机变化即重算，四叉树检索替代 O(n²)）：
  1. 先逆序回滚上一帧聚合链，复位所有图标/文字隐藏标记；
  2. 设备按 weight 降序（异常 100 > 开 2 > 其余 0）：**图标 AABB 重叠 → 高权重吸收
     低权重**，败者图标与文字都隐藏，胜者显示 24×24 `#E8ECF0` 计数角标；
  3. 设备图标 ↔ 设备文字、文字 ↔ 文字重叠 → 隐藏低权重一方的文字；空间只做
     文字/文字（IoT 值 50 > 无值 0）。
- **包围盒 / 相机**：楼层 Box3 **只用 Revit 整层 bbox**（楼板轮廓必然覆盖整层；一旦
  把空间 outline 薄片并进来，个别离群 outline 会把 box 拉偏）→ `floorCameraFromBox`
  照抄 camera-controls 的 `getDistanceToFitBox`：
  `max(w/2/tan(fov/2), w/2/tan(fov/2)/aspect) + depth/2`，再绕 X 转 `π/18`。
  **fov 50 + 10° 俯角 + scale 1.11**（`05_building_classic` 的 `fieldOfView:50`、
  `restoreControls` 的 `scaleCoefficient=1.11` 与 `Math.PI/18` 俯角）。真实页是
  **透视**顶视：10ft 高的墙在屏幕上会露出 `sin(10°)≈1.7ft` 的侧面，平面图的墙才
  有厚度。之前用 fov 14 + 4° 压成"近正交"，墙只剩一条白线，整层糊平。
  建筑视角靠 `BUILDING_CAMERA` 常量（07 `cameraModel` 的方向、镜像 X 后按
  28°/1300 取景）。楼层背景 `#D4DDE5`、建筑背景 `#D6DDE5`
  （`applyCamera(..., background)` 一并提交）。
- **楼层光照**（对齐参考页的灯光切换与方向光计算）：环境光 + 一盏方向
  光，位置固定在楼层中心 `(−100, +200, +50)`、target 指向中心、`shadow.radius 0.5`、
  `bias −1e-4`、阴影相机按楼层对角线收紧、贴图按对角线取 512/1024/2048。
  本 demo 只保留**打光**、**不开阴影贴图**（原因见下）；强度按物理光照反解：
  **`ambient 3.15 / directional 2.6`**（真实页 0.8/1.0 是 `useLegacyLights` 口径，
  数字不能照抄、只能照屏幕色反解）。双倍率游程实测墙带三段色调——fit 视图
  侧面 `#C0C0C0` + 顶面 `#D8D8D8` + 偶发 `#F0F0F0`，3× 放大 = 白顶 `#F0F0F0` +
  深灰边 `#A8A8A8`——反解 `outgoing = albedo·(A + D·NdotL)/π`：
  侧面 `A + 0.1D ≈ 3.4`、顶面 `A + 0.87D ≈ 4.9` → `A ≈ 3.15`、`D ≈ 2.6`。
  （旧值 3.5/0.25 只有平灰、没有顶面提亮，是"墙无白"误判的产物。）
  **踩过的坑（两轮）**：① 拿 `cmp-floor-f6.png` 的直方图当目标，看到 16% 的
  `#FCFCFC` 就认定"墙被过曝成白"，把方向光一路加到 14 —— 结果墙烧成纯白粗块。
  那 16% 其实是右侧白色面板，属于量错区域。② 改用单倍率游程后又走向另一个极端，
  断言"墙根本没有白"——实际是 fit 倍率下顶面 `#D8D8D8` 与侧面 `#C0C0C0` 量化后
  太接近。**正确做法是同图双倍率（fit + 3×）游程取色交叉验证**
  （`test-results/profile2.cjs`），而不是整块直方图或单倍率游程。
- **左侧选择器**：只列**有空间数据的楼层**（`SPACE_VMS` 的 floorId 集合过滤），
  显示为「项目 / 商业 / F7 F6 F4 F3 B1 B2 B3 / 金街 F5 / 全部建筑」；底部不显示
  调试状态行。

**BIM 自定义资产（Scene.json + FBX）：`src/vent/bim/` 只做结构，不做视觉。**
它曾以 `@scenio/scene-editor/bim` 的形式发布，0.7.0 起搬进本 app——消费者只有这一个，
放进 SDK 只会把一个产品格式变成全包的依赖。入口导出纯结构装载器与纯几何工具，
一切样式/单位/相机策略由消费者（本 demo）设定：

- `loadBimScene({ baseUrl, sceneName, resolveMaterial?, onMesh?, resolveFloorKey? })`
  拉 `Scene.json`/`Materials.json`/`Models/*.fbx`（标准 Kaydara 二进制，`FBXLoader`
  直读），返回 `group / meshByName / meshInfo / materials(原始 guid→Content) /
  setFloorsVisible / dispose`。**不创建任何材质**：`resolveMaterial` 返回材质才赋，
  返回空则保留 FBX 自带；`onMesh` 供消费者打标/叠加。每 chunk 独立 FBXLoader
  （并发 parse 共享实例会丢 mesh）、挂载用快照数组（`group.add` 迭代实时 children
  会隔一跳一）。本 demo 只调一次（07 场景，两个视图共用）。
- `loadRevitFloor({ baseUrl, floorId, categories?, resolveMaterial?, onMesh? })`
  读 `{floorId}.json`（每类别一段已烘焙世界坐标的 `Float32/Uint16` buffer，base64
  存放），一个类别 = 一个 `Mesh`（transform / 单位 / Y-up 已在离线提取时烘焙，
  运行时零装配）。返回 `group / byCategory / categories / bbox / dispose`，
  **不创建材质**。
- `parseOutline` / `outlineToShapes({scale})` / `extrudedOutlineGeometry({depth, scale,
  rotateToYUp})` / `outlinePlaneGeometry({scale, rotateToYUp})` / `outlinePlanCentroid`
  —— 单位无关（scale 由消费者给），不产材质、不设标高；`parseBimLocation` 只解析
  `"x,y,z"` 三元组。
- 消费者侧持有：毫米 Revit→英尺 Y-up 映射（MM2FOOT）、层高×0.6 挤出系数、材质
  策略、颜色板、图元层（`src/vent/graph/`，见下）、包围盒取景、相机。模型与真实
  outline/bimLocation **完全对齐**（diag-bim-align 验证）。

**相机坑（SDK 行为，宿主必读）**：`setCameraTarget` 与 `setCameraOrbit` 都走
`smoothViewTo` 渐近缓动，同一 tick 连调会互相覆盖（后者从尚未落地的旧 target 推导
位置，把前者的 target 目标冲掉）。需要精确取景时用 `el.setViewState({ camera })`
一次原子提交 position+target——demo 的 `applyCamera()` 即此用法（`setViewState`
要求完整 ViewState：先 `getViewState()` 再打补丁）。

**初始化坑**：`scene-ready` 事件可能在宿主模块执行前就派发完毕，等待运行时必须走
`await el.ready` promise，不能只监听事件（否则初始化静默不跑、后续 `setViewState`
抛 "No document loaded"）。

渲染性能：每个空间两层几何（体块 + 平面）各持独立材质，逐帧逐个 `setMaterial` 会
打爆 on-demand 渲染——`instancing="false"` + 直改材质 + 每帧一次 `runtime.render()`。
`selectSpace/selectEquip` 改完材质必须立即 `runtime.render()`，否则 on-demand 渲染要
等到下一次相机交互才变色（表现为"选中反应很慢"）。

**交互与加载态约定**：

- 加载期 `body:not(.ready)` 隐藏 `#stage`（runtime 默认 view 带 `GridHelper`）、
  `#nav`、`#legend`，`#onReady()` 构建完场景后才加 `.ready`——不再出现
  空白色面板与底部网格闪帧。文档里的 `gridVisible:false` 负责就绪后的常态。
- 切楼层用自增 `#switchToken` + `#floor-loading` 遮罩：新楼层几何未就绪前**保持旧
  视图不动**，就绪后一次性提交显隐/取景/打光/图元。旧实现先隐藏 07 白模再用空间
  包围盒取景、Revit 到达后换成真模型，中间会露出一帧空场景。
- 选中：3D 空间走 `mousemove` raycast（rAF 节流）给出 pointer 小手；空间图元与设备
  图标也可直接点选。选中后右侧抽屉展示快照现成字段（空间：功能/温度/CO₂/阈值/
  关联设备；设备：分类/运行状态/采集时间），空白处点击、Esc 或关闭按钮收起。
- 楼层只关注**上方平面图**：`min/max-camera-orbit="auto 0deg/80deg auto"` 把极角
  锁在水平线以上（初始 10° 俯角，最多倾斜到 80°，仍高于楼板底面），楼板与空间
  薄片保持单面材质——交互上到不了楼层底部。`min/max` 必须**同时**给出：
  `readOrbitLimits()` 对每根轴都要 low + high 才写入限制，缺一侧整轴跳过。
- 顶部不设任何提示条或返回按钮；返回入口只有左侧「全部建筑」一处。
- 左侧选择器只列空间数 ≥ 10 的楼层（本快照即 B1/B2/B3；F6 只有 6 个、其余 1~2 个），
  面板 `max-height` 收内容而非铺满全高。真实快照只有「运行/停止」两种设备状态，
  `injectDemoFaults()` 在内存 view model 里按楼层位置确定性地给每层标两台 `fault`：
  **不改图标底色**（仍按运行态青/深灰），只在**独立设备**图标右上角叠 8px 红点
  （与图例「异常」同色），抽屉里单列「告警状态：异常 · 演示」。一旦被聚合，成员
  红点全部收起；若组内有异常，改在**计数角标**右上角显示同色红点（只表示「这组有
  告警」，不暗示是哪台）。不改动不入库的快照 JSON。
- 聚合角标**不替用户猜代表设备**：点击展开 `#group-popover`，列出组内设备
  （名称 / 运行态 / 异常标记），点某一行才打开该设备详情；空白处点击、Esc、切层
  收起。这样聚合后仍有明确路径拿到每一台设备，且不会把告警误绑到代表设备。
- 层级：`#labels(5) < #nav/#legend(10) < #floor-loading(20) < #detail-drawer(30)`。
  `GraphScene` 把 `#labels` 追加到 `body` 末尾，没有 z-index 时会盖住
  DOM 顺序在它之前的 `#legend`——图元文字就冒到图例上方了。

**图元层模块化（`src/vent/graph/`）**：四个机制与 three / DOM 框架解耦，可单独使用。

| 模块 | 职责 |
|---|---|
| `quadtree.ts` | `maxObjects=30 / maxLevels=10` 四叉树 AABB 检索；跨象限条目留父节点，`retrieve` 只返回相交项，替代 O(n²) 全量循环 |
| `state-styles.ts` | `setStateStyles(config)` 整表替换 + `caclCurrentStyle(states)` 按 priority 合并；样式键语义化（`iconColor` / `dotColor` …），换色不动 DOM |
| `aggregation-chain.ts` | `absorb / undo / clear` 记录每次吸收前的父节点；每帧先逆序回滚再重算，被吸收者转移时从旧根摘下，不串环 |
| `media.ts` | `registerMedia(name, factory)` 同键覆盖；`frameworkMedia(adapter)` 用 `mount/update/unmount` 桥接任意框架；`getBounds()` 可上报自定义组件真实 AABB |

`graph-scene.ts` 只负责投影回调 → 矩形测量 → 四叉树碰撞 → 样式合并 → Media 更新；
`dom-media.ts` 是默认实现（保持原视觉）。换成 Vue / React / Solid / Web Component
只需注册 Media，碰撞 / 样式 / 聚合一行不改：

```ts
const adapter: FrameworkAdapter = {
  mount(el, model) { /* createVNode+render / createRoot / render / customElement */ },
  update(el, model) { /* 把 model.currentStyle 推给组件 props */ },
  unmount(el) { /* app.unmount() / root.unmount() */ },
};
graph.registerMedia("equip", frameworkMedia(adapter));
```

> **测试缺口**：`graph/` 是纯逻辑（聚合链、四叉树碰撞、样式合并），但目前**没有单测**——
> 它随本轮目录整理一起入库时就没有带上，验证只靠 `vent-demo.html` 肉眼比对。
> 按 `AGENTS.md` 的「性能敏感模块先有特征测试」，这块要补。

**Revit 楼层几何提取**（离线脚本在内部环境执行，**不随仓库分发**——脚本本身含
内网地址；思路如下，可在任何有数据权限的环境复现）：

1. 在参考页上下文里 `fetch` 楼层对象接口（浏览器内同源，绕开命令行代理与安全策略）：
   场景描述 + 压缩网格两段；
2. `LZ4 block` 解压 → 二进制网格解析：`[string meshUrl][int32 sublen][webMesh]`
   （顶点格式 byte/float/ushort × 3 + 三角索引 int/ushort/byte + LOD steps）；
3. 解析场景里的 `MeshRefs`（`SourceId / MeshUrl / 3×4 row-major Matrix`）；
4. 逐实例烘焙：顶点 ×MM2FOOT → ×Matrix（position 再 ×MM2FOOT）→ 绕 X −90°（Z-up→Y-up），
   按类别合并成一个 buffer，写 `public/bim/revit/{floorId}.json`（9 层共 14MB）。
   支持增量提取：`--cats=A,B` 只抓指定类别、`--merge` 合并进已有 JSON（保留既有
   类别、bbox 取并集）——设备/家具三类（ACVTSF/FFSCMF/FFSCAF）即用此路径后补。

已覆盖商业 F7/F6/F5/F4/F3/B1/B2/B3 + 金街 F5。`05_building_classic` 只覆盖 1F–5F
单一楼栋，已弃用。

**本地数据准备**（数据与几何**不入库**，`.gitignore` 已排除这两个目录）：

| 路径 | 内容 |
|---|---|
| `public/data/vent/vent-real-data.json` | 楼栋/楼层树、空间、设备、动态值快照 |
| `public/data/vent/vent-model-view-fields.json` | 每个对象的 `bimLocation` 与 `outline` |
| `public/bim/revit/{floorId}.json` | 9 层轻量化几何（类别 → base64 buffer + bbox） |
| `public/bim/07_building_relation/` | 建筑白模 `Scene.json` / `Materials.json` / `Models/*.fbx` |

`src/vent/main.ts` 启动时 `fetch` 前两项、按 `buildingTree` 组织左侧选择器；任一文件
缺失会在页面中央渲染「未找到本地数据快照」提示卡（列出期望路径），既不会白屏，
也不影响其它三个页面的构建与运行。

**阴影为什么没做**：楼层模式里唯一收得到阴影的是墙自己（楼板被换成了
`MeshBasicMaterial`，不吃光也不收阴影——真实页同样如此），而 512/1024/2048 的贴图
摊到 F4（415×851ft）/B2（999×1015ft）上每 texel ≈0.5ft，与墙厚同量级，墙顶只占
几个 texel，`receiveShadow` 必然整面自阴影 → 整层发灰。真实页那条"灰影"其实也
不是投影，是**墙的背光侧面**（见上「楼层光照」）。`#applyFloorLighting` 里保留
完整 shadow camera 参数，接 CSM 后把 `renderer.shadowMap.enabled` 打开即可。

**遗留**：

1. **阴影没做**。参考页给楼层加一束方向光 + castShadow，
   但楼层里没有能接影的物体（楼板是 `MeshBasic`），墙自阴影只会把整层压灰。
   真要做对得上 "CSM / 视锥内动态阴影相机"，收益不值；真实页本身也没有可见
   投影，立体感全靠墙带自身的灰度。
2. 线宽受 WebGL 限制恒 1px（真实页 1.5–2px），fit 倍率下差异不明显，暂不引入
   fat lines。参考页的楼板贴图经源码确认**不生效**
   （楼层加载时把楼板材质整个换成 `MeshBasic`，贴图根本没机会上），
   无需复刻。
3. 9 层几何 JSON 共 14MB（含设备/家具三类；单层最大约 2.7MB），按需加载但切层
   不回收。**曾经记作「全部逛一遍常驻约 400MB」，实测证伪**：base64 解码后
   position + index + normal 合计 **15.4MB / 47 万顶点**，全量常驻也不到 16MB，
   所以 LRU 与 Int16 量化（最多省 12MB）都不做。真要动之前先量
   `renderer.info.memory` 与 heap；`revit-floor-loader` 的 `dispose()` 只释放自建
   几何（材质由调用方传入、模块级共享），逐层释放本身是安全的。

已关闭（2026-11）：**构件密度**——`ACVTSF/FFSCMF/FFSCAF` 三类已增量提取并合入
9 层 JSON，demo 侧以 `#EDEDED` 设备/家具材质渲染，白块密度与真实页对拍一致。


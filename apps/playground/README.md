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
what keeps 5 000 placeholders at ~11 MB of heap instead of ~26 MB), and
`vent-demo.html` (`src/vent-demo.ts` — 通风感知**纯模型视图**，对齐参考产品的
模型层：07 单场景承担双视图（建筑=半透明白色楼板堆叠等轴测 / 楼层=近正交顶视
平面图）+ 空间双几何 + 房间轮廓线 + 设备图标图元 + AABB 碰撞聚合 + 包围盒取景，
无面板/无筛选；**数据与 BIM 几何不入库**（`public/data/vent/`、`public/bim/`，
本地采样，缺文件时页面显示准备提示），SDK `./bim` 入口只做结构、样式全由 demo 侧
钩子设定，见文末「通风感知 demo」一节).

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

`vite.config.ts` has four HTML entries (`index.html`, `perf.html`,
`minimal.html`, `vent-demo.html`). SDK-level coverage lives in `packages/scene-editor/test/`;
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

## 通风感知 demo（vent-demo.html）与 BIM 资产接入

`vent-demo.html` + `src/vent-demo.ts` 用 **@scenio/scene-editor** 逐项对齐参考产品
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
  图标图元（开 `#09B3B5` / 关 `#424C59` / 离线 `#8B949E`，白边圆角 + 14px 白 SVG），
  **名称默认不显示、hover 才浮出**——真实页同一位置也只有图标，常驻文字会把平面图
  糊成一片。图标样式按参考页的设备图标组件逐项还原。
- **图元展示**（CSS2D DOM）：设备图标+名称、空间 IoT 值+名称（参考页空间信息
  组件规格，12px `#1B2129` 白描边），锚点 Y=标高+0.1。
- **碰撞**（复用参考页的碰撞检测 + 聚合算法）：
  AABB 重叠 → 设备图标相撞**聚合为计数角标**（`group-wrap` 24×24 `#E8ECF0`）、
  文字相撞按状态权重隐藏（异常>控反>IoT>普通）；相机变化即重算。
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

**BIM 自定义资产（Scene.json + FBX）：`@scenio/scene-editor/bim` 只做结构，不做视觉。**
入口导出纯结构装载器与纯几何工具，一切样式/单位/相机策略由消费者（本 demo）设定：

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
  策略、颜色板、图元 DOM、碰撞、包围盒取景、相机。模型与真实 outline/bimLocation
  **完全对齐**（diag-bim-align 验证）。

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

`vent-demo.ts` 启动时 `fetch` 前两项、按 `buildingTree` 组织左侧选择器；任一文件
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
   不回收——全部逛一遍常驻内存约 400MB，后续可加 LRU 或把 position 量化成
   Int16（体积减半）。

已关闭（2026-11）：**构件密度**——`ACVTSF/FFSCMF/FFSCAF` 三类已增量提取并合入
9 层 JSON，demo 侧以 `#EDEDED` 设备/家具材质渲染，白块密度与真实页对拍一致。


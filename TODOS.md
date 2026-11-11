# TODOS

仓库内 `0.7.0` alpha；npm `latest` 为 `0.6.0`。架构与基准见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 一、已完成（`0.7.0`）

- **Playground 首页「先查看、再编辑」**：首页虽然走 `loadDocument()`（SDK 默认推导 editor），但 `main.ts` 在元素升级前把 `mode` 钉成 `viewer`，首个 runtime 直接以 `interactive: false` 创建；顶栏新增 查看 / 编辑 分段开关（`src/ui/mode-switch.ts` + `src/styles/mode.css`），写入 `el.mode` 与 `body[data-studio-mode]`。查看态隐藏控制面板 / 状态栏 / 保存 / 恢复面板按钮，画布铺满；宿主侧 `G`/`R`/`S`、Ctrl+Z/Y 与 `save-request` 同步门禁，切回 viewer 由 SDK 清空选择，全程不写文档。`?mode=editor` 供 e2e / 视觉夹具显式进编辑态；回到首页复位为 viewer。`e2e/viewer-mode.spec.ts` 新增「默认 viewer → 切 editor → 切回清选择且不弄脏」用例，其余需要编辑态的夹具 URL 统一补 `mode=editor`。
- **demos 精简：25 个用例已迁到 `minimal.html?demo=`**：首页覆盖工作室 UI 面，宿主契约面（headless facade、多选命令、迁移/校验、`assetResolver` 信任边界、声明式属性与 hotspot 等约 60 个 SDK 标识符）由 7 个独立 `/demos/*.html` 页面承载。现把它们降级为 `src/scenarios/markup/*.html` 的 `?raw` 片段，`src/scenarios/router.ts` 按 `?demo=<name>` 注入 DOM 后动态 import 原场景模块；`window.__demo` / `__docDemo` / `__coverage` / `__assets` / `__viewerDemo` 与 `body.dataset.demo` / `dataset.coverage` 就绪标志原样保留，`sdk-coverage.spec.ts`(10) + `demos-adversarial.spec.ts`(15) 共 25 个用例只改 URL、零断言丢失。`apps/playground/demos/` 与 7 个构建入口已删除，HTML 入口从 10 个降到 3 个；每个场景 SDK 代码独立按需 chunk，默认 `minimal.html` 走同步路径不受影响。CI 只跑 `critical-flows.spec.ts`，这 25 个用例必须保持可达。
- **查看器/编辑器分离**：新增 `mode="viewer|editor"`（缺省按 `src` / 宿主文档推导，生效值镜像到 `data-mode`）。
  viewer 不加载 TransformControls（`ThreeRuntime` 新增 `interactive` 选项 / `setInteractive()`），点选与
  `G`/`R`/`S`、撤销快捷键全部只在 editor 生效，切到 viewer 时清空选择。实测同一页：编辑器场景 8 个 scene 子节点
  （含 gizmo），viewer 5 个、点击不产生选择。
- **动态 `src` 静默退化**（原 P0）：`#createSrcResolver()` 改为常驻，URL 在每次 resolve 时读取；`object-store`
  遇到「有 `assetId` 但无 `AssetCache`」直接抛 `asset-not-found`，不再退化成 1×1×1 占位盒。实测 `ready` 后设
  `src` 拿到 25×79×155、3 个 clip、无 error。
- **裁剪面固定 0.1/1000**：每帧按相机距离与内容半径重算（`near = max(d·5e-4, r·1e-4)`、
  `far = max(d·50, r·50)`），滚轮缩放（距离变化）也跟随。实测 1× 与 1e6× 模型：near 7.4e-4 → 736、
  far 73.6 → 7.36e7。
- **失败态无视觉出口**：新增 `slot="error"`；没有该 slot 时元素自绘提示（`[data-scene-editor-error]`，含
  `role="status"`），`render-init-failed` / 资产失败都走这里，下一次成功加载清除。
- **`load` 早于取景**：`src` 路径把 `load` 压到 `frameViewer()` 与显示态重放之后派发；实测在 `load` 回调里
  `getDimensions()` 已是取景后数值。压制用的是计数而非布尔，连续两次切换 `src` 只会在最后一次取景后释放一个
  `load`（携带最终 `url`）。
- **进度粒度**：无 `Content-Length` 时用 `loaded/(loaded+1MB)` 渐近曲线，进度条不再全程贴 0。有长度时仍是字节比。
- **`prefers-reduced-motion`**：自动旋转降级为静态，`smoothViewTo()` 直接落位。
- **解码器开箱不可用**（原 P2）：新增 `decoder-path` / `decoder-cdn`，一个 base URL 按 three 自己的
  payload 布局（`draco/gltf` + `basis`）懒装配 Draco / KTX2 / Meshopt。`decoder-cdn` 指向钉死 three 版本的
  jsDelivr；宿主赋值 `el.dracoLoader` 等仍然优先。`lazy-decoders.ts` 的 `ready()` 幂等、单个模块失败只丢那一
  种解码器；KTX2 需要真实 renderer（`RuntimeContract.renderer`，`detectSupport` 要探设备）否则跳过而不猜。
  配套新增 `decoderHint()`：把 three 的 `No DRACOLoader instance provided` 翻成元素错误态里可执行的提示。
  实测：`tri-draco.glb` 无属性 → 报错并提示；`decoder-path="/decoders/"` → 加载成功、只拉本地 wasm；
  `decoder-cdn` → 走 jsDelivr 成功。
- **每对象一次 draw call**（原 P2）：新增 `src/three/viewer/instancing-rig.ts`，同几何（`geometry.parameters`
  指纹）+ 同材质（逐字段指纹，含 `defines`）的网格自动合成一个 `InstancedMesh`。对象模型不变：每个文档对象仍是
  自己的 `Object3D`（位姿、材质、拾取、导出、撤销都不动），只是代理被移到专用 layer（`BATCH_PROXY_LAYER = 1`），
  主相机不画、`Raycaster` 显式 `enableAll()` 后仍能命中（`picker.ts` 已开）。选中 / 有材质覆盖 / 资产实例一律
  踢出批次，各自保留独立 draw call。实测 5k 对象：**1 881 → 2 次 draw call**、p95 28.1 → 17.1 ms（vsync 到顶）、
  装载 571 → 300 ms、上传几何 1 881 → 2；1k 对象 1 001 → 2。`perf.html?instancing=0` 可同页对照，
  `e2e/instancing-perf.spec.ts` 把「≤20 次 vs >900 次」钉成门禁。
  过程中修掉两处自伤：①每次 `admit` 都重算包围球是 O(n²)（5k 对象多花 900 ms），改成置 `null` 让 three 每帧惰性重算；
  ②`swap-remove` 先覆盖后 `splice` 会把「被移除的代理」认错，导致该恢复的图层没恢复（有单测钉住）；
  ③`markDirty` 起初只对「本身在批次里」的对象生效，于是拖动一个 group 时它的合批子对象不跟手——现在按子树刷新。
- **逐实例视锥剔除**（原 P3 第一条）：合批不再「一组一个包围球」。每组切成 ≤256 实例的
  `InstancedMesh`，成员按**世界坐标网格单元**排序后填块（每块 ≈ 一个单元），three 的 per-mesh
  剔除因此重新生效。实测 5k：全览 13 次 draw call / 36 864 三角形，近景（贴着网格角、15° 视角）
  7 次 / 18 432，对比关闭合批的 1 881 次 / 22 560 与 369 次 / 4 416；1k 只有 4 个 chunk，近景仍全中，
  说明收益随场景规模增长。
  弯路记一次：第一版按**文档顺序**切块，结果 1k 场景近景三角形一点没降（12 000 不变）——每块都是横跨
  整场的「条带」，4 个包围球全部与视锥相交。分块必须按位置，否则不但不剔除，还白付 draw call。
  排序延到 `sync()`（每次增减一次，不是每个对象一次），拖动实例不重排（包围球跟着变大，不会错剔）。
  门禁换成 5k + 近景三角形 ≤ 全场 40%（`e2e/instancing-perf.spec.ts`），`perf.html` 末尾新增近景一帧。
- **`instancing` 属性**（原「元素没暴露、宿主关不掉」）：`instancing="false"` / `0` / `off` / `no`
  关掉合批，缺省为「开」（裸属性不会反过来关）；`ObjectStore.setBatcher()` + `ThreeRuntime.setInstancing()`
  支持运行时来回切，不重载文档、不动 `mode`。
- **`perf.spec.ts` 首帧门禁不再 flake**：实测同一份代码 0.7–2.5 s（SwiftShader 冷启抖动），2 s 门禁卡的是
  抖动。改为 3 s，设计目标仍记在架构文档里；`PERF_FIRST_MS` 可覆盖。
- **SDK 接入样板收敛（A1–A3）**：宿主不该手写的四类「只有一种正确写法、写错不报错」的代码收进包。
  ①`createSceneDocument` / `createDocumentFromAsset` / `createEmptyDocument`（`core/document/create.ts`）：六字段信封 + `ViewPatch`
  合并 + 对象深拷贝，playground 里 4 处手写字面量全删；②`createFileBundleUrl(files)`（`assets/file-bundle.ts`）：`.gltf` 包
  的 `buffers[].uri` / `images[].uri` 重写成 `blob:`，返回 `{ url, dispose, format }`，配套 `el.loadFiles(files)`——
  复用 `src` 的进度 / 取景 / 错误态，资产 id 用「上传序号 + 文件名」铸币避免缓存串味，宿主 `assetResolver` 仍优先（元素内部
  id 自己解析）；③`el.exportDocument({ format: "glb"|"gltf"|"obj" })`：**按文档位姿**导出（预览态的分解偏移 / 材质预览
  不会泄漏进文件，live 路径仍走 `exportScene`）；OBJ 走动态 import 独立 chunk；④`downloadBlob()` + `el.toBlob()`。
  过程中修掉一个真 bug：格式判定 `url.split(".").pop()` 对 `blob:http://…/uuid` 会得到 `1:4173/uuid`，上传被报成
  `asset-unsupported-format`——新增 `assets/format.ts` 的 `assetFormatHint()`（先 URL 后 asset id，只认
  `/^[a-z0-9]{1,8}$/` 的扩展名片段）。元素入口 +1.9 kB、three 入口 +1.6 kB（gzip 合计 +1.1 kB）。
- **B 档纯减法（playground 里「包已有、宿主没跟上」的重复实现，净删 153 行）**：①裁剪面同步——
  `camera-controller.ts` 的 `startClipSync`/`syncClipPlanes` 常驻 rAF 与 runtime 的 `#render() → #applyClipPlanes()`
  是两套真相（拖一次相机裁剪面算两遍），删；②手写转台——`toggleTurntable` 的 rAF 旋转换成
  `runtime.setAutoRotate({ enabled, degreesPerSecond: 26 })`（SDK 转台是 rig 级、展示性的：不打脏文档、
  拖拽自动暂停、尊重 reduced-motion；旧实现停转时还会把相机写进文档）；③绕开契约的色调映射——
  `#applyRenderSettings` 直接改 `renderer.toneMapping` 并全场景 `needsUpdate`，换成
  `runtime.setToneMapping` / `setExposure`；④手写飞行缓动——`flyTo` 的 rAF lerp/cubic ease 换成
  `runtime.smoothViewTo()`（衰减、reduced-motion、拖拽中断归 SDK 管），提交延到衰减渐近线之后（~2.5×decay），
  因为 `getViewState()` 读的是活相机而不是目标位姿。
- **SDK 接入样板收敛（A4–A7）**：视口覆盖层与预设数据收进包，playground 净删 ~270 行（`display-modes.ts`
  130、`explode-controller.ts` 140 全删，`presets.ts` 数据表删 30 行）。
  ①`display-mode="studio|xray|wireframe|normal|clay"` 属性 + `runtime.setDisplayMode()` + `createDisplayRig`：
  一次应用共享**一份**覆盖材质（旧实现每 mesh 一份），且必须同时改 `InstancedMesh` 批次——只改代理 mesh 的材质对
  合批对象无效（这正是宿主几乎必踩的坑）；`"studio"` 精确还原原始材质，`addObject` / `setInstancing` 后自动补覆盖；
  ②`explode="0..1"` 属性 + `runtime.setExplode()` + `createExplodeRig`：基线读**文档**位置（每次调用重读，gizmo
  拖动后基准不漂），写入走 `applyTransform`（带 `markDirty`，实例矩阵跟着刷新），文档装载重置为 0、属性 re-assert；
  ③（A6）确认 three r186 的程序缓存键已含 `toneMapping`（`WebGLPrograms.js:366/490`）——宿主侧全场景
  `needsUpdate` 遍历是纯浪费，B 档删除即正确；④（A7）`LIGHTING_PRESETS` 四套参考布光按 `view.lights` 形状从
  core 导出，应用路径仍是宿主 `setViewState`。
  过程中修掉一个自伤：元素装载后 re-assert `explode` 属性触发 `setExplode(0)`，rig 里 `0→0` 没有短路，直接走了
  O(objects×bounds) 的基线全量重建，perf 页首帧 2.4 s → 4.4 s（复现两次）；现在 `next === factor` 无条件返回。
- **顺带修掉两个真 bug**：①`error` 覆盖层的 `textContent` 写入会触发 slot 观察者的 childList 回调 →
  `#collectSlots` → `#applyErrorVisibility` 的微任务死循环（只剩一个失败态挂着时必现），现在观察者忽略
  自身覆盖层的变更，写文本也先比对；②`src` 预览资产失败后仍会派发 `load` 并把 `loaded` 置真、顺带清掉
  错误提示，现在单资产失败不再宣布 `load`（宿主文档保留「部分成功」语义）。

## 二、查看器剩余（原待补清单，本轮清空）

> P2「每对象一次 draw call」、P3「逐实例视锥剔除 / 代理资源共享 / 资产内部合批 / 多 clip 混播 / 拾取 BVH」
> 都已在本轮完成，逐条见上。

### 已完成（本轮新增）

- **代理资源共享**：新增 `src/three/viewer/shared-resources.ts`——按**内容签名**（`primitiveSignature`，默认值在
  这里显式解析，所以 `{kind:"box"}` 与写全字段的 box 是同一个 key）建池，引用计数释放；`createPrimitiveObject` /
  `createPlaceholderObject` 都从池里取几何与基础材质，`dispose()` 变成「释放一个引用」。`ObjectStore.resources()` /
  `ThreeRuntime.resourceStats` 暴露 `{geometries, materials, references}`，`ThreeRuntime` 新增 `resources` 选项
  （多运行时共享一份池，由宿主负责销毁）。实测 5 000 个盒子：**26.5 MB → 11.0 MB** JS 堆；`perf.html` 的 1 000 盒子
  场景现在断言 `geometries === 1`。
- **资产内部合批**：新增 `src/three/viewer/asset-merge.ts`——把同一个资产实例里**共享同一材质**的叶子 mesh 的位姿
  烘进顶点、`mergeGeometries` 拼成一个网格。触发条件收在资产层：无 `animations`、无 `KHR_materials_variants`；
  逐 mesh 排除蒙皮、morph、带子节点、半透明/多材质。200 个同材质盒子 → 1 个 mesh，约 25 ms；`restore()` 在
  `remove()` 时把原节点放回并释放合并 buffer（源 buffer 属于资产缓存，不碰）。拾取不受影响：资产子节点本来就都标着
  文档对象 id。
- **多 clip 混播**：`AnimationRig.playBlend(objectId, layers)` + `blend` 读回，权重按调用内归一化（`[1,1]` = 50/50），
  每层可带 `timeScale`；`pause` / `resume` / `setTime` / `activeTrackNames` 都覆盖整组层，transport 事件与 `time`
  跟随权重最大的那层。单层等价于 `play()`。运行时 `playAnimationBlend()` / `animationBlend`，契约里是可选成员。
- **拾取 BVH**：新增依赖 `three-mesh-bvh`（^0.9.18）。`createPicker` 对 >2 000 三角形的网格把**该 mesh 的**
  `raycast` 换成 `acceleratedRaycast`（不 patch `THREE.Mesh.prototype`），树按几何缓存并引用计数（资产实例共享
  buffer，树也共享；`dispose()` 不会拆掉别的 picker 的树）。BVH 是**动态 import**，且只在内容里真的存在重网格才发
  请求；`raycaster.firstHitOnly` 让每个网格一命中即停。实测 130 560 三角形：**12.0 ms → 0.10 ms**/次，建树约
  63 ms；`Picker.ready()` 可提前建好。蒙皮 / morph / InstancedMesh 不参与。
- **更细的剔除**：仍未做。现在是块级（256 实例一个包围球）。再往下要么把块切小（用 draw call 换），要么上 GPU 侧
  剔除（`BatchedMesh`，要 4.8+ 的 `three` 与另一套对象模型），两者都不便宜。

### P3 — 进度条的解析阶段

网络字节曲线已经可用，但解析（GLB → 场景图）仍是「最后一跳」。要更平滑只能上报假进度或分帧解析，收益不抵复杂度，暂不做。

### 不做

- **AR / XR**：`ar` / `ar-modes` / `quick-look` / `xr-environment` 明确不做。
- **`interaction-prompt`**：已移除且不打算恢复——查看器只画 canvas，装饰件归宿主。

## 三、与 model-viewer 的对照

对照场景 `minimal.html?demo=compare`（模板片段 `apps/playground/src/scenarios/markup/compare.html`；同一 GLB、同一动画时间、同一视口；指标：平均/p95 亮度、包围盒像素尺寸、相机距离；左侧仍需外网 CDN）。

已对齐：色调映射默认值（预览 `neutral`）、`neutral` 环境预设、接触阴影算法、取景（`updateFraming()`）、`shadow-intensity` / `shadow-softness` 语义，以及「viewer 无编辑交互」这一条本身（model-viewer 也没有 gizmo 与点选）。

残留差距（均为取样/版本问题，非算法差异）：

1. 两栏各自从加载完成起播，动画相位漂移 → 接触阴影形状不同。逐帧对比需共享时钟与 clip 相位。
2. three r183（model-viewer 内）与 r186 的预滤波/色调映射实现不同 → 环境照明整幅平均亮度残留约 5%。

## 四、编辑能力缺口

已具备（schema v3）：真实 `parentId` 层级（group 会被挂载，父失败子提升为根，成环断开）、`type:"primitive"` 八种程序化几何、对象级 `material` 覆盖（按实例 clone）、`view.lights.additional` 四种附加灯；`addObject` / `removeObject` / `reparent` / `setMaterial` 全部可撤销，并复用加载时的 `validateHierarchy`。

仍未排期：

- 对象复制 / 克隆命令。
- 多对象批量变换命令。
- 把「默认相机 / morph 预设」持久化进文档（当前只在元素属性层，`view` schema 不需要改动就不该动）。

## 五、明确不做（YAGNI）

- **CRDT / 实时多人协作**：首发面向单用户。并发编辑走既有路径（保存校验 `revision` → 结构化冲突 → 宿主决定 UX）。接入点在序列化与命令历史层，`SceneDocument` 已是纯数据模型，不预留代码。
- **插件面板槽位**：`install(context)` 已交付（命令、事件、选择器、disposer），槽位是没有真实需求时的猜测性 API。
- **按产品拆包**：出现真实复用需求前，保持单包四入口。

## 六、发布清单

- npm scope `@scenio` 为占位，首次发布前选定。
- 发布会带 schema v3（文档格式 minor 变更）。
- 发布前必跑：`pnpm test` → `pnpm typecheck` → `pnpm build` → `pnpm test:release` → `pnpm test:pack`。

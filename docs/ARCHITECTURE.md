# 技术架构、亮点与基准

本文是 scene-studio 的技术总览：架构分层、关键设计取舍、可验证的亮点，以及实测基准数据。
面向接手人，读完应能回答三件事：**代码怎么分层、为什么这么分、当前性能水位在哪里。**

---

## 1. 定位

一个仓库、一套文档模型，两种产品形态：

| 形态 | 入口 | 用途 |
|---|---|---|
| **查看器**（viewer） | `<scene-editor src="model.glb">` | 只要把模型画对、能转能看；属性驱动，不碰文档 |
| **编辑器**（editor） | `<scene-editor>` + `loadDocument()` / `createSceneEditor()` | 文档可编辑：选择、gizmo、增删改、撤销/重做、宿主保存 |
| **Headless** | `createSceneEditor({ runtime })` | 零 DOM：状态机 + 命令历史 + 类型化事件，自带 UI |

查看器不是另一条代码路径，而是**同一套编辑链路喂一份合成的单对象文档**（`createSrcDocument()`），
所以预览态可以无缝升级成编辑态，不需要第二套加载/取景/选择逻辑。

---

## 2. 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 宿主（apps/playground、你的页面）                              │
│   ViewerStore ─→ ViewerController.update*()   自己拥有 UI/传输  │
└───────────────┬──────────────────────────────┬───────────────┘
                │ DOM 事件 / 属性               │ 命令 / 事件
┌───────────────▼──────────────┐  ┌────────────▼───────────────┐
│ element   <scene-editor>     │  │ core  createSceneEditor()   │
│ 属性、slot、生命周期、a11y     │  │ 文档 + 历史 + 选择 + 插件    │
│ 冲突/保存的 DOM 投影           │  │ 纯逻辑，零 DOM、零 three     │
└───────────────┬──────────────┘  └────────────┬───────────────┘
                └──────────┬───────────────────┘
                           │ RuntimeContract（唯一渲染接缝）
┌──────────────────────────▼───────────────────────────────────┐
│ three 适配层  ThreeRuntime                                    │
│  viewer/ rigs：camera · lighting · environment · object-store │
│                gizmo · animation · morph · contact-shadow      │
│                instancing · 实例合批                           │
│  picker · render-loop · touch-action-owner                     │
└──────────────────────────────────────────────────────────────┘
```

三入口：`.`（core）、`./element`、`./three`（SDK 不附带样式，元素布局由宿主负责）。约束是硬的：
**`three` 的 import 只出现在 `src/three/` 下**，core 与 element 不感知渲染器。

| 层 | 目录 | 规模 |
|---|---|---|
| core | `src/core/`（schema、迁移、层级、命令、历史） | ~920 行 |
| runtime 契约 | `src/runtime/`（facade、controller、selection、plugin、FakeRuntime） | ~2.0k 行 |
| element | `src/element/`（2773 行单文件：属性、slot、生命周期、模式、错误态） | ~2.8k 行 |
| three | `src/three/`（`three-runtime.ts` 1330 行 + 13 个 rig） | ~5.5k 行 |
| assets | `src/assets/`（cache、loader、variants、解码器懒装配） | ~1.0k 行 |

---

## 3. 关键设计决策

| # | 决策 | 为什么 | 代价/边界 |
|---|---|---|---|
| 1 | **`RuntimeContract` 是唯一渲染接缝** | 单测用 `FakeRuntime`（零 GPU）、宿主可换 WebGPU 或自研渲染；core 不 import three | 契约要手工维护，新增能力只允许「可选成员」 |
| 2 | **文档与显示态严格分离** | `view` 持久化（相机/灯光/环境），`tone-mapping`/`exposure`/阴影/属性一律不写文档 | 宿主需理解两套通道；换来「改个曝光不会把场景标脏」 |
| 3 | **查看器能力只加在元素属性 + 可选契约方法** | `view` schema 到现在仍是 v3，没为对标 model-viewer 动过一次文档格式 | 能力清单靠属性表管理 |
| 4 | **宿主拥有传输** | SDK 不发请求：`save-request` → 宿主 PUT → `markSaved(revision)`；冲突给结构化三份文档 | 冲突 UX 由宿主决定，SDK 不自动合并 |
| 5 | **命令 + `mergeWith`** | 拖滑块一分钟只占一步撤销，`from` 是手势前的值 | 需要每个写命令实现合并判定 |
| 6 | **按需渲染 + 三个互斥的相机占用者** | 只在需要时出帧（阻尼收敛、转台、位姿缓动）；离屏/隐藏标签页停画，恢复补一帧 | 状态机比"永远 rAF"复杂，见 `camera-rig.ts` |
| 7 | **资源所有权显式化** | `AssetCache` 引用计数、材质按实例 clone、token 做 last-call-wins（换 HDR 时旧图自 dispose） | 卸载要靠 `flushDisposers()`，有硬门禁钉住 |
| 8 | **对标而非重写** | gizmo/orbit/picking/glTF 加载用 three 官方 addon；只自研 schema、历史、元素契约、缓存与生命周期 | 受 three 版本牵制 → CI 用版本矩阵提前报警 |
| 9 | **渐进降级不发谎** | 无 GPU 上下文时 IBL/接触阴影静默降级；没有 `IntersectionObserver` 按「在视口内」处理；无动画 rig 直接报空列表 | 降级路径都要有单测 |
| 10 | **形态是模式，不是第二套代码** | `mode` 由文档归属推导（`src` → viewer，`loadDocument` → editor），viewer 连 TransformControls 都不加载；点选/快捷键/选择态统一挂在模式上 | 自定义 `runtimeFactory` 必须转发 `interactive`，否则 viewer 里会冒出 gizmo |
| 11 | **压缩格式的「配置」由 SDK 翻译成「实例」，但保持 opt-in** | three 要的是构造好的 `DRACOLoader` / `KTX2Loader` / `MeshoptDecoder`；`decoder-path` 用一个 base URL 把它们按需装出来，`decoder-cdn` 指向钉死 three 版本的 CDN | 一旦开启，首次加载会先拉 three 的 addon chunk + Meshopt wasm；KTX2 依赖 `RuntimeContract.renderer` 做 `detectSupport`，没有 renderer 的运行时只能跳过 |
| 12 | **合批换「谁画」，不换对象模型** | 每个文档对象仍是自己的 `Object3D`：位姿、材质、拾取、导出、撤销全不变；同几何同材质的实例被吸收进 `InstancedMesh`，代理对象只是移到专用 layer 上（主相机不画，`Raycaster` 显式 `enableAll()` 后仍能命中）。分块按**世界坐标**而不是文档顺序：一块一个网格单元，成员按单元排序后填块 | 丢掉逐实例排序，所以透明材质不参与；分块只按加入/移除触发重排，被拖动过的实例留在旧块里（包围球随之变大，不会错剔，只是剔得不紧）；代理留在 layer 1 这件事是宿主可见的事实——全场景 raycast 必须 `layers.enableAll()`，包内 `picker.ts` 已处理 |
| 13 | **占位资源按内容共享，引用计数** | 5 000 个盒子曾各自 `new BoxGeometry` + `new MeshStandardMaterial`（合批后根本不上传，纯 JS 堆）。改成按内容签名（`primitiveSignature`）建池、按引用计数释放：同一份文档只留 1 个 buffer + 1 个材质 | 宿主拿到的 `object.geometry` 可能是共享的，就地改写会波及同构对象；SDK 自己从不这么干（文档材质走 `applyMaterialOverride`，先 clone） |
| 14 | **资产内部合批是「静态合并」，且只在身份无意义时开** | 合批只能折叠「同几何」的实例；一个 glTF 里 200 个不同 mesh 共用一份材质，只能把顶点烘到世界坐标后拼成一个大 buffer。判断条件全在资产层：无 clip、无 `KHR_materials_variants`、逐 mesh 无蒙皮/morph/子节点/半透明 | 合并后节点身份消失，导出也变成合并网格；动画与变体因此直接跳过合并，而不是「合并后再失效重算」——省掉一套重建机制，代价是这类资产仍逐 mesh 提交 |
| 15 | **拾取加速按需加载，按几何共享** | 包围球只能挡掉「远处的网格」，十万三角形模型的拾取成本在唯一被命中的那个 mesh 里。超过 2 000 三角形才建 `MeshBVH`，替换的是**该 mesh 的** `raycast`（不动 `THREE.Mesh.prototype`）；BVH 是动态 import，且只有真的存在重网格时才发请求 | 首次点击仍是 three 原生路径，树在后台建好后从下一次点击生效（`await picker.ready()` 可提前）；蒙皮/morph/InstancedMesh 不参与（顶点会动或走另一条实例路径） |
| 16 | **「接入样板」算包的能力，不算宿主的作业** | 建文档（六字段信封 + 三支 `view`）、把拖拽的 `.gltf` 包换成可解析 URL、按文档位姿导出、落盘下载——每一处都只有一种正确写法，而且写错不报错（导出带上预览偏移、`.gltf` 的 bin 没换 URI、`blob:` URL 被判成不支持格式）。收进包：`createSceneDocument` / `createDocumentFromAsset`、`createFileBundleUrl` + `el.loadFiles()`、`el.exportDocument()` + `downloadBlob()` | 包面变大（元素入口 +1.9 kB、three 入口 +1.6 kB，gzip 合计 +1.1 kB）；`exportDocument` 是可选契约成员——只会画像素的自研运行时省略它，元素给稳定的 `lifecycle` 错误，而不是导出错东西 |
| 17 | **格式判定「先 URL、后 asset id」** | `blob:http://host/uuid` 与 `/api/model?id=3` 都没有扩展名；旧的 `url.split(".").pop()` 会得到 `1:4173/uuid`，于是 `loadFiles()` 的上传被报成 `asset-unsupported-format`。`assetFormatHint()` 先试 URL，再退回 asset id（上传 id 始终带扩展名），且只接受像扩展名的片段（`/^[a-z0-9]{1,8}$/`） | 既无扩展名又无 id 提示的 URL 仍报「不支持」，不猜 `glb`；`data:` URI 保留专门分支 |
| 18 | **视口覆盖层（着色 / 分解）是包的 rig，且必须跨过合批这道缝** | 着色模式和分解视图是「每个宿主都会要、且写错不报错」的第三批样板：只改代理 mesh 的材质对 `InstancedMesh` 批次无效（xray 只对没合批的对象生效），只写 `obj.position` 不走 `markDirty` 则实例矩阵不刷新。收进包：`display-mode` / `explode` 属性 + `setDisplayMode()` / `setExplode()`（契约可选成员）+ `createDisplayRig` / `createExplodeRig`；着色共享一份覆盖材质（一次写入覆盖全批），分解经 `applyTransform` 落地；两者都是纯预览态，从不写文档 | 元素装载后 re-assert 属性时 `setExplode(0)` 曾触发基线全量重建（O(objects×bounds)），把 perf 页首帧从 2.4 s 推到 4.4 s——0→0 现在是无条件短路；色调映射的重编译交给了 three 自己的程序缓存键（r186 起包含 `toneMapping`），宿主侧的 `needsUpdate` 遍历是纯浪费 |
| 19 | **光照预设是数据，不是行为** | `LIGHTING_PRESETS` 按文档 `view.lights` 的形状导出四套参考布光；应用路径仍是宿主的 `setViewState`（预设因此和其他灯光编辑一样持久化）。有自己审美的宿主定义同形状的表，包不提供注册机制 | 参考值而非真理：预设表不进撤销栈、不进 schema，纯粹省掉「每个宿主抄一遍 4 行光参数」 |
| 20 | **首页「先查看、再编辑」是宿主的决定，不是 SDK 的第二套模式** | 宿主文档本来推导 `mode="editor"`，playground 在元素升级前把 `mode` 钉成 `viewer`，让首个 runtime 就以 `interactive: false` 建出来；顶栏开关只写 `el.mode` + `body[data-studio-mode]`，`mode.css` 负责收起控制面板 / 状态栏 / 保存。e2e 与视觉夹具用 `?mode=editor` 显式保留编辑态 | 隐藏面板会改变视口宽高比，SDK 的 `resize()` 只更新 `camera.aspect` 不重新取景；宽模型在切入编辑时可能略被裁切，按 `F` 重新取景即可。切换不写文档、不进撤销栈 |
| 21 | **`?demo=` 场景体系整体移除，回归回到单测 + 主页面 e2e** | hub 索引与六个能力场景、`src/scenarios/`（router + 场景模块 + markup 片段）、`demo.css` 以及 25 个 e2e 用例全部删除；`minimal.html` 只保留同步执行的最小接入示例，Vite 仍为 3 个 HTML 入口，裸页不再携带场景片段字符串 | 宿主契约面（headless facade、多选命令、迁移/校验、`assetResolver` 信任边界、声明式属性与 hotspot）改由 SDK 单测覆盖，浏览器侧只留首页 / minimal / perf 的 e2e；代价是声明式查看器属性失去真实浏览器里的端到端断言，只剩单测与契约测试 |


---

## 4. 亮点

1. **双形态单内核**：`<scene-editor src>` 与完整编辑器共用同一文档/历史/选择链路，没有 fork；**形态差异落到 `mode`**——同一份文档加 `mode="viewer"` 就丢掉 gizmo、点选和编辑快捷键，`ThreeRuntime` 连 TransformControls 都不加载（`interactive: false`），因此查看器页面不存在"被误选中的坐标轴"。
2. **model-viewer 语义级对标**：`camera-orbit`/`field-of-view`/`auto-rotate`/`reveal`/`poster`/hotspot/`variant-name`/`camera-name`/`shadow-*` 等同名同义；取景复刻 `updateFraming()`，接触阴影复刻 `Shadow` 算法（地面正交相机朝上 + 高度写 alpha）。并排对照结论见 [TODOS.md](../TODOS.md) 第三节（对照页已移除）。
3. **可测性作为一等功能**：379 个单测（37 个文件）覆盖用户可见契约——元素属性与事件、文档模型与迁移、资产解析、headless facade；内部 rig / controller 的实现细节不再单独建用例。`FakeRuntime` 让编辑器逻辑不需要浏览器。
4. **质量门禁分层**：单测（three 版本矩阵）→ critical e2e → 视觉回归（SwiftShader、仅 canvas、1% 容差）→ 性能门禁（含 unload-zero 硬断言）→ `npm pack` 消费者冒烟 → 发布元数据一致性。
5. **卸载零泄漏是断言，不是愿望**：`perf.spec.ts` 要求 `flushDisposers()` 后对象表清空、几何计数回到基线。
6. **失败是可见状态**：`error` 事件之外还有 `slot="error"`（无该 slot 时自绘消息），空白画布不再是一种"正常结果"。
7. **踩坑被固化成规则**：例如 `touch-action` 会被两个 three addon 在 `connect()` 里硬写 `none`，于是有了 `touch-action-owner.ts`（观察者纠偏，同值不重写）；阻尼收敛循环自己不动 `update()`，避免一帧衰减两次。
8. **5 000 个对象 = 13 次 draw call，而且还能被剔除**：同几何同材质的实例自动合成按空间分块的 `InstancedMesh`（`perf.html?instancing=0` 可同页对照），5k 场景 p95 从 28.1 ms 回到 17.0 ms（vsync 到顶）、装载从 536 ms 降到 288 ms，近景只提交 18 432 个三角形而不是全部 60 000；而对象仍然可点选、可拖动、可导出、可撤销。取舍写在决策 12 与 §6。
9. **同一份文档的资源开销随规模变平**：占位体几何/材质按内容共享，5 000 个盒子只分配 1 个 buffer + 1 个材质（JS 堆 26.5 MB → 11.0 MB，`perf.html` 断言 `geometries === 1`）；资产内部同材质 mesh 静态合并（200 → 1 个 mesh，约 25 ms）；拾取对 >2 000 三角形的网格自动上 BVH（130 560 三角形：单次拾取 12.0 ms → 0.10 ms，BVH 33 kB gzip 动态加载）。
10. **小包体、小权限**：core 入口 gzip 13.8 kB（含解码器装配，解码器本体不在包里）；`three` 是 peer，不打包；元素路径默认不引外部资源（内置中性影棚 IBL、内置解码器以外零网络）。压缩资产是唯一的例外，而且要显式写 `decoder-path` / `decoder-cdn` 才会发生。

---

## 5. 基准（实测）

环境：Windows / Edge 143 headless、ANGLE D3D11、AMD Radeon Vega 8（核显）、视口 1280×800、Vite dev server（未压缩传输，未做 brotli）。
数字包含元素初始化与首次着色器编译，属于「开发服务器冷启」口径，不是生产 CDN 口径。

### 5.1 包体（`vite build`，gzip）

| 入口 | 原始 | gzip |
|---|---|---|
| `@scenio/scene-editor`（core：`index` + `create-scene-editor` + 事件总线 + 解码器装配 + 光照预设数据） | 54.2 kB | **15.4 kB** |
| `@scenio/scene-editor/element`（全链路：core + element + three 适配，three 外部化） | 169.2 kB | **48.4 kB** |
| `@scenio/scene-editor/three`（适配层 chunk 本体，含合批 / 资源共享 / 拾取 / 导出 / 着色与分解 rig） | 84.1 kB | 24.4 kB |
| `three-mesh-bvh` 动态 chunk（仅点击重网格时下载） | 124.6 kB | 32.7 kB |

口径：core = `index` + `create-scene-editor` + `typed-event-bus`；element 全链路 = 上面三块 + `element-entry` + `three-runtime`（GLTF/OBJ 导出器与 BVH 都不在内，它们是动态 import）。

`mode` / 错误态 / 裁剪面推导 / 解码器装配 / 实例合批（含空间分块）合计给 element 全链路带来约 4 kB gzip；本轮的资源共享、资产静态合并与拾取加速再加约 2.3 kB（BVH 本体走动态 chunk，不进包体）；viewer 不再加载 TransformControls，冷启反而更快（见 5.3）。

### 5.2 场景规模（`apps/playground/perf.html`，1k/5k 个盒子）

场景是 40×N 个同规格盒子（`buildDoc()`），即「同几何 + 同材质 + 只有位姿不同」——合批的理想输入。
`?instancing=0` 关掉合批，同一页面即可对照。

| 指标 | 1 000 对象 | 1 000，关合批 | 5 000 对象 | 5 000，关合批 |
|---|---|---|---|---|
| 场景装载（`loadDocument`） | **278 ms** | 470 ms | **288 ms** | 536 ms |
| p50 帧时间 | 16.7 ms | 16.7 ms | 16.6 ms | 21.2 ms |
| **p95 帧时间** | **16.9 ms** | 16.9 ms | **17.0 ms** | 28.1 ms |
| 峰值帧 | 17.4 ms | 17.6 ms | 17.4 ms | 33.7 ms |
| **draw calls（全览）** | **5** | 1 001 | **13** | 1 881 |
| triangles（全览） | 12 000 | 12 000 | 36 864 | 22 560 |
| **draw calls（近景，15° 视角）** | 5 | 323 | **7** | 369 |
| **triangles（近景）** | 12 000 | 3 864 | **18 432** | 4 416 |
| 上传的几何数 | 2 | 1 001 | 2 | 1 881 |
| 卸载后几何计数 | → 0（回基线） | → 0 | → 0 | → 0 |

读法：

1. **瓶颈是提交次数**。5k 对象从 1 881 次 draw call 降到 13 次，p95 从 28.1 ms 回到 17.0 ms（vsync 上限 16.7 ms，已到顶），装载也从 536 ms 降到 288 ms——少掉的 1 879 个材质/几何上传比合批本身的开销更大。
2. **分块是为了把剔除买回来**。一个 `InstancedMesh` 覆盖整组等于只有一个包围球，全览三角形会从 22 560 涨到 60 000；改成按世界坐标分块（每块 ≤256 实例、一块一个网格单元）后，全览 36 864、近景只有 18 432。1k 对象分块后只有 4 个 chunk，近景仍然全部命中（12 000 不变）——分块的收益随场景变大才显现，5k 才进表格的原因就在这。
3. 1k 对象两条曲线都是 16.7 ms（vsync 下限），看不出差别——只有 5k 才越过预算。
4. 近景一列是 `perf.html` 末尾的第二次渲染（相机贴着一个网格角、15° 视角），用来盯住「合批不许吃掉剔除」这条回归。

「首帧可交互」不进表：它被页面/模块冷启主导，同一轮里量到 0.7–2.5 s 的抖动（Vite dev server + 首屏 transform），
不适合当基线。设计目标是 ≤2 s，但 `perf.spec.ts` 的门禁放在 3 s：2 s 卡的是这台机器的冷启抖动（本轮两次跑出
2 081 / 2 471 ms），不是回归，`PERF_FIRST_MS` 可在 CI 上按 runner 校准。

### 5.3 真实 glTF 预览（`<scene-editor src>`，冷启逐个体积）

| 模型 | 体积 | `load` 事件 | 首帧 | draw calls | triangles | 动画片段 |
|---|---|---|---|---|---|---|
| Fox.glb | 160 KB | 438 ms | 438 ms | 1 | 576 | 3 |
| CesiumMilkTruck.glb | 362 KB | 517 ms | 518 ms | 5 | 3 624 | 1 |
| WaterBottle.glb | 8.6 MB | 601 ms | 601 ms | 1 | 4 510 | 0 |
| DamagedHelmet.glb | 3.6 MB | 676 ms | 676 ms | 1 | 15 452 | 0 |
| BoomBox.glb | 11 MB | 751 ms | 751 ms | 1 | 6 036 | 0 |

`load` 到首帧现在只差 0–1 ms：取景在 `load` 之前完成，宿主回调里读到的就是最终相机与尺寸。整体比上一轮快约 10%，因为 viewer 不再导入 TransformControls（`mode="viewer"` 连 addon 都不加载）。几百 KB 到 11 MB 都在 0.44–0.75 s 内完成，且时间与体积弱相关（解析/上传占主导，dev server 未压缩）。

### 5.4 测试规模

| 层 | 数量 | 耗时 |
|---|---|---|
| 单元测试（vitest） | **379 通过 / 37 文件**（用户可见契约；内部 rig / controller 用例已精简） | 22.2 s |
| e2e（Playwright：critical / viewer / decoders / visual / perf） | 11 用例 / 5 个 spec（`playwright test --list` 实测；原 25 个 `?demo=` 场景用例与 playground 面板细节用例已移除，visual / perf 为独立项目） | CI 三个 job |
| 视觉基线 | 4 张 canvas-only 截图 | SwiftShader |
| 性能门禁 | 本地 p95 ≤ 40 ms、首帧 ≤ 3 s（设计目标 2 s，见 5.2 末段）；CI（SwiftShader）≤ 500 ms / ≤ 15 s，unload-zero 精确断言 | — |

### 5.5 复现

```bash
pnpm install && pnpm build
pnpm test                 # 379 单测
pnpm test:perf            # 1k 对象：首帧、p95、draw calls、unload-zero
pnpm test:e2e:visual      # 视觉回归（需 Playwright 浏览器）
# 手工：pnpm --filter @scenio/playground dev → http://127.0.0.1:3000/perf.html?objects=5000
#      加 &instancing=0 关掉合批做同页对照
```

---

## 6. 已知边界

- 合批只覆盖**程序化几何/占位体**（`BoxGeometry` 之类有 `parameters` 的几何 + 可指纹化的材质）。glTF 资产、透明材质、带 `clippingPlanes` 等不可指纹字段的材质一律不参与。资产内部的「同材质多 mesh」由静态合并补上，但带 clip / 变体 / 蒙皮 / morph 的资产不合并——那类资产仍逐 mesh 提交。
- 合批的剔除是**块级**，不是实例级：一块最多 256 个实例共用一个包围球，所以近景仍会多提交一块的量（5k 实测 18 432 / 60 000）；块也不做逐实例排序——这正是透明材质被排除的原因。想再往下压只能上 GPU 侧剔除（`BatchedMesh`）或把块切得更小，两者都要用 draw call 或内存换。
- 压缩资产要显式开启（`decoder-path` / `decoder-cdn`）：默认不发任何请求，所以一个 Draco GLB 在不写属性时仍然打不开——只是现在会明确告诉你缺什么。KTX2 还需要运行时有 renderer（`detectSupport` 要探设备格式）。
- 进度条的解析阶段（GLB → 场景图）无法细分，大文件在最后一跳会有停顿。
- 动画一次一个 clip（可交叉淡入），不支持多 clip 叠加混播；无 AR/XR（明确不做）。
- 资产静态合并只在挂载时算一次，之后不重建：变体切换会改写每节点材质，所以声明了变体的资产直接跳过合并；带 clip 的资产同理（动画要能驱动子节点）。
- WebGPU 只保证 `rendererFactory` 接缝可用，CI 不测。

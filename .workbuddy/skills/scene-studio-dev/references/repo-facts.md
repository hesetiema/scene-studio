# scene-studio 仓库事实（分层 · 不变式 · 陷阱）

改动涉及分层、跨模块引用、公开契约时读本文件。

> 本文件是仓库根 [`AGENTS.zh-CN.md`](../../../../AGENTS.zh-CN.md) 的**摘要**，供 skill 一处取用。
> 两者冲突时**以 `AGENTS.zh-CN.md` 为准**；改了不变式请同步改两处，并在 PR 说明里写明。

## 1. 分层与实测规模

| 层 | 目录 | 行数 | 依赖 three | 职责 |
|---|---|---|---|---|
| core | `src/core/` | 1 146 | 否 | 文档 schema、迁移、校验、层级、命令、历史、事件/错误码 |
| runtime | `src/runtime/` | 2 133 | 否 | facade、controller、选择、插件宿主、事件总线、`FakeRuntime` |
| element | `src/element/` | 3 465 | 仅懒加载 | 自定义元素：属性、slot、生命周期、模式、错误态、a11y |
| three | `src/three/` | 7 611 | 是 | `ThreeRuntime`（1 361）+ `assembly.ts`（装配/连线）+ `viewer/` 20 个单职责模块（10 个 `create*Rig`）+ `viewer/instancing/`（fingerprint / chunks / layout） |
| assets | `src/assets/` | 1 249 | 是 | 缓存（引用计数）、加载器、变体、解码器懒装配 |
| bim | `src/bim/` | 770 | 是 | Revit 楼层、FBX、轮廓网格、单位换算 |
| plugins | `src/plugins/` | 38 | 否 | 插件契约 |

实测（`scripts/check-boundaries.mjs`）：**83 文件 / 263 条静态内部边 / 0 循环 / 0 违规**。
另有 18 条**被许可的懒引用**（`import()` 形式的 three addon：DRACO/KTX2/Meshopt/GLTF/OBJ/STL/
HDR/EXR 加载器、OBJ/GLTF 导出器、OrbitControls）。这些不进静态依赖图。

> 硬约束：**`three` 的静态 import 只允许出现在 `three/`、`assets/`、`bim/`**。
> `element/` 只能懒加载（`lazyGltfLoader()` 是范例）。
> `core/` 与 `runtime/` 完全不碰 three —— 单测跑在 `environment: "node"`，一碰就整套起不来。

## 2. 九条不变式

1. **依赖方向单向**：`core` ← `runtime` ← {`element`, `three`}。循环数必须保持 0。
   唯一残留反向边：`core/commands/transform-command.ts` → `runtime/runtime-contract.ts` 的
   `import type { Transform }`（纯类型，编译期擦除）。`Transform` 是文档概念，理应归 `core`。
2. **`core/` 与 `runtime/` 不得 import three**。那个失败本身就是告警，别靠换 DOM 环境"修好"。
3. **three 只在三处静态 import**（见上）。它是 peer、在 `vite.config.ts` external，永不打包。
   ⚠ `docs/ARCHITECTURE.md` §2 仍写「只出现在 `src/three/` 下」—— 那句话已过期，不要据它改代码。
4. **`RuntimeContract` 是唯一渲染接缝**。新能力 = 新**可选**成员 + `FakeRuntime` 兜底。
   加必选成员会一次性打断所有自定义运行时和全部测试。
5. **显示态永不进文档**：色调映射、曝光、阴影、`display-mode`、`explode`、相机环绕都是预览态；
   只有 `view`（相机/灯光/环境）持久化。`view` 停在 **schema v3**，加字段 = 升版 + 迁移 + fixture 重写。
6. **SDK 不做宿主 I/O**：`save-request` → 宿主 PUT → `markSaved(revision)`；冲突给结构化三份文档，
   永不自动合并。
7. **`src` 只在连接时读一次**，之后修改是刻意空操作（一次 `console.warn`）。已按产品决策移除，别恢复。
8. **包不附带 CSS**，元素是 light DOM 无样式，尺寸由宿主负责。不要重新引入 `:host`。
9. **一个包四个入口**（`.`、`./element`、`./three`、`./bim`）。不拆包、无插件面板槽位、无 CRDT。

## 3. 新增公开 exports 子路径：四处缺一不可

1. `packages/scene-editor/package.json` → `exports`
2. `packages/scene-editor/vite.config.ts` → `build.lib.entry`
3. `apps/playground/tsconfig.json` → `compilerOptions.paths`
4. `scripts/pack-smoke.mjs` → `required`

第 4 处注意：`tsc` 保留 `src/` 目录结构，vite 会把 js 拍平 ——
`src/bim/bim-entry.ts` → `dist/bim-entry.js` + `dist/bim/bim-entry.d.ts`。
漏第 4 处只在 CI 的 `test:pack` 报错；漏第 3 处则 playground 类型检查解析到过期 `dist`。

## 4. 已经付过代价的坑

- **数据快照永不入库**：`public/data/`、`public/bim/` 被刻意 gitignore（含真实客户几何与楼栋/楼层 ID）。
  缺文件时 demo 渲染「无本地数据」提示卡，那就是干净 clone 的正确状态。
- **不给查看器特性开第二条渲染路径**。
- **合批与拾取相互影响**：合批代理被移到 layer 1（`BATCH_PROXY_LAYER`，由
  `three/viewer/instancing/fingerprint.ts` 导出），主相机不渲染它 —— 任何全场景 raycast 必须
  `layers.enableAll()`。`picker.ts` 已处理，照抄，不要手搓 `Raycaster`。
- **`markDirty` 必须遍历子树**，否则拖动 group 时合批子对象不跟手。
- **`setExplode(0)` 必须短路**：装载时重新断言该属性曾触发基线全量重建，首帧时间翻倍。
- **不给色调映射加 `material.needsUpdate` 遍历**：three r186+ 程序缓存键已含 `toneMapping`。

## 5. 已知弱点（已知且接受，别顺手重构）

- `element/scene-editor-element.ts` **2042 行**单 class，约 95 公开 + 约 42 私有成员，
  聚合了加载编排、解码器装配、模式投影，以及 DOM 契约本身。全仓最难单测。
  connect 装配已拆七阶段（`#mountCanvas` → `#createRuntime` → `#pushInitialState` →
  `#wireInput` → `#wireViewport` → `#forwardFacadeEvents` → `#publishReady`）——
  **新接线进对应阶段，别把 `#init` 养回长方法**。`#forwardFacadeEvents` 是扁平表，刻意不拆。
  `element/` 自下而上三层，新代码按此落位：
  1. `attribute-math.ts`（108 行）—— 轨道几何 `orbitFromCamera`/`cameraFromOrbit` 与属性解析器
     `parseVector3`/`parseOrbitToken`/`parseAngle`。零 import（除 `ViewState` 类型）。
  2. `slot-chrome.ts`（629 行）—— poster、进度条、错误浮层、热点锚点。
     **新的槽位行为加这里**；element 只留四个公开转发 + `#contentLoaded`（经 host 回调读）。
     公开类型 `HotspotVector/HotspotData/HotspotConfig` 声明在此，由 element 再导出。
  3. `viewer-attributes.ts`（577 行）—— 属性 → runtime 投影：environment、alt、display、
     shadow、camera pose/policy、playback、`touch-action`。持「已应用姿势」签名（唯一可变状态）。
     host 只有 5 个成员：`element`/`runtime()`/`canvas()`/`documentOwner()`/`explicitPause()`。
     **新增 viewer 属性 = 这里一个方法 + `attributeChangedCallback` 一行。**
     导出 `commitCamera`/`clampFieldOfView` 供四个公开相机 setter 复用。
  **验收口径**：三次外置后 `element-entry.d.ts` 与重构前**逐字节相同**、`SceneEditorElement`
  类声明块逐字节相同；21 条属性路径全部有单测覆盖。
  不可外置：加载流水线（17 个跨簇字段）、公开转发层 —— 都没有干净接缝。属 L2，需先定验收标准。
- `three/three-runtime.ts` **1 361 行**（契约实现 + 3–5 行转发，9 个分节），装配已外置到
  `three/assembly.ts`（`createRigSet`）。剩下的是扁平转发层，**刻意不拆**。
- `three/viewer/instancing-rig.ts` 717 → **422 行**，三个部件外置到 `three/viewer/instancing/`：
  `fingerprint.ts`（内容指纹 + 合批资格）、`chunks.ts`（`InstancedMesh` 槽位/扩容/销毁）、
  `layout.ts`（纯函数空间排序）。有 28 条特征测试兜底（`test/three/instancing-rig.test.ts`）。
- `three/viewer/object-store.ts` **607 行**（文档树索引 + 代理生命周期 + 变体/覆盖），
  2026-11-14 已补 **40 条特征测试**（`test/three/object-store.test.ts`，含变异验证能红）。
  **结论：不拆。** 它不在每帧路径上（`sync` 在 instancing 里，store 只在装载/命令时被调用），
  而每个可外置的簇只有 12–100 行（最大是 mounting ≈100 行），外置却要 3–5 个成员的 host
  接口（变体簇就要 `objects`/`assets`/`overrides`/`variantName` 四个共享状态），收益为负。
- `src/bim/` 是单产品领域代码占公开子路径，消费者只有 `apps/playground/src/vent-demo.ts`。
  最该外迁的一块，但在「不拆包」前提下可接受。
- **没有任何 import 边界门禁**（这正是 `scripts/check-boundaries.mjs` 存在的原因）。
  把它接进 CI 是性价比最高的质量改进；接法属 L1，改 CI 属 L3。

## 6. 约定速查

- TS 严格且挑剔：`noUncheckedIndexedAccess`（下标得 `T | undefined`）、
  `exactOptionalPropertyTypes`（不能给可选键赋 `undefined`）、`verbatimModuleSyntax`
  （纯类型 import **必须**写 `import type`）。
- 语言：标识符/注释/commit 一律英文；`docs/ARCHITECTURE.md` 与 `TODOS.md` 中文；
  用户文档成对（`.md` / `.zh-CN.md`）。
- Commit：`type(scope): subject`（`feat(viewer): …`、`fix(bim): …`）。
- 单测：vitest、`test/**/*.test.ts`、node 环境、无 DOM，断言公开契约不断言私有 `#方法`。
- E2E：Playwright，用 `127.0.0.1`。视觉基线仅 canvas、SwiftShader、1% 容差，
  刷新用 `--update-snapshots` 并提交 PNG。
- `@scenio` 是占位 scope，不要发布。

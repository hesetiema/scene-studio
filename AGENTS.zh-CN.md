# AGENTS.md（简体中文）

> English: [AGENTS.md](AGENTS.md)

给 AI 编码 agent 的仓库指南。本文件范围刻意收窄：**只写会静默出错的东西**——分层规则、不变式，
以及「看起来没问题、测试也绿，但其实是错的」那些坑。

流程类约束（只读/写入分离、不可逆动作确认、风险分级、证据格式、排查与审查规程）以仓库 Wiki
[AI 开发规则（Agent 必读）](https://github.com/hesetiema/scene-studio/wiki/AI-%E5%BC%80%E5%8F%91%E8%A7%84%E5%88%99%EF%BC%88Agent-%E5%BF%85%E8%AF%BB%EF%BC%89)
为准，本文件不重复；两者冲突时按该文 §0 优先级裁决（Wiki > 本文件）。

其余内容都在人读文档里，不要重复：

| 文档 | 语言 | 读它来了解 |
|---|---|---|
| [README.zh-CN.md](README.zh-CN.md) | 中文 | 产品是什么、两种使用形态、门禁表 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 中文 | 分层、21 条设计决策与其代价、实测基准、已知边界 |
| [TODOS.md](TODOS.md) | 中文 | 已完成、待办、**明确非目标（§5）** |
| [packages/scene-editor/API.md](packages/scene-editor/API.md) | 英文 | 全部公开符号 |
| [apps/playground/README.md](apps/playground/README.md) | 英文 | 参考宿主、模块地图、本地数据准备 |

---

## 这个仓库是什么

一套文档模型、一份运行时契约、三种形态：

- **查看器**（viewer）— `<scene-editor src="model.glb">`，纯属性驱动，无编辑态 UI
- **编辑器**（editor）— `<scene-editor>` + `loadDocument(doc)`：选择、gizmo、命令、撤销/重做
- **无头**（headless）— `createSceneEditor({ runtime })`，零 DOM

查看器**不是**第二条代码路径：它合成一份单对象文档（`createSrcDocument()`），走同一条
加载/选择/历史链路。差别只有一个字段：`mode`。

`packages/scene-editor` 是发布的 SDK；`apps/playground` 是消费者——它**只**通过包名
（`@scenio/scene-editor{,/element,/three,/bim}`，由 `apps/playground/tsconfig.json` 的 `paths` 接线）
引用 SDK。**永远不要**从 app 里伸手进 `../../packages/.../src`；那条缝就是包边界成立的前提。

---

## 命令

Node 24+、pnpm 11+。在仓库根目录执行。

| 任务 | 命令 |
|---|---|
| 安装 | `pnpm install` |
| 全量类型检查 | `pnpm typecheck` |
| 单测（vitest） | `pnpm test` |
| 单个测试文件 | `pnpm --filter @scenio/scene-editor test test/core/document-schema.test.ts` |
| 全量构建 | `pnpm build` |
| E2E | `pnpm test:e2e` |
| 视觉回归 | `pnpm test:e2e:visual` |
| 性能门禁 | `pnpm test:perf` |
| 发布元数据一致性 | `pnpm test:release` |
| 产物消费冒烟 | `pnpm test:pack` |
| Playground 开发 | `pnpm --filter @scenio/playground dev` → <http://127.0.0.1:3000> |

交付前必须跑 `pnpm typecheck && pnpm test`。动了 `package.json` 的 exports、文档或版本号 →
再加 `pnpm test:release`。动了构建或公开面 → 再加 `pnpm test:pack`。

若 pnpm 以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止，说明当前 `node_modules` 比
lockfile 旧、pnpm 想整目录清空重建。非交互 shell 下请绕过 pnpm 的依赖检查、直接调二进制
（`packages/scene-editor/node_modules/.bin/vitest run <file>`）；**不要**为了绕过去手删 `node_modules`。

---

## 不变式

破坏其中任何一条都是回归，不是重构。有对应检查的地方已标明。

1. **依赖方向单向。** `core` ← `runtime` ← {`element`, `three`}。当前实测：**83 个文件、
   263 条静态内部边、0 个循环** —— 循环数必须保持 0。唯一残留的反向边是
   `core/commands/transform-command.ts` → `runtime/runtime-contract.ts` 的
   `import type { Transform }`（纯类型）；`Transform` 本质是文档概念，理应归 `core`。

2. **`core/` 与 `runtime/` 不得 import `three`。** 单测跑在 vitest `environment: "node"` +
   `FakeRuntime` 下，没有 GPU 也没有 DOM —— `core` 里出现 `three` 会让整套测试起不来。
   **那个失败本身就是告警**，不要靠换成 DOM 环境来「修好」它。

3. **`three` 只在这三处被静态 import：** `src/three/*`（适配层）、`src/assets/*`（解码器装配 +
   glTF 加载）、`src/bim/*`（FBX/Revit 加载）。它是 **peer** 依赖，在 `vite.config.ts` 里
   external —— 永不打包进产物，永不加进 `core`/`runtime`。`element/` 正好卡在边界上：它只能
   通过懒加载 `import()` 触达 three（范例如 `lazyGltfLoader()`），绝不能用静态
   `import … from`，否则 element 入口会在模块作用域就把 three 拖进来。当前存在 18 条这类
   被许可的懒加载 addon 引用。
   > `docs/ARCHITECTURE.md` §2 仍写着「`three` 的 import 只出现在 `src/three/` 下」。
   > 这句已过期：当前 `assets/` 有 3 个文件、`bim/` 有 4 个文件静态 import three。
   > 以上第 3 条才是准确表述；下次改到那儿时**改文档，不要改代码**。

4. **`RuntimeContract` 是唯一的渲染接缝。** 新增运行时能力 → 在接口上加**可选**成员
   （并在 `FakeRuntime` 里给兜底实现）。加必选成员会一次性打断所有自定义运行时和所有测试。

5. **显示态永不进文档。** 色调映射、曝光、阴影、`display-mode`、`explode`、相机环绕都是
   预览态；只有 `view`（相机/灯光/环境）持久化。`view` 停在 **schema v3** —— 加字段意味着
   schema 升版 + `core/document/migrations.ts` 迁移 + fixture 重写。不要为了发一个查看器特性而动它。

6. **SDK 不做任何宿主 I/O。** 保存 = `save-request` → 宿主 `PUT` → `markSaved(revision)`。
   revision 不匹配时暴露结构化冲突；SDK 从不自动合并。

7. **`src` 只在连接时读一次。** 之后再改是刻意的空操作（只发一次 `console.warn`）。
   这是被故意移除的能力 —— 见 TODOS.md §1「动态 `src` 能力已移除」。不要恢复它。

8. **包不附带任何 CSS，也没有样式表导出。** 元素是无样式自定义元素，尺寸是宿主的责任。
   不要重新引入 `:host` 规则 —— 元素用的是 light DOM。

9. **一个包、四个入口**（`.`、`./element`、`./three`、`./bim`）。不拆包、不做插件面板槽位、
   不做 CRDT —— 三者都是 TODOS.md §5 里的明确非目标。

---

## 新增公开 exports 子路径 —— 四处，缺一不可

1. `packages/scene-editor/package.json` → `exports`（`types` + `import`）
2. `packages/scene-editor/vite.config.ts` → `build.lib.entry`
3. `apps/playground/tsconfig.json` → `compilerOptions.paths`
4. `scripts/pack-smoke.mjs` → `required` 数组 —— 需要 `dist/<name>.js` **以及** `tsc`
   实际产出的 `.d.ts` 路径。`tsc` 保留 `src/` 目录结构，vite 会把 js 文件名拍平：
   `src/bim/bim-entry.ts` → `dist/bim-entry.js` + `dist/bim/bim-entry.d.ts`。

漏第 4 处只在 CI 的 `test:pack` 报错；漏第 3 处则 playground 的类型检查会解析到过期的 `dist`。

---

## 新代码落在哪

| 要写的是… | 落在 | 注意 |
|---|---|---|
| 文档结构、迁移、校验 | `core/document/` | 纯数据。无 DOM、无 three |
| 一个编辑操作 | `core/commands/` | 一命令一文件；**必须**实现 `mergeWith`，否则拖一次滑块能塞满撤销栈 |
| 事件、错误码 | `core/events/` | 错误码是封闭集合，加一个是公开 API 变更 |
| 状态机、选择、插件宿主 | `runtime/` | 零 DOM、零 three；必须能在 `FakeRuntime` 上跑 |
| 一项新的运行时能力 | `runtime/runtime-contract.ts` **+** `runtime/fake-runtime.ts` **+** `three/three-runtime.ts` | 要么三处都写，要么都不写 |
| 资产加载、解码器装配 | `assets/` | |
| 任何 three.js 相关：rig、拾取、导出 | `three/` | `three/viewer/` 下一个关注点一个 `*-rig.ts`；创建顺序与跨 rig 连线在 `three/assembly.ts` |
| DOM 属性、slot、生命周期、无障碍 | `element/` | element + `slot-chrome` + `viewer-attributes` + `attribute-math` + 三个小助手（`register`、`src-document`、`download`），见「已知弱点」 |
| 宿主 UI、面板、URL 参数 | `apps/playground/src/` | 永远不是改 SDK 的理由 |

---

## 约定

- **TypeScript 严格且挑剔。** `noUncheckedIndexedAccess`（下标访问得到 `T | undefined`）、
  `exactOptionalPropertyTypes`（不能给可选键赋 `undefined`）、`verbatimModuleSyntax`
  （纯类型 import **必须**写 `import type`）。
- **语言：** 标识符、代码注释、commit message 一律**英文**（`src/` 里 601 行英文注释 vs 3 行中文）。
  `docs/ARCHITECTURE.md` 与 `TODOS.md` 是中文。面向用户的文档成对发布（`.md` / `.zh-CN.md`）。
- **Commit：** `type(scope): subject` —— `feat(viewer): …`、`fix(bim): …`、`docs(element): …`、
  `refactor: …`。按日志既有风格写。
- **单测：** vitest、`test/**/*.test.ts`、node 环境、无 DOM。断言公开契约，不断言私有 `#方法`。
  元素行为通过 happy-dom + 公开 API 验证。
- **E2E：** Playwright。**用 `127.0.0.1`，不要用 `localhost`** —— dev server 只绑 IPv4。
- **视觉基线：** 仅 canvas、SwiftShader、1% 容差。用
  `pnpm test:e2e:visual --update-snapshots` 刷新并提交 PNG。
- **`@scenio` 是占位 scope。** 不要发布；版本号变更走 `test:release`。

---

## 已经付过代价的坑

- **永远不要提交数据快照。** `apps/playground/public/data/` 与 `public/bim/` 被刻意 gitignore ——
  那是含内部标识（楼栋/楼层 ID）的真实客户几何。缺这些文件时 demo 渲染「无本地数据」提示卡，
  那**就是**干净 clone 的正确状态。
- **不要为查看器特性新增第二条渲染路径。** 若某特性在查看器里要有不同表现，它属于
  `mode` / `interactive: false` 之后，不属于一个新的 `if (isViewer)`。
- **`instancing` 与拾取相互影响。** 合批代理被移到 layer 1（`BATCH_PROXY_LAYER`，由
  `three/viewer/instancing/fingerprint.ts` 导出），主相机不渲染它 —— 所以任何全场景 raycast 都必须
  `layers.enableAll()`。`picker.ts` 就是这么干的；照抄它，不要自己手搓 `Raycaster`。
- **`markDirty` 必须遍历子树。** 拖动一个 group 要让刷新到达合批子对象，否则批次会落后于父节点。
- **`setExplode(0)` 必须短路。** 装载时重新断言该属性曾触发基线全量重建，把首帧时间翻倍。
- **不要给色调映射加 `material.needsUpdate` 遍历** —— three r186+ 的程序缓存键已包含 `toneMapping`。

---

## 已知弱点（已知且接受 —— 没人要求就别去「改进」）

- `element/scene-editor-element.ts` 有 **2042 行**，单个 class，约 95 个公开成员 + 约 42 个私有成员。
  它是刻意的聚合：加载编排、解码器装配、模式投影，以及 DOM 契约本身。
  它同时也是全仓最难单测的文件。**connect 装配已拆成七个命名阶段** —— `#mountCanvas` →
  `#createRuntime` → `#pushInitialState` → `#wireInput` → `#wireViewport` → `#forwardFacadeEvents`
  → `#publishReady`。**新接线放进它所属的阶段，绝不要把 `#init` 养回 269 行。**
  `#forwardFacadeEvents` 是一张扁平转发表，刻意不拆 —— 不要为了行数去切它。
  已有三块外置，新代码请落到对应模块，不要加回 element：
  - `element/slot-chrome.ts` —— poster / 进度条 / 错误浮层 / 热点锚点。element 只保留四个公开转发
    （`queryHotspot`、`updateHotspot`、`dismissPoster`、`refreshSlots`），并持有 `#contentLoaded`，
    由槽位模块经 host 回调读取。
  - `element/viewer-attributes.ts` —— 属性 → runtime 投影（environment、alt、display、shadow、
    camera pose 与 policy、playback、`touch-action`）。它持有「已应用姿势」签名；element 持有
    「何时应用」（connect、load、属性变化）、五成员 host，以及共用 `commitCamera` /
    `clampFieldOfView` 的四个命令式相机 setter。
    **新增一个 viewer 属性 = 这里加一个方法 + `attributeChangedCallback` 里加一行。**
  - `element/attribute-math.ts` —— 本层的基础：轨道几何（`orbitFromCamera` /
    `cameraFromOrbit`）与属性解析器（`parseVector3`、`parseOrbitToken`、`parseAngle`）。
    `slot-chrome` 与 `viewer-attributes` 都 import 它；它不从 `element/` 里 import 任何东西。
  **不要**外置加载流水线（139 行但触碰 17 个跨簇字段），也不要外置公开转发层 —— 两者都没有干净的接缝。
- `three/three-runtime.ts` 有 **1 361 行**：`RuntimeContract` 实现 + 一层扁平转发，按 9 个分节
  组织（Engine seams / RuntimeContract / Viewer-side extras / Selection / Variants /
  Embedded cameras / Morph / Animation / Internals）。转发层刻意扁平 —— 不要为了行数去切。
- **装配在 `three/assembly.ts`**（`createRigSet`）。创建顺序是有约束的，且只在这一处可审：
  lighting → renderer → environment → camera rig → render loop → picker → animation → morph →
  batcher + resources → object store → display / explode / contact shadow → gizmo。
  **新增一个 rig = 这里加一段 + `RigSet` 加一个字段 + 构造函数加一行赋值。**
  装配的 options 用结构化子集 `AssemblyOptions`，不反向 import runtime —— 那会构成循环（B3）。
- `three/viewer/` 20 个单职责模块，其中 **10 个 `create*Rig` 工厂**（animation、camera、
  contact shadow、display、environment、explode、gizmo、instancing、lighting、morph；
  `contact-shadow.ts` 是第 10 个实现，只是文件名没带 `-rig`），外加 `object-store`、
  `render-loop`、`framing`、`shared-resources`。合批器的三个部件在旁边的 `three/viewer/instancing/`：
  `fingerprint.ts`（什么算同内容、什么允许合批）、`chunks.ts`（单个 `InstancedMesh` 的槽位/扩容/销毁）、
  `layout.ts`（纯函数空间排序）。
- `src/bim/`（770 行：Revit 楼层加载、FBX、轮廓网格、单位换算）是**服务于单一产品**的领域加载代码，
  却住在通用 SDK 里，还占了一个公开的 `./bim` 子路径，而它的消费者只有一个
  （`apps/playground/src/vent-demo.ts`）。在「不拆包」前提下可接受，但它是最该搬出去的一块。
- **仓库里没有任何 import 边界门禁。** 不变式 1–3 只靠自觉，以及 node 环境的单测兜着 ——
  往 `core/` 里加一个 `three` import 能通过 `pnpm typecheck`，最后只表现为一个莫名其妙的
  测试环境报错。仓库外已有一个约 150 行的检查脚本（遍历 `src/`、区分静态/懒加载/纯类型
  引用、报 B1/B2/B3 违规）；把它放进 `scripts/` 并接进 CI 是当前性价比最高的质量改进。
  该改动动到 CI，属 L3 —— 先问。

---

## 拿不准时

改公开类型、文档 schema，或上面任一不变式之前，先问。其余一切 —— 内部重构、测试、文档、
playground UI —— 直接做，然后跑门禁。

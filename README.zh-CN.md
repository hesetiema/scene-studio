# scene-studio

可嵌入网页的 3D 场景编辑器与模型查看器。以 [`@scenio/scene-editor`](https://www.npmjs.com/package/@scenio/scene-editor) 发布（`@scenio` 仍是占位 scope）。仓库当前版本为 `0.7.0`；npm 上最新发布版本为 `0.6.0`。

**文档：** 简体中文（本页） · [English](README.md) · [技术架构与基准](docs/ARCHITECTURE.md) · [包快速上手](packages/scene-editor/README.zh-CN.md) · [API 参考](packages/scene-editor/API.md)

## 这是什么

一套文档模型、一个渲染契约、三种用法：

| 形态 | 入口 | 适用 |
|---|---|---|
| **查看器** | `<scene-editor src="model.glb">` | 只要把模型画对、能转能看，语义对齐 model-viewer |
| **编辑器** | `<scene-editor>` + `loadDocument(doc)` | 场景可编辑：选择、gizmo、增删、撤销/重做、宿主保存 |
| **Headless** | `createSceneEditor({ runtime })` | 自带 UI 与输入，零 DOM |

预览不是第二条代码路径：元素合成一份单对象文档，走的是同一套加载/选择/历史链路，因此查看器可以无痛升级成编辑器。

两种形态**在显示上就是分开的**：`src` 预览推导为 `mode="viewer"`，不加载任何编辑装饰——没有坐标轴 gizmo、没有点击选中、不吞编辑快捷键；宿主 `loadDocument()` 推导为 `mode="editor"`。只想只读展示已保存场景时显式写 `mode="viewer"`（playground 首页就是这样：默认查看、点开关再进编辑）；生效值同步到 `data-mode` 供 CSS 使用。

```html
<!-- 查看器：一行，自动取景；生命周期 progress → load → error -->
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>

<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // 幂等，SSR 安全

  const el = document.querySelector("scene-editor");
  el.addEventListener("load", ({ detail }) => console.log("ready", detail.url));
  el.addEventListener("error", ({ detail }) => console.log(detail.code));
</script>
```

观看侧开关全部走属性、不写入文档：

```html
<scene-editor
  src="/models/robot.glb"
  loading="lazy"
  auto-rotate
  camera-orbit="0deg 75deg 2m"
  field-of-view="auto"
  environment-image="neutral"
  shadow-intensity="0.8"
  autoplay
  animation-name="Idle"
  reveal="interaction"
>
  <img slot="poster" src="/poster.jpg" alt="" />
  <div slot="progress-bar">加载中…</div>
  <div slot="error">模型加载失败</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">镜头</button>
</scene-editor>
```

`load` 在取景完成后才派发；失败时显示 `slot="error"`（没有该 slot 就画一条内置提示），不会留一块空白画布。
压缩资产（Draco / KTX2 / Meshopt）再多一个属性：`decoder-path="/decoders/"` 指向自托管 payload 目录，
或 `decoder-cdn` 走钉死版本的 CDN。不写也没有关系——报错会直接说缺哪种解码器，而不是留一块空白。

编辑侧由文档驱动（schema v3 的 JSON），持久化完全归宿主。文档结构、元素 API、资产、插件与保存/冲突流程见
[`packages/scene-editor/README.zh-CN.md`](packages/scene-editor/README.zh-CN.md)，符号级说明见 [`API.md`](packages/scene-editor/API.md)。

## 目录结构

```
packages/scene-editor/   npm 包（headless core + element + three 适配层）
apps/playground/         参考宿主、SDK 示例、性能基准、视觉夹具
e2e/                     Playwright 用例（critical、SDK、studio、visual、perf）
docs/                    技术架构、亮点、实测基准
scripts/                 发布元数据校验与 npm pack 冒烟测试
```

`three` 是 peer dependency，且只允许出现在 `packages/scene-editor/src/three/` 下；core 与 element 不感知渲染器。

## 开发

需要 Node 24+ 与 pnpm 11+。

```bash
pnpm install
pnpm typecheck    # 对声明了脚本的包跑 tsc
pnpm test         # 748 个 vitest 单测
pnpm build        # 每个包的 vite build + .d.ts
```

| 门禁 | 命令 | 覆盖 |
|---|---|---|
| 单元 | `pnpm test` | 81 个测试文件；CI 跑 `three` 版本矩阵（`0.186.0` + `latest`） |
| E2E | `pnpm test:e2e` | critical 流程 + SDK 场景 + studio 工具 |
| 视觉 | `pnpm test:e2e:visual` | 仅 canvas 的基线，SwiftShader，1% 容差 |
| 性能 | `pnpm test:perf` | 首帧可交互、p95 帧时间、unload-zero |
| 发布 | `pnpm test:release` | package/README/LICENSE/repository 一致性 |
| 打包 | `pnpm test:pack` | `npm pack` → 全新消费者安装/typecheck/build |

新 three minor 让 `latest` 腿变红是刻意设计的告警。Playground：`pnpm --filter @scenio/playground dev` → <http://127.0.0.1:3000>
（详见 [apps/playground/README.md](apps/playground/README.md)）。首页载入模型后默认进入**查看态**，点顶栏「编辑」才展开控制面板与 gizmo；`?mode=editor` 可直接以编辑态启动。宿主侧 API 的回归面（迁移、headless、多选命令、声明式属性、hotspot 等）已收敛到 `minimal.html?demo=<name>`：7 个场景共用同一个 HTML 入口，25 个 e2e 用例与全部 `window.__*` 钩子保持不变，独立的 `demos/` 页面已删除，覆盖一条没少。

## 状态与路线图

仓库内为 `0.7.0` alpha（尚未发布），npm `latest` 为 `0.6.0`。`1.0.0` 之前 API 仍可能调整，之后遵循 semver。

- **`0.7.0`** — schema v3：真实 `parentId` 层级、`type: "primitive"`（8 种程序化几何）、对象级 `material` 覆盖、`view.lights.additional`；`addObject` / `removeObject` / `reparent` / `setMaterial` 全部可撤销，并复用加载时的 `validateHierarchy`。
- **`0.6.0`** — 单行 glTF 预览（`src`）、自动取景、`progress`/`load` 生命周期、tone mapping / exposure、`visibility-change` 与按需开启的 `view-changing`。
- **未发布的查看器能力**（元素属性 + 可选 runtime 方法，`view` schema 未动）：`camera-orbit` / `field-of-view` 与位姿缓动、`environment-image` 预设与 HDR URL、接触阴影、glTF 内嵌相机、morph target、播放传输与 `play`/`pause`/`loop`/`finished`、带法线的 hotspot、指针灵敏度、`loaded` / `modelIsVisible`。
- **未发布的查看器性能**：占位几何/基础材质引用计数共享（5 000 个对象 11 MB 堆，各持一份为 26 MB）、资产内静态合批（200 个同材质 mesh → 1 个）、2 000 三角形以上按需加载 BVH 加速拾取（12.0 ms → 0.10 ms，独立 chunk）、单 mixer 多 clip 混播。
- **未发布的接入易用性**：宿主侧「上传 → 编辑 → 导出」样板收进 SDK——`createSceneDocument` / `createDocumentFromAsset`、`createFileBundleUrl` + `el.loadFiles()`（`assetFormatHint` 让 `blob:` URL 正确解析格式）、按文档位姿（而非预览态）导出的 `el.exportDocument()`、`downloadBlob()` 与 `el.toBlob()`。视口覆盖层也已纯属性化：`display-mode`（观察着色，跨合批生效）与 `explode`（组件分解，不写文档），另有 `LIGHTING_PRESETS` 参考布光数据可直接导入。

下一步见 [TODOS.md](TODOS.md)：查看器待补项按影响排序，另有编辑能力缺口与明确非目标（不做 CRDT 协作、插件面板槽位、按产品拆包）。

## 文档

| 文档 | 语言 | 内容 |
|---|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 简体中文 | 分层、设计取舍、亮点、实测基准 |
| [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md) | EN / 中文 | 项目概览、开发、门禁、发布 |
| [packages/scene-editor/README.md](packages/scene-editor/README.md) | English | 安装、查看器与编辑器用法、文档模型、资产、插件 |
| [packages/scene-editor/README.zh-CN.md](packages/scene-editor/README.zh-CN.md) | 简体中文 | 快速上手与核心概念 |
| [packages/scene-editor/API.md](packages/scene-editor/API.md) | English | 完整 API 参考 |
| [apps/playground/README.md](apps/playground/README.md) | English | 参考宿主与模块说明 |
| [e2e/visual/README.md](e2e/visual/README.md) | 简体中文 | 视觉回归流程 |
| [TODOS.md](TODOS.md) | 简体中文 | 待补项与非目标 |

## License

MIT，见 [LICENSE](LICENSE)。

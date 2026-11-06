# scene-studio

可嵌入网页的 3D 场景编辑器 SDK。以 [`@scenio/scene-editor`](https://www.npmjs.com/package/@scenio/scene-editor) 发布（`@scenio` 仍是占位 scope）。仓库当前版本为 `0.7.0`；npm 上最新发布版本为 `0.6.0`。

**文档：** [English](README.md) · 简体中文（本页） · [包快速上手](packages/scene-editor/README.zh-CN.md) · [API 参考](packages/scene-editor/API.md)

## 这是什么

`<scene-editor>` 是一个 Web Component，可以给任意页面嵌入一个可编辑的 3D 视口：加载 JSON 场景文档、轨道旋转/缩放、点选、gizmo 变换、撤销/重做，并通过宿主自己的传输层保存、处理结构化冲突。支持 glTF/GLB 资产与动画片段。

想自己控制 UI？`createSceneEditor()` 提供同一套编辑逻辑 —— 文档状态、历史、选择、插件、类型化事件 —— 且不依赖 DOM。渲染位于一个很小的 `RuntimeContract` 之后：单测可用 `FakeRuntime`，宿主可用 `ThreeRuntime` 或自定义 runtime。默认 WebGL2；WebGPU 通过文档化的 `rendererFactory` 接缝接入。

**当前编辑范围：** 变换、视图状态、对象的增删与改父子级、程序化几何（`primitive`）与材质覆盖，全部可撤销。对象的复制、多对象变换、morph target、HDR 环境目前不在文档 API 内。参见[状态与路线图](#状态与路线图)。

## 快速开始

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // 幂等，SSR 安全

  const el = document.querySelector("scene-editor");
  await el.ready;

  await el.loadDocument({
    schemaVersion: 3,
    sceneId: "demo",
    revision: 0,
    objects: [
      {
        id: "box-1",
        type: "mesh",
        name: "Box",
        position: [0, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    view: {
      camera: { position: [6, 5, 10], target: [0, 0, 0], fov: 60 },
      lights: {
        ambient: { color: "#ffffff", intensity: 0.55 },
        directional: { color: "#ffffff", intensity: 1, position: [5, 10, 7] },
      },
      environment: { background: null, gridVisible: true, iblIntensity: 1 },
    },
  });
</script>

<scene-editor style="width: 640px; height: 400px"></scene-editor>
```

拖拽旋转视角，滚轮缩放，点击选择（`Shift`/`Ctrl`/`Cmd` + 点击切换多选），拖动 gizmo 变换；焦点在元素内时可用 `Ctrl+Z` / `Ctrl+Shift+Z`。

### Headless

```ts
import { createSceneEditor, FakeRuntime } from "@scenio/scene-editor";

const editor = createSceneEditor({ runtime: new FakeRuntime() });

await editor.loadDocument(doc);
editor.select(["box-1"]);
editor.applyTransform("box-1", from, to); // 一条可撤销命令
editor.undo();

editor.on("save-request", ({ document }) => {
  // SDK 不访问你的后端
  fetch("/api/scene", { method: "PUT", body: JSON.stringify(document) });
});

editor.requestSave();
```

## 目录结构

```
packages/scene-editor/   npm 包（headless core + element + three adapter）
apps/playground/         参考宿主、SDK 示例、性能基准、视觉夹具
e2e/                     Playwright 用例（critical、SDK、studio、visual、perf）
scripts/                 发布元数据校验与 npm pack 冒烟测试
```

## Playground

`apps/playground` 是参考宿主，也是集成问题最先暴露的地方。它支持 GLB/GLTF/OBJ/STL（含多文件 `.gltf`）、着色模式（studio / X-Ray / 线框 / 法线 / clay）、骨骼叠加、分解预览、解析灯光与内置 IBL、背景预设、曝光与色调映射、相机预设、转台、动画播放、gizmo 工具、截图与 GLB/OBJ 导出。

查看器架构刻意保持简单：一个 `ViewerStore` 向 `ViewerController.update*()` 分发，HUD 面板只修改状态。

`/demos/` 下是聚焦单一 API 的 SDK 示例（宿主编辑 API、文档模型、headless facade、资产），由 `e2e/sdk-coverage.spec.ts` 覆盖；`minimal.html` 是最小端到端集成。

- `?scene=default` 加载确定性夹具 `box-1 / box-2 / gem-1`，e2e 依赖它。
- `?model=<id>` 直接打开 Khronos 示例模型。
- `?select=<id>` 选中对象，可配合 `&move=x,y,z&rot=x,y,z&scale=x,y,z` 生成可复现截图。
- 裸 URL 打开极简首页，提供拖拽区与示例入口。

宿主装配在 `src/main.ts`；查看器状态在 `src/viewer/`；HUD 由 `src/ui/panels/` 组合进 `src/ui/studio-shell.ts`。

## 开发

需要 Node 24+ 与 pnpm 11+。

```bash
pnpm install
pnpm typecheck           # 对声明了脚本的包跑 tsc
pnpm test                # vitest 单元测试
pnpm build               # 每个包的 vite build + .d.ts
```

### E2E 与质量门禁

```bash
pnpm test:e2e            # 全量：critical + visual + perf
pnpm test:e2e:visual     # 只跑视觉回归（SwiftShader，仅 canvas）
pnpm test:perf           # 首帧交互 + p95 帧时间门禁
pnpm test:release        # package/README/LICENSE/repository 一致性
pnpm test:pack           # npm pack -> 全新消费者安装/typecheck/build
```

CI（`.github/workflows/ci.yml`）会跑 `three` 版本矩阵（固定 `0.186.0` + `latest`）单元测试、critical e2e、视觉回归门禁、放宽阈值的性能门禁、发布元数据校验和 pack 冒烟。新 three minor 让 `latest` 腿变红是刻意设计的告警。

### Playwright 说明

- 配置：`e2e/playwright.config.ts`。Projects：`chromium`（critical）、`visual`（软件渲染截图，CI 强制）、`perf`（单独运行，避免帧时间争用）。
- 本地运行复用 4173 端口上已启动的开发服务器；CI 自行拉起。
- 视觉基线在 `e2e/visual/__screenshots__/visual/`。基线由 SwiftShader 渲染且只包含 canvas，不依赖宿主 GPU 或字体。更新方式：`pnpm test:e2e:visual --update-snapshots`，审阅后提交 PNG。

## 版本与发布

- 每个完成的阶段提升 minor（`0.x.0`）并打 tag；公开 API 锁定后发布 `1.0.0`。
- 推送与包版本一致的 `0.*` tag 会触发 `.github/workflows/publish.yml`（预发布走 `next`，稳定版走 `latest`）。
- `pnpm test:release` 保证 package 元数据、README 版本与状态、LICENSE、repository URL 一致；CI 与发布前都会执行。
- `npm pack` 必须保持绿色（`pnpm test:pack`），它是面向消费者包内容的发布门禁。

## 状态与路线图

仓库内为 `0.7.0` alpha（尚未发布），npm `latest` 为 `0.6.0`。`1.0.0` 之前 API 仍可能调整，之后遵循 semver。

`0.7.0` 把文档升到 schema v3：`parentId` 现在会建立真实的 three.js 父子关系（group 不再被丢弃），`type: "primitive"` 支持八种程序化几何，对象级 `material` 覆盖可持久化，`view.lights.additional` 接受 point/spot/directional/hemisphere 灯。v2 文档自动迁移；因为新字段全部可选，迁移后的载荷与原文逐字节等价。

同一版本补齐了写操作：`addObject` / `removeObject` / `reparent` / `setMaterial` 都是可撤销命令，并复用加载文档时的同一套 `validateHierarchy`，因此重复 id、缺失父级、自指与成环在编辑时就被拒绝。

`0.6.0` 补齐了预览主链路：`<scene-editor src>` 单行预览、自动取景、`progress`/`load` 生命周期事件、tone mapping / exposure 显示设置，以及 `visibility-change` 与按需开启的 `view-changing` 元素事件。

计划中的下一步（[TODOS.md](TODOS.md)）：

- HDR 环境贴图与环境预设。
- 切换到 glTF 资产内嵌相机。
- Morph target 控制。

成为通用场景编辑器之前仍缺：

- 对象的复制与多对象变换。
- playground 的材质面板仍需改为走 `setMaterial`（目前在直接改运行时）。

明确不做：CRDT/实时多人协作、插件面板槽位、按产品拆包。

## 文档

| 文档 | 语言 | 内容 |
|---|---|---|
| [README.md](README.md) | English | 项目概览、开发、发布 |
| [README.zh-CN.md](README.zh-CN.md) | 简体中文 | 项目概览、开发、发布 |
| [packages/scene-editor/README.md](packages/scene-editor/README.md) | English | 安装、使用、文档模型、资产、插件 |
| [packages/scene-editor/README.zh-CN.md](packages/scene-editor/README.zh-CN.md) | 简体中文 | 快速上手与核心概念 |
| [packages/scene-editor/API.md](packages/scene-editor/API.md) | English | 完整 API 参考 |
| [apps/playground/README.md](apps/playground/README.md) | English | 参考宿主与模块说明 |
| [e2e/visual/README.md](e2e/visual/README.md) | 简体中文 | 视觉回归流程 |
| [TODOS.md](TODOS.md) | 简体中文 | 路线图与明确非目标 |

## License

MIT，见 [LICENSE](LICENSE)。

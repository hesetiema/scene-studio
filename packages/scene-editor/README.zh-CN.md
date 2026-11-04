# @scenio/scene-editor（中文说明）

可嵌入网页的 3D 场景编辑器 SDK：文档模型、选择、gizmo 变换、撤销/重做，以及宿主驱动的保存/冲突流程。

> 英文完整文档见 [README.md](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/README.md)，完整 API 见 [API.md](https://github.com/hesetiema/scene-studio/blob/main/packages/scene-editor/API.md)。本页是中文快速上手与核心概念。

**状态：** 仓库内为 `0.6.0` alpha；npm 最新版本是 `0.3.0`，`0.4.0`–`0.6.0` 尚未发布。`1.0.0` 之前 API 仍可能调整。

**编辑范围：** 变换与视图状态；对象增删/改父子级、材质写入文档、morph target、HDR 环境尚未进入文档 API。

- 仓库：<https://github.com/hesetiema/scene-studio>
- 问题反馈：<https://github.com/hesetiema/scene-studio/issues>

## 安装

```bash
npm install @scenio/scene-editor three
# 或
pnpm add @scenio/scene-editor three
```

`three@^0.186.0` 是 peer dependency，需要自行安装。

> 本页跟随仓库 `0.6.0`。`npm install` 目前安装到 `0.3.0`；想使用未发布功能，请从源码构建（`pnpm install && pnpm build`），再打包 `packages/scene-editor`。

## 入口

| 导入 | 内容 | 场景 |
|---|---|---|
| `@scenio/scene-editor/element` | `<scene-editor>` 自定义元素 + `defineSceneEditor()` | 大多数集成，推荐 |
| `@scenio/scene-editor` | `createSceneEditor()`、schema、命令、错误、资产、插件类型 | Headless 编辑、自定义 runtime、服务端校验 |
| `@scenio/scene-editor/three` | `ThreeRuntime`、可组合的 viewer rigs、picker、控制器绑定 | 自定义渲染或场景图装配 |
| `@scenio/scene-editor/style.css` | 元素所需的最小样式 | 配合 element 入口 |

## 快速开始

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // 幂等，SSR 安全

  const el = document.querySelector("scene-editor");
  await el.ready;

  await el.loadDocument({
    schemaVersion: 2,
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

拖拽旋转，滚轮缩放，点击选择（`Shift`/`Ctrl`/`Cmd` + 点击多选），拖动 gizmo 变换；焦点在元素内时支持 `Ctrl+Z` / `Ctrl+Shift+Z`。

## 一行预览 glTF

只需要展示模型时，可以不写文档：

```html
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>
```

元素会自动合成单对象文档、自动取景，并通过 `progress` → `load` 上报生命周期（`load.detail.url` 为加载源）。预览默认使用 ACES 色调映射，可用 `tone-mapping="none"` 关闭；容器尺寸变化后可调用 `frameModel()` 重新取景。显式 `loadDocument()` 仍然优先，直到 `src` 再次变化。

```ts
el.addEventListener("progress", ({ detail }) => setBar(detail.totalProgress));
el.addEventListener("load", ({ detail }) => console.log("ready", detail.url));
el.addEventListener("error", ({ detail }) => showError(detail.code));
```

## Headless

```ts
import { createSceneEditor, FakeRuntime } from "@scenio/scene-editor";

const editor = createSceneEditor({ runtime: new FakeRuntime() });

await editor.loadDocument(doc);
editor.select(["box-1"]);
editor.applyTransform("box-1", from, to); // 一条可撤销命令
editor.undo();

editor.on("save-request", ({ document, revision }) => {
  fetch("/api/scene", { method: "PUT", body: JSON.stringify(document) })
    .then((r) => r.json())
    .then(({ revision }) => editor.markSaved(revision));
});

editor.requestSave();
```

`createSceneEditor({ runtime })` 必须传入 runtime：单测用 `FakeRuntime`，生产用 `ThreeRuntime`，也可以实现自己的 `RuntimeContract`。事件包括 `selection-change`、`history-change`、`document-dirty`、`save-request`、`view-change`、`view-changing`（需开启）、`error`。

Element 额外提供两个 DOM 专属事件：`visibility-change`（进入/离开视口，`{ visible: boolean }`）和恒有的 `scene-ready`。`view-changing` 是高频相机采样，需要 `<scene-editor live-view-events>` 显式开启；持久化请用 `view-change`。完整契约（含冒泡/合成/可取消均为 `false` 与版本策略）见 [API.md](API.md#element-events-customevent)。

## 文档模型

场景是普通 JSON，由 zod 校验：

```ts
type SceneDocument = {
  schemaVersion: 2;
  sceneId: string;
  revision: number; // 宿主权威版本号
  objects: SceneObjectDTO[];
  view: {
    camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
    lights: {
      ambient: { color: "#rrggbb"; intensity: number };
      directional: { color: "#rrggbb"; intensity: number; position: [number, number, number] };
    };
    environment: {
      background: "#rrggbb" | null;
      gridVisible: boolean;
      iblIntensity?: number; // 缺省 1；0 = 只用解析灯光
    };
  };
};

type SceneObjectDTO = {
  id: string;
  type: "mesh" | "group";
  name: string;
  assetId?: string;
  parentId?: string;
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ，弧度
  scale: [number, number, number];
  metadata?: Record<string, unknown>;
};
```

- v1 文档加载时会自动迁移并补全 `view` 默认值。
- 相机/灯光/环境变化会把文档标记为 dirty，但**不进入撤销栈**。
- 文档中的 `view` 只在新 `sceneId` 加载时应用；同一场景回流不会打断当前视角。
- 实时视口状态用 `getViewState()` 读取；文档保存的是最后一次记录的视图。

## 保存与冲突

SDK 不访问后端，持久化完全由宿主负责：

1. 编辑后 `dirty: true`，宿主 UI 启用保存。
2. 宿主调用 `el.requestSave()`，拿到文档并 PUT 到自己的 API。
3. 成功后调用 `el.markSaved(serverRevision)`，清除 dirty 并采用服务端 revision。
4. revision 不匹配时服务端拒绝；宿主用结构化冲突（`base` / `incoming` / `local`）让用户决定。SDK 不会自动合并。

`applyRemote()` 对入站更新遵循同一规则：只有在文档干净且 `revision === baseRevision + 1` 时才快进，否则抛出 `conflict`。

## 资产

对象通过 `assetId` 引用资产，URL 与传输由宿主决定：

```ts
el.assetResolver = {
  async resolve(assetId) {
    return `/api/assets/${assetId}.glb`; // 或签名 URL
  },
};
```

- 内置 glTF loader 支持 `.glb` / `.gltf`；Draco/KTX2 通过注入 loader 启用。
- `AssetCache` 按 `assetId` 引用计数：并发加载合并，最后一个引用释放时 dispose，下次 retain 重新加载。
- 不要把 `assetId` 直接拼进 URL；使用白名单映射，避免文档指向任意地址。

## 错误

所有 SDK 失败都是类型化的。Element 通过 `error` 事件上报：

```ts
el.addEventListener("error", (e) => {
  const { code, message } = (e as CustomEvent).detail;
  // code 是稳定字符串，按 code 分支，不要解析 message
});
```

- `SceneErrorCode`：`validation`、`asset-resolve-failed`、`asset-load-failed`、`render-init-failed`、`lifecycle`、`conflict`。
- `AssetErrorCode`：`asset-not-found`、`asset-resolve-failed`、`asset-load-failed`、`asset-unsupported-format`、`asset-disposed`。

## 插件

```ts
import type { SceneEditorPlugin } from "@scenio/scene-editor";

const logger: SceneEditorPlugin = {
  id: "logger",
  install({ editor, on, addDisposer }) {
    const off = on("selection-change", ({ ids }) => console.log("selected", ids));
    addDisposer(off);
  },
};

el.use(logger);
el.unuse("logger");
```

插件上下文提供 `runtime`、`editor`、`on()` 与 `addDisposer()`；重复 `id` 会抛错，connect 前调用 `use()` 会排队到初始化后安装。

## 兼容性

| 维度 | 支持 | 验证方式 |
|---|---|---|
| `three` | `^0.186.0`（peer） | CI 固定 `0.186.0` + `latest` 矩阵 |
| 渲染器 | WebGL2 默认；WebGPU 通过 `rendererFactory` | WebGL2 为 CI 路径；WebGPU 由宿主负责 |
| 格式 | `.glb`、`.gltf` | 单测 + e2e；Draco/KTX2 可选注入 |
| 浏览器 | 支持 WebGL2 + ES modules 的浏览器 | Playwright（CI 为 Chromium） |
| 模块 | 仅 ESM | `pnpm test:pack` 消费测试 |
| SSR | Element 延迟注册，导入无 DOM 副作用 | 单测 + pack 冒烟 |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:release
pnpm build
pnpm test:e2e
pnpm test:e2e:visual
pnpm test:perf
pnpm test:pack
```

## License

MIT，见 [LICENSE](LICENSE)。

# @scenio/scene-editor（中文说明）

可嵌入网页的 3D 场景编辑器与模型查看器。一个 `<scene-editor>`，两种形态：给它一个 `src` 就是**查看器**，
全部靠属性配置、页面不用写 JavaScript；用 `loadDocument()` 给它一份文档就是**编辑器**，带选择、gizmo 变换、
撤销/重做和宿主驱动的保存流程。两种形态共用同一套文档模型与 runtime 契约，查看器要升级成编辑器不必重写。

**状态：** 仓库内为 `0.7.0` alpha（尚未发布），npm `latest` 为 `0.6.0`。`1.0.0` 之前 API 仍可能调整，
之后遵循 semver。`three` 是需要你自己安装的 peer dependency。

> `@scenio` 只是占位 scope，发布前会换成正式的组织名。

仓库：<https://github.com/hesetiema/scene-studio> · 问题反馈：<https://github.com/hesetiema/scene-studio/issues>

**文档：** 简体中文（本页） · [English](README.md) · [API 参考](API.md) · [技术架构与基准](https://github.com/hesetiema/scene-studio/blob/main/docs/ARCHITECTURE.md)

## 安装

执行 `npm install @scenio/scene-editor three`（或 `pnpm add @scenio/scene-editor three`），`three@^0.186.0`
是 peer dependency。然后在应用入口**注册一次**元素：
`import { defineSceneEditor } from "@scenio/scene-editor/element"; defineSceneEditor();` —— 幂等、
SSR 安全。之后下面的一切都只是声明式 HTML 或普通 DOM 代码。

包**不提供任何 CSS**。`<scene-editor>` 是没有默认样式的自定义元素，宿主需要自己给它块级盒子与尺寸
（`scene-editor { display: block; height: 480px }`，或用下面两个例子里的内联 `style`）。元素只负责摆好
自己的画布、poster 与 slot，盒子之外的样式全归宿主。

## 例子一：查看器 —— 只写属性，不写 JS

`src` 会合成一份单对象文档、按 `<model-viewer>` 的方式取景，并通过 `progress` → `load` → `error`
上报生命周期。预览态恒为 `mode="viewer"`：没有地面网格、没有 gizmo、不能点选、不吞编辑快捷键。
观看侧开关**全是属性，且从不写入文档**。

```html
<scene-editor
  src="/models/robot.glb"
  style="display: block; width: 100%; height: 480px"
  loading="lazy"
  auto-rotate
  camera-orbit="0deg 75deg 2m"
  field-of-view="auto"
  environment-image="neutral"
  tone-mapping="neutral"
  shadow-intensity="0.8"
  autoplay
  reveal="interaction"
  alt="示例机器人"
>
  <img slot="poster" src="/poster.jpg" alt="" />
  <div slot="progress-bar">加载中…</div>
  <div slot="error">模型加载失败</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">镜头</button>
</scene-editor>
```

`src` **只在元素连接时读取一次**：请写在 markup 里（或在连接前设置）。连接后再改不会生效——
想展示另一个模型就替换元素；文档由宿主管理时用 `loadDocument()`。

| 分组 | 属性 |
|---|---|
| 形态 | `mode`（`viewer` \| `editor`）——不写时自动推导：`src` 预览为 viewer，`loadDocument()` 为 editor；生效值同步到 `data-mode` |
| 加载 | `src`、`loading="lazy"`、`with-credentials`、`reveal`（`auto`/`interaction`/`manual`）、`seamless-poster`、`decoder-path`、`decoder-cdn` |
| 相机 | `camera-orbit`、`camera-target`、`field-of-view`、`min/max-field-of-view`、`min/max-camera-orbit`、`camera-damping`、`interpolation-decay` |
| 旋转 | `auto-rotate`、`rotation-per-second`、`auto-rotate-delay` |
| 输入 | `disable-pan`、`disable-zoom`、`disable-tap`、`orbit-sensitivity`、`zoom-sensitivity`、`pan-sensitivity`、`touch-action` |
| 观感 | `tone-mapping`、`exposure`、`display-mode`（`studio`/`xray`/`wireframe`/`normal`/`clay`）、`explode`（`0..1`）、`environment-image`、`skybox-image`、`shadow-intensity`、`shadow-softness` |
| 内容 | `variant-name`、`camera-name`、`animation-name`、`animation-crossfade-duration`、`autoplay`、`pause-at-end` |
| 无障碍 | `alt`（同步到画布的 `aria-label`） |

画布默认透明，`background: null` 时露出页面底色。`load` 在**取景之后**才派发，所以在回调里读
`getDimensions()` 拿到的就是最终相机与尺寸。失败会显示 `slot="error"`（没有该 slot 时元素自绘提示），
不会留一块空白画布；Draco / KTX2 / Meshopt 在设置 `decoder-path` 或 `decoder-cdn` 后才按需装配。
`display-mode` 与 `explode` 是纯视口覆盖层，不会出现在导出文件里。查看器的装饰件沿用 model-viewer 的
slot 名：`slot="poster"` / `slot="progress-bar"` / `slot="error"` / `slot="hotspot-*"`。

## 例子二：编辑器 —— 站在宿主视角接入

文档、后端、按钮都归宿主所有。SDK 不碰你的 API：它只发 `save-request`，然后等你调用
`markSaved(revision)`。下面就是一次完整接入——从自己的接口取场景、接三个按钮、落库、把失败显示出来。

```html
<scene-editor id="editor" style="display: block; width: 100%; height: 600px"></scene-editor>
<button id="undo" disabled>撤销</button>
<button id="redo" disabled>重做</button>
<button id="save" disabled>保存</button>
<p id="status" role="status"></p>

<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";

  defineSceneEditor(); // 幂等，SSR 安全

  const el = document.querySelector("#editor");
  const status = document.querySelector("#status");
  const undoBtn = document.querySelector("#undo");
  const redoBtn = document.querySelector("#redo");
  const saveBtn = document.querySelector("#save");

  // 文档由你的后端持有。loadDocument() 校验 schema v3（v1/v2 自动迁移），
  // 并把同一个元素切到编辑器模式。
  const response = await fetch("/api/scenes/42");
  if (!response.ok) throw new Error(`场景加载失败：${response.status}`);
  await el.ready;
  await el.loadDocument(await response.json());

  // SDK 只请求持久化，不发请求、不重试、不合并。
  el.addEventListener("save-request", async ({ detail }) => {
    const res = await fetch(`/api/scenes/${detail.document.sceneId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(detail.document),
    });
    if (!res.ok) {
      status.textContent = `保存失败（${res.status}），你的修改还在`;
      return; // 不调 markSaved → 仍是 dirty，保存按钮保持可用
    }
    const { revision } = await res.json();
    el.markSaved(revision); // 清 dirty，采用服务端 revision
  });

  el.addEventListener("history-change", ({ detail }) => {
    undoBtn.disabled = !detail.canUndo;
    redoBtn.disabled = !detail.canRedo;
    saveBtn.disabled = !detail.dirty;
  });
  el.addEventListener("document-dirty", ({ detail }) => {
    saveBtn.disabled = !detail.dirty; // 视角/灯光也会置脏，但不进撤销栈
  });
  el.addEventListener("error", ({ detail }) => {
    status.textContent = `${detail.code}：${detail.message}`;
  });

  undoBtn.addEventListener("click", () => el.undo());
  redoBtn.addEventListener("click", () => el.redo());
  saveBtn.addEventListener("click", () => el.requestSave());
</script>
```

用户看到的就是：拖拽旋转、滚轮缩放、点击选择（`Shift`/`Ctrl`/`Cmd` + 点击多选）、拖 gizmo 变换，
焦点在元素内时 `Ctrl+Z` / `Ctrl+Shift+Z`。同一份文档加上 `mode="viewer"` 就变成只读视口，
适合「把已保存的场景展示出来」，不必再套一层编辑器 UI。

如果你的后端还没有存完整的场景文档，用 core 入口的 `createSceneDocument()`（单个模型用
`createDocumentFromAsset()`）生成，不必手写六字段信封；服务端可以用 `parseSceneDocument()`
跑同一套校验。

### 保存与冲突

1. 用户编辑 → `dirty: true` → 宿主把「保存」按钮置为可用。
2. `el.requestSave()`（或其它来源的 `save-request`）→ 把 `detail.document` PUT 给你的 API。
3. 成功后调用 `el.markSaved(serverRevision)`：dirty 清零，revision 采用服务端值。
4. revision 冲突时由服务端拒绝，宿主展示结构化冲突（`base` / `incoming` / `local`）让用户决定，
   SDK 不自动合并；入站更新走 `applyRemote()`，规则相同。

### 事件

全部是元素上的 `CustomEvent`，不冒泡、不合成。

| 事件 | detail | 时机 |
|---|---|---|
| `scene-ready` | — | 初始化完成，画布与 runtime 就绪 |
| `progress` | `{ totalProgress, reason }` | 加载进度，单调 0..1 |
| `load` | `{ sceneId, url }` | 内容挂载并完成取景 |
| `selection-change` | `{ ids }` | 选择变化 |
| `history-change` | `{ canUndo, canRedo, dirty, lastCommand? }` | 命令执行 / 撤销 / 重做 |
| `document-dirty` | `{ dirty }` | dirty 在 false↔true 之间翻转 |
| `save-request` | `{ reason, document, revision }` | 宿主应当持久化 |
| `view-change` | `{ view, source }` | 视角稳定（`interaction`/`api`/`load`） |
| `view-changing` | `{ view }` | 相机运动中的采样，需 `live-view-events` 开启 |
| `camera-change` | `{ position, target, fov }` | 相机移动，常开 |
| `environment-change` | `{ environment, source }` | 背景 / 网格 / IBL / HDR / 阴影变化 |
| `model-visibility` | `{ visible }` | `loaded × 视口内 × 海报已消失` |
| `visibility-change` | `{ visible }` | 元素进入 / 离开视口 |
| `play` / `pause` / `loop` / `finished` | 播放传输数据 | clip 开始、停止、循环、播完 |
| `error` | `{ code, message, cause? }` | 任何 SDK 失败，可靠的失败通道 |

持久化用 `view-change`；`view-changing` 给实时消费方（远程相机同步、录制、HUD）。

### 文档模型

场景是普通 JSON，由 zod 校验，不持久化任何 GPU 相关内容。顶层六个字段：`schemaVersion`（3）、
`sceneId`、`revision`、`objects`、`view`。`objects` 可以是 `mesh` / `group` / `primitive`
（8 种程序化几何），可带 `assetId`、`parentId`、部分 `material` 覆盖、`position` / `rotation` /
`scale` 与 `metadata`。`view` 含 `camera`、`lights`（环境光 + 平行光 + 可选附加灯）与
`environment`（背景、网格、IBL 强度）。`parentId` 建立真实的 three.js 父子关系：父加载失败时子提升为根，
成环时断开。`addObject` / `removeObject` / `reparent` / `setMaterial` 全部可撤销，并复用装载时的层级
校验；同一对象的连续写入会合并成一步撤销。视角编辑会置脏但不进撤销栈。字段级签名见
[API.md](API.md#document-schema-zod)。

### 其余能力（不另给例子）

- **资产**：对象只带 `assetId`、不带 URL；`el.assetResolver` 负责映射，也是你的信任边界——用白名单，
  不要把 id 直接拼进路径。`AssetCache` 按 id 引用计数，并发加载合并、最后一个引用释放时 dispose。
  支持 `.glb` / `.gltf`，Draco / KTX2 / Meshopt 通过 `decoder-path` 或 `decoder-cdn` 按需装配。
- **上传 / 导出 / 截图**：`el.loadFiles(files)` 复用 `src` 的进度 / 取景 / 错误链路（`.gltf` 的外部
  buffer 与贴图会改写成 blob URL）；`el.exportDocument({ format })` 默认按**文档位姿**导出
  `glb` / `gltf` / `obj`，预览态偏移不会泄漏；`el.toBlob()` 配 `downloadBlob()` 做截图。
  `LIGHTING_PRESETS` 以数据形式提供四套参考布光。
- **Headless**：core 入口的 `createSceneEditor({ runtime: new FakeRuntime() })` 在无 DOM 下跑同一套
  文档 / 历史 / 选择 / 保存链路，UI、自定义命令（`executeCommand()`）与按键映射（`handleKeyDown()`）
  都由宿主提供。
- **插件**：形如 `{ id, install(context) }` 的普通对象，context 提供 `runtime`、`editor`、
  `on(type, handler)`、`addDisposer(fn)`；`el.use(plugin)` / `el.unuse(id)`。
- **WebGPU**：默认 WebGL2，可通过 `SceneEditorElement.runtimeFactory` 接入，返回 `ThreeRuntime`
  前必须 `await renderer.init()`。
- **错误**：按 `code` 分支，不要解析 message。`SceneErrorCode`：`validation`、
  `asset-resolve-failed`、`asset-load-failed`、`render-init-failed`、`lifecycle`、`conflict`；
  `AssetErrorCode`：`asset-not-found`、`asset-resolve-failed`、`asset-load-failed`、
  `asset-unsupported-format`、`asset-disposed`。

### 入口

| 导入 | 内容 | 场景 |
|---|---|---|
| `@scenio/scene-editor/element` | `<scene-editor>` + `defineSceneEditor()` | 大多数集成（查看器 + 编辑器） |
| `@scenio/scene-editor` | `createSceneEditor()`、schema、命令、错误、资产、插件类型 | Headless 编辑、自定义 runtime、服务端校验 |
| `@scenio/scene-editor/three` | `ThreeRuntime`、可组合的 viewer rigs、picker、控制器绑定 | 自定义渲染或场景图装配 |

### 兼容性

| 维度 | 支持 | 验证 |
|---|---|---|
| `three` | `^0.186.0`（peer） | CI 固定 `0.186.0` + `latest` 矩阵 |
| 渲染器 | WebGL2 默认，WebGPU 走 `rendererFactory` | WebGL2 为 CI 路径，WebGPU 由宿主选择 |
| 格式 | `.glb` / `.gltf` | 单测 + e2e；Draco/KTX2 可选注入 |
| 浏览器 | WebGL2 + ES modules | Playwright e2e（CI 为 Chromium） |
| 模块 | 仅 ESM | `npm pack` 消费者冒烟 |
| SSR | 元素延迟注册，导入无 DOM 副作用 | 单测 + pack 冒烟 |

新 three minor 让 `latest` 腿变红是刻意的早期告警，不是构建坏了。

## 开发

在仓库根目录执行 `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm test:e2e` /
`pnpm test:release` / `pnpm test:pack`。参考宿主在 `apps/playground`。

## License

MIT，见 [LICENSE](LICENSE)。

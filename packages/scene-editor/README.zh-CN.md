# @scenio/scene-editor（中文说明）

可嵌入网页的 3D 场景编辑器与模型查看器：文档模型、选择、gizmo 变换、撤销/重做，以及宿主驱动的保存/冲突流程。
一个 `runtime` 契约背后是可替换的渲染层，查看器与编辑器共用同一套加载/选择/历史链路。

**状态：** 仓库内为 `0.7.0` alpha（尚未发布），npm `latest` 为 `0.6.0`。`1.0.0` 之前 API 仍可能调整。

> 完整文档：[英文 README](README.md) · [API 参考](API.md) · [技术架构与基准](https://github.com/hesetiema/scene-studio/blob/main/docs/ARCHITECTURE.md)。本页是中文快速上手。

## 安装

```bash
npm install @scenio/scene-editor three   # three 是 peer dependency
```

## 入口

| 导入 | 内容 | 场景 |
|---|---|---|
| `@scenio/scene-editor/element` | `<scene-editor>` + `defineSceneEditor()` | 大多数集成（查看器 + 编辑器） |
| `@scenio/scene-editor` | `createSceneEditor()`、schema、命令、错误、资产、插件类型 | Headless 编辑、自定义 runtime、服务端校验 |
| `@scenio/scene-editor/three` | `ThreeRuntime`、可组合的 viewer rigs、picker、控制器绑定 | 自定义渲染或场景图装配 |
| `@scenio/scene-editor/style.css` | 元素所需的最小样式 | 配合 element 入口 |

## 查看器：一行预览 glTF

```html
<scene-editor src="/models/robot.glb" style="height: 480px"></scene-editor>
```

元素会合成单对象文档、按 model-viewer 的方式取景，并通过 `progress` → `load` → `error` 上报生命周期。
预览态按 **viewer** 处理：没有地面网格，`field-of-view="auto"`（横向 30° / 纵向 45°），只由环境贴图照明，
**也没有编辑交互**——没有坐标轴 gizmo、没有点击选中、不吞编辑快捷键；显式 `loadDocument()` 会把同一个元素切成
编辑器，只想只读展示宿主文档时用 `mode="viewer"`。

```html
<scene-editor
  src="/models/robot.glb"
  loading="lazy"
  auto-rotate
  camera-orbit="0deg 75deg 2m"
  min-camera-orbit="auto 60deg 2m"
  max-camera-orbit="auto 100deg 12m"
  environment-image="neutral"
  tone-mapping="neutral"
  shadow-intensity="0.8"
  autoplay
  animation-name="Idle"
  animation-crossfade-duration="300"
  pause-at-end
  reveal="interaction"
  alt="示例模型"
>
  <img slot="poster" src="/poster.jpg" alt="加载中" />
  <div slot="progress-bar">加载中…</div>
  <div slot="error">模型加载失败</div>
  <button slot="hotspot-lens" data-position="0 1.2 0.4" data-normal="0 0 1">镜头</button>
</scene-editor>
```

- 观看侧开关**全部走属性，从不写入文档**；画布默认透明，`background: null` 时露出页面底色。
- `mode`（`viewer` | `editor`）：不写时自动推导——`src` 预览是 viewer，`loadDocument()` 是 editor；生效值同步到 `data-mode` 供 CSS 使用。viewer 保留轨道/缩放，去掉 gizmo 与点选，切到 viewer 时会清空选择。
- 属性分组：加载（`src`/`loading`/`with-credentials`/`reveal`/`seamless-poster`）、相机（`camera-orbit`/`camera-target`/`field-of-view`/`min|max-camera-orbit`/`camera-damping`/`interpolation-decay`）、旋转（`auto-rotate`/`rotation-per-second`/`auto-rotate-delay`）、输入（`disable-pan|zoom|tap`/各 `*-sensitivity`/`touch-action`）、观感（`tone-mapping`/`exposure`/`environment-image`/`skybox-image`/`shadow-intensity`/`shadow-softness`/`display-mode`/`explode`）、内容（`variant-name`/`camera-name`/动画四项）、无障碍（`alt`）。
- 视口覆盖层纯属性可用：`display-mode="xray|wireframe|normal|clay"` 切观察着色（覆盖材质由包管理、合批实例同样生效、`studio` 精确还原），`explode="0.3"` 组件分解（只动运行时、不写文档、归零精确复位）。两者都是预览态，不会出现在 `exportDocument()` 的产物里。
- `load` 在取景（`frameViewer()`）之后才派发：在回调里读 `getDimensions()` 或相机，拿到的就是取景后的状态。
- 失败有视觉出口：`slot="error"` 在 `error` / 初始化失败时盖住画布，没有该 slot 时元素自己画一条提示；下一次加载成功后自动清除。
- 裁剪面跟随内容：`near/far` 每帧按「相机到目标距离 + 内容半径」重算，毫米级 CAD 与公里级地形都不会被裁掉。
- 默认值：预览 `tone-mapping="neutral"`（model-viewer `auto` 在 glTF 上的解析结果）、`environment-image="neutral"`。
- 截图/导出对齐 model-viewer：`getDimensions()`、`positionAndNormalFromPoint()`、`queryHotspot()`、`toDataURL()`、`toBlob()`、`exportScene()`、`frameModel()`、`dismissPoster()`；文档级导出与文件落盘见[「上传 / 导出 / 截图」](#上传--导出--截图)。

## 编辑器

```html
<script type="module">
  import { defineSceneEditor } from "@scenio/scene-editor/element";
  import "@scenio/scene-editor/style.css";

  defineSceneEditor(); // 幂等，SSR 安全
  const el = document.querySelector("scene-editor");
  await el.ready;

  // 也可以不手写信封：createSceneDocument / createDocumentFromAsset 见下节
  await el.loadDocument({
    schemaVersion: 3,
    sceneId: "demo",
    revision: 0,
    objects: [
      { id: "box-1", type: "mesh", name: "Box", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
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

拖拽旋转、滚轮缩放、点击选择（`Shift`/`Ctrl`/`Cmd` + 点击多选）、拖 gizmo 变换；焦点在元素内时支持
`Ctrl+Z` / `Ctrl+Shift+Z`。以上全部只在编辑器模式生效：同一份文档加 `mode="viewer"` 就得到只读视口
（可轨道、可缩放，没有坐标轴、没有选择），用于"把已保存的场景展示出来"。主要方法：`loadDocument` /
`getDocument` / `select` / `applyTransform` / `addObject` / `removeObject` / `reparent` / `setMaterial` /
`undo` / `redo` / `requestSave` / `markSaved` / `applyRemote` / `getViewState` / `setViewState` /
`executeCommand` / `use` / `unuse`。符号级签名见 [API.md](API.md)。

### 事件

全部是元素上的 `CustomEvent`，不冒泡、不合成：`scene-ready`、`progress`、`load`、`selection-change`、
`history-change`、`document-dirty`、`save-request`、`view-change`（`source` 区分 `interaction`/`api`/`load`）、
`view-changing`（需 `live-view-events`）、`camera-change`（常开）、`environment-change`、`model-visibility`
（`loaded × 视口内 × 海报已消失`）、`visibility-change`、`play`/`pause`/`loop`/`finished`、`error`。

持久化请用 `view-change`；`view-changing` 给实时消费方（远程相机同步、录制、HUD）。

## 保存与冲突

SDK 不访问后端：编辑 → `dirty` → 宿主 `requestSave()` → 成功后 `markSaved(serverRevision)`；revision
不匹配时服务端拒绝，宿主用结构化冲突（`base` / `incoming` / `local`）让用户决定，SDK 不自动合并。
`applyRemote()` 对入站更新遵循同一规则。

## Headless

```ts
import { createSceneEditor, FakeRuntime } from "@scenio/scene-editor";

const editor = createSceneEditor({ runtime: new FakeRuntime() }); // runtime 必传
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

`executeCommand()` 是一等入口：宿主自定义的可撤销动作与 gizmo 拖拽共用一条历史。按键映射用
`handleKeyDown(event)`（返回 `true` 表示已消费）。

## 文档模型

场景是普通 JSON，由 zod 校验（`SceneDocumentSchema`）。要点：

- `schemaVersion: 3`，v1/v2 自动迁移；v3 只新增可选字段，所以 v2 迁移后载荷不变。
- `parentId` 建立真实的 three.js 父子关系：父加载失败时子对象提升为根，成环时断开。
- `type: "primitive"` 渲染 8 种程序化几何（`box`/`sphere`/`cylinder`/`cone`/`torus`/`plane`/`capsule`/`icosahedron`）。
- `material` 只写入声明的字段，且按实例 clone，不会污染资产缓存或其他实例。
- 相机/灯光/环境变化会把文档标记 dirty，但不进撤销栈；文档 `view` 只在新 `sceneId` 加载时应用。
- 对象写操作全部可撤销，并复用加载时的 `validateHierarchy`；连续写入会合并成一步（`Command.mergeWith`）。
- `environment.iblIntensity` 驱动内置 `RoomEnvironment` IBL，`0` 表示只用解析灯光。

完整字段表见 [英文 README](README.md#document-model) 或 [API.md](API.md#document-schema-zod)。

## 资产

```ts
el.assetResolver = {
  async resolve(assetId) {
    return `/api/assets/${assetId}.glb`; // 或签名 URL
  },
};
```

支持 `.glb` / `.gltf`。压缩资产开箱可用：`decoder-path` 指向 three 的 payload 目录（`<base>/draco/gltf` +
`<base>/basis`），或者直接加 `decoder-cdn`，Draco / KTX2 / Meshopt 会在首次加载时按需装配，之前零请求；
宿主仍可用 `el.dracoLoader` / `el.ktx2Loader` / `el.meshoptDecoder` 覆盖单个格式。
`AssetCache` 按 `assetId` 引用计数：并发加载合并，最后一个引用释放时 dispose。**不要把 `assetId` 直接拼进 URL**，用白名单映射。

## 上传 / 导出 / 截图

「上传 → 编辑 → 导出」闭环不需要宿主写样板：

```ts
import { defineSceneEditor, downloadBlob } from "@scenio/scene-editor/element";
import { createSceneDocument, createDocumentFromAsset } from "@scenio/scene-editor";

// 1) 建文档（六字段信封、view 以 ViewPatch 合并到默认值、对象深拷贝）
const doc = createSceneDocument({
  objects: [{ id: "box-1", name: "Box", position: [0, 0.5, 0] }],
  view: { camera: { position: [6, 5, 10] } },
});
const single = createDocumentFromAsset({ assetId: "robot", name: "Robot" });

// 2) 上传本地文件（.gltf 包的外部 buffer/贴图会换成 blob: URL，进度/取景/错误态复用 src 链路）
await el.loadFiles([file]); // File | File[] | FileList

// 3) 导出（默认按文档位姿，预览态的分解偏移/材质预览不会泄漏；obj 走独立动态 chunk）
const blob = await el.exportDocument({ format: "glb" }); // "glb" | "gltf" | "obj"
downloadBlob(blob, "scene.glb");

// 4) 截图
downloadBlob(await el.toBlob("image/png"), "shot.png");
```

- `loadFiles` 内部为每个文件铸唯一的资产 id（`upload-<n>-<name>`）；宿主 `assetResolver` 仍优先，只有非元素内部 id 才会查宿主表。
- `exportDocument({ from: "live" })` 导出屏幕上的实时状态（仅 `glb` / `gltf`）；`from` 缺省 `document`。
- `downloadBlob` 返回实际使用的文件名（空名时自动加时间戳），方便 toast 展示。

## 错误

按 `code` 分支，不要解析 message。

- `SceneErrorCode`：`validation`、`asset-resolve-failed`、`asset-load-failed`、`render-init-failed`、`lifecycle`、`conflict`
- `AssetErrorCode`：`asset-not-found`、`asset-resolve-failed`、`asset-load-failed`、`asset-unsupported-format`、`asset-disposed`

## 插件

```ts
const logger: SceneEditorPlugin = {
  id: "logger",
  install({ on, addDisposer }) {
    addDisposer(on("selection-change", ({ ids }) => console.log(ids)));
  },
};
el.use(logger);
```

上下文提供 `runtime`、`editor`、`on()`、`addDisposer()`；重复 `id` 抛错，connect 前调用会排队。

## 兼容性与规模

| 维度 | 支持 | 验证 |
|---|---|---|
| `three` | `^0.186.0`（peer） | CI 固定 `0.186.0` + `latest` 矩阵 |
| 渲染器 | WebGL2 默认；WebGPU 走 `rendererFactory` | WebGL2 为 CI 路径 |
| 格式 | `.glb` / `.gltf` | 单测 + e2e；Draco/KTX2 可选注入 |
| 浏览器 | WebGL2 + ES modules | Playwright（CI 为 Chromium） |
| 模块 | 仅 ESM | `pnpm test:pack` |
| SSR | 元素延迟注册，导入无 DOM 副作用 | 单测 + pack 冒烟 |
| 大规模场景 | 5 000 个同规格对象 = **13 次 draw call**（同几何同材质自动 `InstancedMesh`，按世界坐标分块所以仍逐块剔除；`instancing="false"` / `instancing: false` 可关；对象仍可点选/拖动/导出/撤销） | perf e2e + 单测 |
| 内存 | 占位几何与基础材质走引用计数共享池：5 000 个占位对象 JS 堆 **11.0 MB**（各持一份为 26.5 MB）；宿主可传入自己的池 | perf e2e + 单测 |
| 大资产 | 同一资产内「同材质 + 同几何布局」的静态叶子网格合并成一个 mesh（200 个盒子 → 1 个 mesh，约 25–31 ms）；带动画 clip 或 `KHR_materials_variants` 的资产整体跳过合并 | 单测 |
| 重网格拾取 | 单网格三角形数 ≥ 2 000 且命中目标时按需 `import("three-mesh-bvh")`，逐 mesh 打补丁（不改 `Mesh.prototype`）；13 万三角形 **12.0 ms → 0.10 ms**；BVH 独立 chunk，不进 runtime 首屏 | 单测 + 分包体积 |
| 多 clip | 一个对象一个 `AnimationMixer`，多个 action 有效权重归一化即真实混播（`playAnimationBlend` / `animationBlend`） | 单测 |

## 开发

```bash
pnpm install && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e        # critical + visual + perf
pnpm test:release    # 元数据一致性
pnpm test:pack       # npm pack 消费者冒烟
```

## License

MIT，见 [LICENSE](LICENSE)。

# Visual regression (真浏览器 + SwiftShader)

Playwright Chromium 在软件光栅化（SwiftShader）下对 `<scene-editor>` 的 WebGL 画面做截图对比。基线**只包含 canvas**，不包含 HUD、顶栏、底栏和控制面板，因此不受字体、宿主 UI 布局或本机 GPU 影响。

## 跑

```bash
# 只跑视觉（CI 同一个 project）
pnpm test:e2e:visual

# 有意改视觉后更新基线
pnpm test:e2e:visual --update-snapshots

# 全量 e2e（critical + visual + perf）
pnpm test:e2e
```

依赖本机已启动的 playground（`127.0.0.1:4173`），或 CI 里由 `webServer` 拉起。

## 确定性约定

1. `visual` project 强制 `--use-angle=swiftshader`，本地与 CI 使用同一套软件渲染路径。
2. 截图前隐藏 `.app-header` / `.app-footer` / `aside.panel` / toast / welcome，并把 `#viewport` 固定为 **1280×800**。
3. 容差 `maxDiffPixelRatio: 0.01`：吸收 AA 噪声，同时物体会不会消失、gizmo 会不会丢失仍会导致红。

## 场景（URL 驱动，可复现）

| URL | 画面 |
|-----|------|
| `/?scene=default` | 夹具：网格 + 两个蓝盒 + icosahedron 资源 |
| `/?select=box-1` | box-1 选中 + Transform gizmo |
| `/?select=box-1&move=1,0.5,0&rot=0,0.8,0&scale=1.2,1.2,1.2` | 变换后 |
| `/?select=box-2` | box-2 选中 |

基线在 `e2e/visual/__screenshots__/visual/`。CI 的 `visual` job 会执行同一命令并上传失败产物。

## 有意改视觉后更新基线

```bash
pnpm test:e2e:visual --update-snapshots
```

审 diff 再提交 PNG。不要盲更新——先确认差异是预期改动。

## 历史坑

1. 生产路径曾未挂 TransformControls → 选中态与初始态像素相同（size 21819 全等）。已修：懒加载 `examples/jsm/controls/TransformControls.js` + `controlsReady`。
2. WebGL `readPixels` 在 present 后为空（无 preserveDrawingBuffer）→ smoke 用 canvas 元素截图字节数，不用 readPixels。
3. 基线曾长期是「全页 + HUD」版本，字体/面板随 OS 与 GPU 漂移，导致视觉门禁无法在 CI 稳定运行。现在改为 canvas-only + SwiftShader，并在 CI 中强制。

## 手动基线（Chrome DevTools 实截）

`manual-baselines/` 下是早期的全页人工对照图，不参与自动化比较；自动化以 `__screenshots__/visual/` 为准。

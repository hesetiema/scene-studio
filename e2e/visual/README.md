# Visual regression (真浏览器)

Playwright Chromium 对 playground 的 WebGL 画面做截图对比。

## 跑

```bash
# 只跑视觉
pnpm test:e2e:visual

# 全量 e2e（含 critical-flows + visual）
pnpm test:e2e
```

依赖本机已启动的 playground（`127.0.0.1:4173`），或 CI 里由 webServer 拉起。

## 场景（URL 驱动，可复现）

| URL | 画面 |
|-----|------|
| `/` | 机甲展示场景（bare URL 不再是测试夹具） |
| `/?scene=default` | 夹具：网格 + 两个蓝盒 + icosahedron 资源 |
| `/?select=box-1` | box-1 选中 + Transform gizmo |
| `/?select=box-1&move=1,0.5,0&rot=0,0.8,0&scale=1.2,1.2,1.2` | 变换后 |
| `/?select=box-2` | box-2 选中 |

基线在 `e2e/visual/__screenshots__/chromium/`。

截图包含完整 HUD，因此 `waitForBoot()` 会注入 `#hud-perf-stat { visibility: hidden }`——FPS 数值取决于机器负载，不隐藏会让 diff 随机飘。

## 有意改视觉后更新基线

```bash
pnpm test:e2e:visual --update-snapshots
```

审 diff 再提交 PNG。不要盲更新——先确认差异是预期改动。

## 容差

`maxDiffPixelRatio: 0.03`——吸收 GPU/驱动 AA 噪声；结构性回归（gizmo 丢失、物体消失）仍会红。

## 历史坑

1. 生产路径曾未挂 TransformControls → 选中态与初始态像素相同（size 21819 全等）。已修：懒加载 `examples/jsm/controls/TransformControls.js` + `controlsReady`。
2. WebGL `readPixels` 在 present 后为空（无 preserveDrawingBuffer）→ smoke 用 canvas 元素截图字节数，不用 readPixels。
3. 基线曾长期停留在「无 HUD」版本，导致视觉门禁整片飘红。0.4.0 起基线包含完整 HUD，并在截屏前隐藏动态 FPS 文本；改 UI 后按上文流程更新，不要靠调容差掩盖。

## 手动基线（Chrome DevTools 实截）

`manual-baselines/` 下有 01-initial / 02-selected / 03-transformed 三张，供人工对照；自动化以 `__screenshots__` 为准。

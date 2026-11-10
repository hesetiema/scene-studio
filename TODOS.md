# TODOS

## 查看器能力补齐

0.6.0 完成了预览主链路：`<scene-editor src>` 单行预览、自动取景（`autoFrame`）、`progress`/`load` 生命周期、tone mapping / exposure，以及 `visibility-change` 与按需开启的 `view-changing` 元素事件。

### 查看器体验（0.9.0）

五项全部落地，都是**查看器表面**（元素属性 / 可选 RuntimeContract 方法），没有触碰 `view` schema：

- **首帧交叉淡入**：`seamless-poster` 让海报在首帧渲染完成后以 300ms 淡出，不再是 display 一帧切换的闪变。淡入期间 `pointer-events: none`，海报在淡入结束才 `display: none`，宿主自己的内联 `opacity` 会原样还给它。没有该属性时保持旧的立即隐藏行为（有测试钉住两种路径）。
- **拖拽惯性**：`camera-damping`（数值 = OrbitControls `dampingFactor`，裸属性取 0.08）。
  - 按需渲染下阻尼拿不到帧，所以 `CameraRig` 多了一个**收敛循环**：`end` 之后逐帧渲染，直到控件不再派发 `change`（addon 自己的 epsilon 就是停的条件）。循环本身不调用 `update()`——渲染循环里的那一次才是唯一的一步，避免每帧衰减两次。
  - 循环与转盘循环互斥：`start` 立即取消，`setActive(false)`（离屏）同时停掉两者且保留配置。
- ~~**交互提示**~~：已移除。查看器只负责画布，不加装饰件——`interaction-prompt` / `interaction-prompt-threshold` 连同那个自建的「拖动旋转」气泡、摆动动画与 `#interacted` 状态一起删掉了（宿主想要提示，自己往 `<scene-editor>` 上叠一层即可，slot 与 `poster-dismissed` 事件都在）。
- **离屏 / 后台暂停渲染**：`RuntimeContract.setRenderingPaused?(paused)`。元素把两个来源（IntersectionObserver 的不可见、`document.hidden`）合成一个布尔量；`ThreeRuntime` 停掉动画与转盘循环、`#render()` 直接返回，恢复时**立刻补一帧**（drawing buffer 不保留，不补就是白屏）。显式截图（`toDataURL` / `toBlob` / 公开的 `render()`）走 `force` 通道，暂停不影响它们。
  - 注意：`#onVisibilityChange` 即使标志未变也会应用暂停——观察者的首次报告可能是 `false`，而初始状态本来就是 `false`，早退会漏掉「一开始就在视口外」的情况。
- **内嵌相机**：`camera-name` 属性 + `cameras` / `cameraName` / `setCameraByName()`。只借位姿与 FOV，运行时仍是自己的透视相机 + 轨道控制（所以用户能从内嵌视角拖走，不会被锁死）。轨道 `target` 由「内容中心投影到视线轴」推出——glTF 相机只有朝向没有 target，而 OrbitControls 每次 update 都用 target 重算朝向，不落在视线上就会一拖就跳。加载前设的名字会记住并在挂载时套用；文档 `view` 一旦应用就清空当前相机名（持久化的位姿优先级更高）。
- **Morph target**：`morphTargets` / `setMorphInfluence(objectId, meshIndex, targetIndex, value)`。
  - 用 `(objectId, meshIndex)` 而不是 uuid 定位 mesh：重载后遍历顺序稳定，uuid 会变。
  - `driven` 由「正在播放的 clip 是否写了 `<meshName>.morphTargetInfluences`」判定——这正是 mixer 的绑定方式。被驱动的通道直接拒绝写入，UI 显示禁用态，而不是写了下一帧被覆盖。
  - GLTFLoader 会把未命名的 target 用序号当 key，所以形如 `"0"` 的 key 不算名字，回退到 `Target n`。

验证资产：`apps/playground/public/assets/camera-morph.gltf`（自建，3 个节点 / 2 台相机 / 2 个 morph target），以及更早的 `variant-box.gltf`。两者都只在 playground 里，不进包。

### 查看器表面：传输、位姿、键盘（0.9.x）

上一批补齐的是「看得对」，这一批补的是「宿主能控」。三项都只加在元素/RuntimeContract 的可选成员上，`view` schema 依旧未动。

- **播放传输的元素面**：`availableAnimations` / `animationName` / `paused` / `play()` / `pause()` / `currentTime` / `timeScale`。
  - 运行时其实早有 `playAnimation` / `pauseAnimations` / `resumeAnimations` / `setAnimationTime` / `setAnimationSpeed`，只是没写进 `RuntimeContract`——这一批是纯接线，能力早就在。
  - `play()` 先试 `resumeAnimations()`：暂停后从**当前位置**续播，而不是 `reset()` 从头开始。这是 model-viewer 的语义，也是宿主最容易踩的差异。
  - `pause()` 会置一个显式的 `#explicitPause`，之后 `#applyPlaybackSettings` 里 `autoplay` 一律传 `false`——否则「加载前先暂停」会被随后的加载覆盖。
  - `animationName` 的 setter（而不是属性）会**选中并起播**；只写 `animation-name` 属性仍受 `autoplay` 约束，两者语义不同，测试各钉一条。
  - `availableAnimations` 去重：一个文档里两个对象都叫 `Take 001` 时，宿主的下拉框只想要一个选项。
- **相机声明式属性与 getter**：`camera-orbit` / `camera-target` / `field-of-view`（+ `min/max-field-of-view` 夹取）、`getCameraOrbit()` / `setCameraOrbit()` / `getCameraTarget()` / `setCameraTarget()` / `getFieldOfView()` / `setFieldOfView()`。
  - 角度约定与既有的 `min/max-camera-orbit` 完全一致：`theta` 从 +Z 起算的方位角、`phi` 从 +Y 起的极角、`radius` 世界单位——所以宿主可以直接把 model-viewer 的属性值粘过来。
  - `auto` 表示「保留该轴」：`camera-orbit="auto auto 2m"` 只改距离，不动角度。`camera-orbit="90deg 90deg 10"` 这类给定值则按 `radius·sin/ cos` 还原成相机位置。
  - 只改 `camera-target` 时，眼睛跟着平移、角度与距离不变——否则 `OrbitControls` 每次 `update()` 都会用 target 重算朝向，一拖就跳。
  - 位姿走的是 `runtime.applyViewState()` 而不是 `editor.setViewState()`：查看器属性不该把文档标脏，持久化的位姿仍然只有 `view.camera`。
  - 两个应用时机刻意分开：**属性变更**永远应用（`force`），**加载后重断言**只应用一次然后挂起。否则改个 `tone-mapping` 都会把用户刚拖好的视角弹回属性值。
  - `camera-name` 存在时整体让位：内嵌相机是完整位姿，属性只负责补位。
- **键盘导航与 `alt`**：方向键 orbit（5°，Shift 1°）、`+`/`-` 推拉 ±10%，只处理编辑器没认领的键（`preventDefault` 已置位就跳过），焦点在输入类元素内不响应。`alt` 落到 canvas 的 `role="img"` + `aria-label`，缺省回退成 `3D model: <文件名>`——一个没有标签的 canvas 对读屏用户等于零信息。

三项都有单测（`test/element/viewer-surface.test.ts`，23 条），并在 `/demos/viewer.html` 上加了传输控件、`camera-orbit` 预设、`field-of-view` 输入与「读取 orbit」按钮。

### 查看器表面：交互、环境、位姿过渡（0.9.x）

同一批思路的第三轮：仍然只加元素属性与 `RuntimeContract` 的可选方法，`view` schema 未动。

- **交互手感**：`orbit-sensitivity`（乘法系数，直接映射 `OrbitControls.rotateSpeed`）+ `touch-action`（`none` / `pan-x` / `pan-y`，默认 `pan-y`）。
  - 两个值都刻意允许边界语义：`orbit-sensitivity="0"` 冻结轨道但仍可平移缩放，负值反向——看 `radius="0"` 的洞穴内部就靠它。所以下发给 addon 时判的是「有没有」而不是「真不真」。
  - `touch-action="auto"` 不接受：`auto` 正是「把拖拽交给浏览器」的那个值，也就等于不拦截滚动，而这条属性的目的恰好相反。iOS 上 canvas 的 CSS `touch-action` 无效，所以走属性而不是样式表。
  - **`touch-action` 是抢来的**（本轮唯一一次踩坑）：`OrbitControls` 与 `TransformControls` 都在 `connect()` 里硬写 `this.domElement.style.touchAction = 'none'`（three 自己的注释是 "Disable touch scroll"），而这两次 connect 都来自各自的动态 import，顺序不由调用方决定。第一版实现「mount 之后重申一次」，真机上约一半的加载仍然是 `none`。定位过程：元素与 rig 两侧都插桩记录写入顺序 → 发现我们的 `pan-y` 明明是最后一次写；再用 MutationObserver 盯 `style` 属性，看到在我们之后还有一次 `none`，而它不来自 OrbitControls 的日志 → grep 构建产物，`TransformControls` 里也有同样的赋值。修法是新增 `viewer/touch-action-owner.ts`：值由查看器持有，画布上挂一个 `style` 观察者，谁写偏了就写回去（同值不重写，所以不会自激）。
- **环境贴图**：`environment-image` 现在一个属性两种形态——预设 `neutral` / `room` / `legacy`，或 HDR/EXR/LDR 的 URL；`skybox-image` 单独管背景。
  - 语义按 model-viewer：URL 形态只换反射，**不动背景**；背景要换只能给 `skybox-image`。
  - 反过来，只给 `skybox-image` 而没给 URL 形态的 `environment-image` 时，同一张图兼作光照探针——一次下载既照亮又当背景，这是 model-viewer 的行为，也是「只想换张环境图」的宿主最常见的写法。
  - `legacy` 是 `room` 的别名（model-viewer 保留了旧预设名）。
  - 换图用 token 做 last-call-wins：异步解码回来的旧图自己 dispose，不覆盖后发的那张，也不泄漏 GPU 资源。three r186 里 `RGBELoader` 已废弃，改用 `HDRLoader`。
- **位姿过渡**：`interpolation-decay`（ms，默认 50；官方选项是「大于 0 的值」，所以非正值回退默认值，要立刻到位用 `jumpCameraToGoal()`）+ `jumpCameraToGoal()` / `resetTurntableRotation(theta?)`。
  - 衰减是**渐近**的：`p = 1 - e^(-3t/decay)`。第一版把 `t/decay` 截断到 1，结果 `p` 永远到不了 0.999，缓动永远不结束——现在不截断，靠 epsilon 收尾。
  - 位姿之间走**球面插值**：offset 方向 `slerp`、radius 线性、target 线性。直接线性插值相机位置会在 180° 换边时穿模而过。
  - 缓动与转盘循环互斥（两者都要独占相机）：起缓动先停转盘，落地、被 `jumpCameraToGoal()` 收掉、或被用户拖拽打断后都交还。
  - `resetTurntableRotation(theta)` 是**绝对**语义：调用后转盘读数就是 `theta`（默认 0），所以内部做的是「差值回滚」，而不是无条件归零；用户自己拖出来的方位角不受影响。
  - 加载完成后的重断言走 **snap**（不缓动），只有属性变更与 API 写入才淡入——否则每次加载都会看到相机自己飘一段。这条用「意图参数」表达，而不是靠「首帧特判」，后者会把 `setFieldOfView` 的第一次调用也变成缓动，还会把文档标脏。
- **加载凭据**：`with-credentials` → `Loader.setWithCredentials`，在**每次 load 前**下发，所以模型本体与它引用的外部 buffer / 贴图都能带上 cookie（私有 CDN 的常见要求）。

未实现（经核对，不是差距）：`interaction-policy` / `allow-when-focused` / `generate-intrinsic-size` 在 model-viewer 的官方属性表与其 `features/controls.ts` 里都不存在，前者是此前凭记忆写下的误记；AR/XR 相关（`ar` / `ar-modes` / `quick-look` / `xr-environment`）维持不做。

验证：`test/element/viewer-interaction.test.ts`、`viewer-environment.test.ts`、`viewer-loading.test.ts`、`viewer-camera-transition.test.ts`，以及 `test/three/touch-action-owner.test.ts`（含「第三方后写仍被纠正」）、`camera-rig.test.ts` 的 `rotateSpeed` / 转盘回滚 / 位姿缓动 / `touch-action` 组。真机脚本 `e2e/manual-viewer-check.mjs`（对生产构建跑，用法写在文件头）18/18（含 `touch-action` 默认值、HDR 换图、skybox 兼作光照、淡入是否落地、`jumpCameraToGoal`、`resetTurntableRotation`、「查看器属性不写脏文档」）。

### 标注视口：`data-normal` + `queryHotspot()`（0.9.x）

标注（annotations）原先把 `slot="hotspot-*"` + `data-position` 做到「能钉在模型上」就停了，其余四个 API 里先补了最便宜的两个：

- **`data-normal`**：表面法线，默认 `0 1 0`（官方 `Hotspot` 的默认值）。判定照抄官方 `updateHotspotsVisibility`——`(camera − anchor) · normal < 0` 即背面，且**不归一化**（长度不影响符号；零长法线因此算「朝向」，不会让标注莫名消失）。
  - 背面时写 `opacity: var(--min-hotspot-opacity, 0.25)`；正面时把内联值**删掉**而不是写 `1`，宿主自己的 `opacity` 与 `--max-hotspot-opacity` 才仍有发言权。官方是在自己的 shadow 样式表里给包裹层加 `.hide`，我们是 light DOM，只能落到节点上。
  - `data-visibility-attribute="visible"` 时镜像成 `data-visible`（官方同样只在显式声明时才写，不擅自加属性），并在**状态变化**时派 `hotspot-visibility`。投影每帧都跑，所以事件必须只在翻转时发，否则就是噪声。
- **`queryHotspot(name)`**：返回 `{ position, normal, canvasPosition, facingCamera }`，`canvasPosition` 是 canvas 本地 CSS 像素 + 投影的 NDC `z`（官方 `HotspotData` 就是这种 `{x,y,z}` 对象——这里刻意不跟随本仓库的 tuple 惯例，否则从 model-viewer 迁过来的代码要全改）。找不到锚点、runtime 未就绪、投影非有限值都返回 `null`。
- **运行时契约**：新增可选 `projectHotspot(point, normal)`，`projectPoint` 顺带多返回一个 `z`。`ThreeRuntime` 里两者共用一个私有 `#projectToCanvas`，避免重复算包围盒。

顺带修掉一个真 bug：slot 观察者只 observe 了 `this` 而没有 `subtree: true`，所以锚点自己改 `data-position` / `data-normal` 根本不会被重新收集（`attributeFilter` 里写着 `data-position` 但永远不会触发）。模型这侧反而比官方宽松——官方文档明确 `data-position`/`data-normal` 不被观察，必须调 `updateHotspot()`；我们现在改属性即可，`updateHotspot()` 因此不必急着补。

未做：`data-surface` / `surfaceFromPoint()`（跟随蒙皮动画的标注，要做三角形 + 重心坐标 + 每帧 `animateSurfaceHotspots`，需单独立项）、`materialFromPoint()`。

验证：`test/element/viewer-hotspot.test.ts`（16 条：queryHotspot 三态、默认法线、背面改写 opacity、事件只在变化时发、`data-visibility-attribute` 镜像、改 `data-normal` 重新收集、出深度范围隐藏、`updateHotspot()` 的五条）、`test/three/hotspot-projection.test.ts`（6 条：投影一致、正/背、签名点积、零长法线、相机换边、锚点自身在相机后）。演示页新增「标注（hotspot）」分组：在模型上取一点放两个法线相反的锚点，转视角即可看到淡出，另有按钮演示 `updateHotspot()` 上下移动。

### 查看器表面：状态、传输事件、指针灵敏度（0.9.x）

这一轮补的是宿主最常依赖、但我们一直缺的三块「读数 + 事件」，仍然只动元素/RuntimeContract 的可选面。

- **`loaded` / `modelIsVisible`**：`loaded` 就是 `#contentLoaded`（`load` 事件之后为真，换源与销毁归零）；`modelIsVisible = loaded × 视口内 × 海报已消失`，与官方 `$getModelIsVisible() && $modelIsRevealed` 同构。
  - 顺带修了一处语义债：`model-visibility` 以前是 `visibility-change` 的别名（只反映交叉），现在按官方的**复合判定**发——海报重新出现也算一次翻转。`visibility-change` 保持纯交叉语义不动，需要原始信号的人不受影响。旧测试里「没加载过内容也发 `model-visibility`」的那条已按新口径改写。
  - 没有 `IntersectionObserver` 时（SSR、部分测试 DOM、显式关掉工厂）按「在视口内」处理——官方在没有 IO 时也是这个默认值。
- **传输事件 `play` / `pause` / `loop` / `finished`**：rig 在起播、暂停、绕回、one-shot 结束时通知，`ThreeRuntime` 转到事件总线，元素再转成 `CustomEvent`。
  - `pause` 只在「由播放转暂停」时发——官方明确模型初始就是 paused，加载时发一次纯属噪声。`loop.count` 从 1 起，且每次起播归零（跟 three 的 `action._loopCount` 一致，不跨 clip 累计）。
  - `loop` 只有 repeat / ping-pong 会触发：three 的 `LoopOnce` 只发 `finished`，不做多余的模拟。
  - 另一个副作用：`play` 事件里的 clip 名会顺手写进 `#activeClipName`，所以 `animationName` 终于反映「实际在播什么」，而不只是「属性写了什么」。
- **`zoom-sensitivity` / `pan-sensitivity`**：与 `orbit-sensitivity` 同一套语义，映射到 `OrbitControls.zoomSpeed` / `panSpeed`。`0` 是合法值（`zoom-sensitivity="0"` 冻结滚轮但保留拖拽），所以下发时判「有没有」而不是「真不真」。

未做（并列入对照表）：`appendAnimation()` 等多动画混播、`interact()` / `interact-stopped`（没有编程运镜编排）、`materialFromPoint()`、`before-render`（按需渲染下「首帧」没有统一定义，宁可缺席也不谎报）。

验证：`test/three/animation-rig.test.ts` 新增 4 条传输事件用例（含「没在播时 pause 不发声」「one-shot 只发 finished」），`test/element/viewer-surface.test.ts` 2 条（事件转成 CustomEvent、`animationName` 跟随实际播放），新增 `test/element/viewer-model-visibility.test.ts` 7 条，`viewer-interaction.test.ts` 2 条灵敏度用例。


### 资源兼容（0.8.0）

- **解码器注入**：元素暴露 `dracoLoader` / `ktx2Loader` / `meshoptDecoder` 三个属性（传实例，不传路径：`KTX2Loader` 必须自己先 `detectSupport(renderer)`）。元素把三者包成 getter 交给 `createResolverAssetLoader`，装载层**每次 load 前**重读并下发，所以「连接后再赋值」也能生效；`MinimalGltfLoader` 补了 `setMeshoptDecoder`。此前元素路径的 loader 根本没有解码器，Draco 压缩的 GLB 打不开。
- **变体切换**：`KHR_materials_variants` 已实现（元素 `variant-name` 属性 + `availableVariants` / `variantName`，运行时 `variants` / `setVariant()`）。three r186 不解析该扩展，所以直接读 `parser.json` 的 `extensions` 与各 primitive 的 `mappings`，材质经 `parser.getDependency('material', i)` 解析以复用其缓存。
  - 定位 primitive 靠 `parser.associations`（`{meshes, primitives}`）；表挂 `LoadedAsset.variants`，用 `mesh.userData` 里的一串 key 索引——`Object3D.clone` 走 JSON 深拷贝，字符串能活下来，材质引用不行。
  - 实例是 `clone(true)`，所以每个对象的材质槽独立；切换本身是**场景级**的（对齐 model-viewer 的 `variant-name` 语义）。文档级 `material` 覆盖优先于变体，清除覆盖后变体会重新接管。
  - 加载完成前设的 `variant-name` 会被记住并在挂载时套用；`MaterialVariantSet` 解析失败只损失该 primitive 的变体，不影响加载。
  - 验证用的最小资产：`apps/playground/public/assets/variant-box.gltf`（8 顶点方块，Base / Red / Blue 三个材质）。

### 与 model-viewer 的对照（`/demos/compare.html`）

对齐方法与量化口径：同一 GLB、同一动画时间、同一视口，取模型像素的平均 / p95 亮度、包围盒像素尺寸与相机距离作指标。

已对齐：

- **色调映射默认值**：预览路径默认 `neutral`（model-viewer `tone-mapping="auto"` 在 glTF 上的解析结果）。此前默认 ACES，渲染结果比参考暗约 35%、饱和度过高。
- **环境亮度**：`neutral` 预设已直接移植 model-viewer 的 `EnvironmentScene('neutral')` 几何（房间 + 6 遮挡体 + 7 发光板 + 1 顶光，σ=0.04 预滤波），反射形状与参考一致；整幅平均亮度仍差约 5%，来自 three r183 与 r186 的预滤波/色调映射实现差异，非数据差异。
- **接触阴影**：移植 model-viewer 的 `Shadow` 算法——正交相机贴在**地面**上朝上，`MeshDepthMaterial` 改写为把「离地高度」写成 alpha，两遍可分离模糊后贴在透明面上；`softness` 同时决定贴图分辨率与相机 `far`，动画模型按 `ANIMATION_SCALING=2` 放大阴影体积。此前是方向光 PCF 投影，且相机架在模型半高朝下——梯度反了：脚下最淡、腰腹最浓，观感是模型周围一圈光晕而不是脚下接触。
- **属性表面积**：新增 `shadow-intensity` / `shadow-softness`，与 `tone-mapping` / `exposure` 一样属于显示态，加载后重新断言（文档的 `view` 会覆盖它们——这曾导致 compare 页的阴影在模型加载完成瞬间消失）。`shadow-intensity` 现在原样传入 `contactShadow.opacity`，由阴影组件施加 model-viewer 的 `lerp(0.3, 1, softness²)` 软化衰减；此前的 `0.35×` 系数是针对旧 PCF 阴影的经验值。
- **取景**：`frameViewer()` 复刻了 model-viewer 的 `updateFraming()`：球半径取顶点（而非包围盒角点）到目标中心的最大距离，距离 = 半径 / sin(15°)，宽模型不改距离而是按 `idealAspect` 放宽垂直 FOV，相机落在 105% 半径处（`camera-orbit` 的 `auto`）。FOV 恒为 30°——实测 v4 在竖屏不会抬到 45°，只放宽渲染 FOV。此前按投影包围盒 + 8 方位取样，模型尺寸差 −14%~+16%。

仍有差距（按可见度排序）：

1. **动画相位不同步**：两栏各自从加载完成起播，姿态随时间漂移，接触阴影的形状/位置因此不同——这是对照页的取样问题，不是渲染差异。要逐帧对比需共享时钟与 clip 相位。
2. **渲染器版本差**：three r183（model-viewer 内）与 r186 的预滤波、色调映射实现不同，环境照明的整幅平均亮度残留约 5% 差。

**取舍：** 相机切换与 morph target 只加在查看器表面（`RuntimeContract` 的可选方法 + 元素属性），`view` schema 未动——它们描述「怎么看」，不是「文档里有什么」。只有真正需要持久化「默认用哪台相机 / 哪个 morph 预设」时才需要 schema 迁移。

## 编辑能力缺口

0.7.0（schema v3）把以下能力带进了文档模型：

- `parentId` 现在是真实层级：group 会被挂载，子对象挂到父对象下而不是场景根；父对象加载失败时子对象提升为根，成环时断开而不是挂死。
- `type: "primitive"` + `geometry`：八种程序化几何（box / sphere / cylinder / cone / torus / plane / capsule / icosahedron），参数可选、默认值在工厂内。
- 对象级 `material` 覆盖：只写声明的字段；asset 实例会先 clone 材质，避免污染缓存与其他实例。
- `view.lights.additional`：point / spot / directional / hemisphere 附加灯。

0.7.0 的命令层（`addObject` / `removeObject` / `reparent` / `setMaterial`）补齐了写操作：

- 四个命令都进撤销栈，走同一套 `CommandHistory`；`addObject` 是异步的（资产加载），其余同步。
- 写操作复用 `SceneObjectSchema` + `MaterialSchema` + `validateHierarchy`，因此重复 id、缺失父级、自指与成环在命令层就被拒绝，而不是等到下次加载。
- `removeObject` 级联删除整棵子树并记录原始索引，undo 能还原数组顺序。
- `setMaterial(id, undefined)` 清除覆盖并恢复资产自带材质（材质覆盖句柄可撤销）。
- 删除选中对象后选择会被清理，不会留下悬空 id。

playground 的材质面板已切到 `setMaterial`：改动进文档、进撤销栈，且拖动滑块通过
`Command.mergeWith` 合并成一步撤销（顺带修掉了直接改 `mesh.material` 会污染 AssetCache
共享材质的问题）。

仍未排期：

- 对象的复制/克隆命令。
- 多对象变换（批量变换命令）。
- 资产内嵌相机的命名列表与切换（与上面的相机项一起设计）。

## 已明确不做（YAGNI）

- **CRDT / 实时多人协作**：首发面向单用户。并发编辑走既有路径——保存时校验 `revision` → 结构化冲突（base / incoming / local）→ 宿主决定 UX。未来若做，接入点在序列化与命令历史层，`SceneDocument` 已是纯数据模型，**不需要预留代码**。
- **插件面板槽位**：`install(context)` 已交付（命令、事件、选择器、disposer 清理），槽位是无真实需求时的猜测性 API。
- **按产品拆包**：多个产品出现复用需求前，保持单包四入口。

## 发布

- npm scope：`@scenio` 为占位，首次发布前选定。
- 发布状态：仓库内为 `0.7.0`（未发布），npm `latest` 仍为 `0.6.0`。发布会带 schema v3，属于文档格式的 minor 变更。发布前跑 `pnpm test:release` 与 `pnpm test:pack`。

# TODOS

## Viewer 能力补齐

0.5.0 已完成运行时拆分、glTF 动画与查看器主链路（详见 README）；剩余待办：

- **HDR 环境贴图**：PMREMGenerator + RoomEnvironment/HDR 预设；需要 `view.environment` 增字段与 schema 迁移（v3）。
- **模型内嵌相机切换**：遍历 asset 的 `isCamera`，切换 `runtime.camera` 或复制参数；需要 `RuntimeContract` 增加相机切换语义。
- **Morph target UI**：每个 mesh 的 `morphTargetInfluences` 滑块，与动画驱动互斥。

**取舍：** 三项都会触碰 `view` schema 或 `RuntimeContract`，需独立迁移评审；没有真实宿主需求前不提前加字段。

## 已明确不做（YAGNI）

- **CRDT / 实时多人协作**：首发面向单用户。并发编辑走既有路径——保存时校验 `revision` → 结构化冲突（base / incoming / local）→ 宿主决定 UX（D17）。未来若做，接入点在序列化与命令历史层，`SceneDocument` 已是纯数据模型，**不需要预留代码**。
- **插件面板槽位**：`install(context)` 已交付（命令、事件、选择器、disposer 清理），槽位是无真实需求时的猜测性 API。
- **按产品拆包**：多个产品出现复用需求前，保持单包四入口。

## 待定

- npm scope：`@scenio` 为占位，首次发布前选定。
- 发布状态：npm `latest` 为 `0.3.0`；仓库内 `0.4.0` / `0.5.0` 尚未发布。发布前跑 `pnpm test:release` 与 `pnpm test:pack`。

# TODOS

## 查看器能力补齐

0.6.0 完成了预览主链路：`<scene-editor src>` 单行预览、自动取景（`autoFrame`）、`progress`/`load` 生命周期、tone mapping / exposure，以及 `visibility-change` 与按需开启的 `view-changing` 元素事件。

剩余待办：

- **首帧体验**：`poster` 与 `reveal=auto|interaction|manual`，避免加载期闪白。
- **交互手感**：OrbitControls 阻尼与可关闭的交互提示。
- **可见性省电**：`visibility-change` 已可用，尚未接入渲染暂停。
- **解码器注入**：element 层暴露 Draco/KTX2/Meshopt 注入点（loader 层已支持）。
- **HDR 环境贴图**：PMREMGenerator + RoomEnvironment/HDR 预设；需要 `view.environment` 增字段与 schema 迁移（v3）。
- **模型内嵌相机切换**：遍历 asset 的 `isCamera`，切换 `runtime.camera` 或复制参数；需要 `RuntimeContract` 增加相机切换语义。
- **Morph target UI**：每个 mesh 的 `morphTargetInfluences` 滑块，与动画驱动互斥。

**取舍：** 三项都会触碰 `view` schema 或 `RuntimeContract`，需独立迁移评审；没有真实宿主需求前不提前加字段。

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

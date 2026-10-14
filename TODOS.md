# TODOS

## CRDT / 实时多人协作编辑层

**What:** 为 SceneDocument 设计 CRDT 或 OT 合并层，支持多光标、实时共编与意图感知冲突解决。

**Why:** 双人同时编辑同一场景时，当前乐观并发策略（409 → 结构化冲突 → 宿主驱动，见设计 D17）只能一人赢；协作是产品能力跃迁。

**Pros:** 解锁协作编辑；结构化冲突事件面（D6/D17）已是它的接入点。

**Cons:** 复杂度极高（CRDT 库选型、状态膨胀、意图冲突语义）；与单用户首发目标脱钩，过早引入会拖垮 v0.1。

**Context:** 设计评审（2026-10-13，/plan-eng-review D17）明确“首发不做 CRDT”。当前冲突路径：保存 → 服务端校验 revision → 409 → core 导出 conflict 错误码 + base/incoming/local detail → 宿主决定 UX。未来做协作时，合入点在 `core/serialization` 与命令历史层，不触碰 Three Runtime；SceneDocument 已是纯数据模型（不依赖引擎），这是为协作预留的结构红利。

**Depends on / blocked by:** 阶段 2 完成后 SceneDocument schema 稳定；zod schemaVersion 迁移机制（D7）经过至少一次真实迁移验证。

## 相机 / 灯光 / 环境入 SceneDocument

**What:** 把 defaultCamera（position/target/fov）、环境光/方向光、背景等写入持久化 schema，刷新后恢复完整工作区视角。

**Why:** 用户直觉期望“回到我刚才的工作状态”，目前 D3 决策刷新后视角丢失，是被主动推迟的体验项。

**Pros:** 产品完整感；演示/固定机位场景是刚需。

**Cons:** schema、命令、测试面扩大；需 schemaVersion+1 迁移。

**Context:** 2026-10-13 设计评审 D3：旋转已锁弧度制 Euler XYZ，相机/灯光暂不入档（属 UI 状态），DTO 已留 `metadata?: Record<string, unknown>` 扩展位。实施入口：zod schema 加字段 + 迁移函数（D7 约定迁移与 schema 并列可测）。

**Depends on / blocked by:** 阶段 2 后 schema 稳定；zod 迁移机制已验证。

## 插件体系 install(context)

**What:** 设计插件 API：`install(context)` 提供受控上下文（命令注册、事件订阅、选择器、面板槽位），不暴露 Renderer/GPU 内部对象。

**Why:** 设计第 5 节提及“扩展插件可以使用 install(context)”但未展开；它是“多产品复用时拆包”的轻量替代方案。

**Pros:** 不拆包也能扩展；与四入口 + 事件面（D4/D6/D18）衔接自然。

**Cons:** context 面设计过早会锁死内部结构；没有真实插件需求时是猜测性 API。

**Context:** 2026-10-13 设计评审 D21/阶段 4 决策树：仅在多个产品有复用需求时才拆包；插件体系与拆包同属“复用需求触发”分支。v0.1 公开 API 稳定（0.1.0 使用反馈后）才是设计 install(context) 的时机。

**Depends on / blocked by:** 至少一个真实扩展需求出现；0.1.0 公开 API 经使用反馈稳定。

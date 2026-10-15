# TODOS

## CRDT / 实时多人协作编辑层

**What:** 为 SceneDocument 设计 CRDT 或 OT 合并层，支持多光标、实时共编与意图感知冲突解决。

**Why:** 双人同时编辑同一场景时，当前乐观并发策略（409 → 结构化冲突 → 宿主驱动，见设计 D17）只能一人赢；协作是产品能力跃迁。

**Pros:** 解锁协作编辑；结构化冲突事件面（D6/D17）已是它的接入点。

**Cons:** 复杂度极高（CRDT 库选型、状态膨胀、意图冲突语义）；与单用户首发目标脱钩，过早引入会拖垮 v0.1。

**Context:** 设计评审（2026-10-13，/plan-eng-review D17）明确“首发不做 CRDT”。当前冲突路径：保存 → 服务端校验 revision → 409 → core 导出 conflict 错误码 + base/incoming/local detail → 宿主决定 UX。未来做协作时，合入点在 `core/serialization` 与命令历史层，不触碰 Three Runtime；SceneDocument 已是纯数据模型（不依赖引擎），这是为协作预留的结构红利。

**Depends on / blocked by:** 阶段 2 完成后 SceneDocument schema 稳定；zod schemaVersion 迁移机制（D7）经过至少一次真实迁移验证。

## ~~相机 / 灯光 / 环境入 SceneDocument~~ → 已决策 D22（实施中）

2026-10-15 评审通过：文档新增 `view` 段（相机/灯光/环境），`schemaVersion` → 2；视角变化置脏但**不进撤销栈**；文档视角**仅在新 sceneId 时应用**；通用迁移注册表（D7）随本项首次落地；`background: null` 保持透明以保全视觉基线。

设计文档：`docs/specs/2026-10-15-view-state-persistence-design.md`。

## 插件体系 install(context)

**What:** 设计插件 API：`install(context)` 提供受控上下文（命令注册、事件订阅、选择器、面板槽位），不暴露 Renderer/GPU 内部对象。

**Why:** 设计第 5 节提及“扩展插件可以使用 install(context)”但未展开；它是“多产品复用时拆包”的轻量替代方案。

**Pros:** 不拆包也能扩展；与四入口 + 事件面（D4/D6/D18）衔接自然。

**Cons:** context 面设计过早会锁死内部结构；没有真实插件需求时是猜测性 API。

**Context:** 2026-10-13 设计评审 D21/阶段 4 决策树：仅在多个产品有复用需求时才拆包；插件体系与拆包同属“复用需求触发”分支。v0.1 公开 API 稳定（0.1.0 使用反馈后）才是设计 install(context) 的时机。

**Depends on / blocked by:** 至少一个真实扩展需求出现；0.1.0 公开 API 经使用反馈稳定。

# 设计：相机 / 灯光 / 环境入档（View State Persistence）

- 日期：2026-10-15
- 状态：已实施（0.3.0，2026-10-16）
- 关联决策：D3（反转）、D7（迁移机制首次落地）、D18、D22

## 1. 背景与目标

D3 原先把相机位姿、灯光、环境划为"编辑会话状态"，**不写入场景文档**（主设计文档 L287：除非产品明确要求）。本设计即该"产品明确要求"：**刷新/重载后恢复完整工作区视角**。

`SceneDocument` 需要自描述"这个场景看起来是什么样"，而不是只描述物体。

**成功标准**

1. 加载一个含 view 的文档后，视口相机/灯光/背景/grid 与该文档一致。
2. 用户转动视角后保存，重载（新场景）能恢复该视角。
3. 旧（v1）文档仍能加载：自动迁移补全 view 默认值，视觉与迁移前完全一致。

## 2. 决策摘要

| # | 决策 | 理由 |
|---|---|---|
| 1 | 入档范围 = 相机 + 灯光 + 环境 | 用户选定（TODOS.md 完整范围） |
| 2 | **始终入档**，不做配置开关 | 产品明确要求；避免 API 面膨胀 |
| 3 | 视角变化 → `dirty = true`，**不进撤销栈** | 既能触发宿主自动保存（达成目标），又不让 orbit 手势污染历史 |
| 4 | 文档视角**仅在 sceneId 变化时应用**（首次加载 / 切场景） | 同场景回流（冲突重载）不打扰用户当前视角 |
| 5 | 迁移走**通用注册表** + 收紧 schemaVersion | D7 承诺；本次是第一次真实迁移 |
| 6 | 视角入档只来自**显式通路**（交互事件 / `setViewState()`），无保存期隐式刷新 | 可归因；避免"文档变了但 dirty=false"的不一致 |
| 7 | `background: hex \| null`，`null` = 透明 | 保全现有渲染与视觉基线 |

## 3. 数据模型（schema v2）

```ts
{
  schemaVersion: 2,                 // 字面量（z.literal(SCHEMA_VERSION)）
  sceneId: string,
  revision: number,
  objects: SceneObjectDTO[],       // 不变
  view: {                          // 必填 —— v2 文档自描述其外观
    camera: {
      position: [number, number, number],
      target:   [number, number, number],   // OrbitControls 焦点
      fov: number,                          // > 0
    },
    lights: {
      ambient:     { color: "#rrggbb", intensity: number },              // intensity >= 0
      directional: { color: "#rrggbb", intensity: number,
                     position: [number, number, number] },
    },
    environment: {
      background: "#rrggbb" | null,        // null = 透明（沿用现状）
      gridVisible: boolean,
    },
  },
}
```

**默认值 = 当前引擎硬编码值**（迁移与"无 view"路径共用）：

| 字段 | 默认 |
|---|---|
| `camera.position` / `target` / `fov` | `[6, 5, 10]` / `[0, 0, 0]` / `60` |
| `lights.ambient` | `#ffffff`, `0.55` |
| `lights.directional` | `#ffffff`, `1`, `[5, 10, 7]` |
| `environment.background` | `null`（透明） |
| `environment.gridVisible` | `true` |

**明确不入档**（延续 D3）：`near` / `far` / `aspect`、OrbitControls 阻尼与速度、renderer 参数。

颜色格式锁 `#rrggbb`（正则），不接受命名色 / 透明度写法。

## 4. 数据流

| 层 | 改动 |
|---|---|
| `core/history` | `CommandHistory` 增 `markDirty()`（与 `markClean()` 对称的非命令脏）；`dirty = 栈脏 \|\| externalDirty`；`markClean()` / `clear()` 复位 externalDirty |
| `core/document` | `ViewStateSchema` + `ViewState` 类型；`schemaVersion: z.literal(SCHEMA_VERSION)`；`migrations.ts`（§5）；`parseSceneDocument(input, { onMigrate? })` |
| `RuntimeContract` | 增 `getViewState(): ViewState`、`applyViewState(view): void`；`RuntimeEventMap` 增 `"view-change": { view }` |
| `EditorController` | `setViewState(view)`：写 `#doc.view` + `history.markDirty()`，**不入栈**；`loadDocument` **与 `applyRemote`** 均在 `doc.sceneId` 与当前不同时才 `runtime.applyViewState(doc.view)` |
| facade | `SceneEditorEventMap` 增 `"view-change": { view, source }`；公开 `getViewState()` / `setViewState()` |
| element | 桥接 `view-change` → CustomEvent（与其余事件一致） |

**runtime 事件纪律**：`view-change` **仅由用户交互触发**（OrbitControls `end`）；`applyViewState` 期间抑制发射 —— 杜绝"加载即置脏"的回环与幻影事件。

## 5. 迁移与错误

`src/core/document/migrations.ts`（与 schema 并列，D7）：

```ts
export const SCHEMA_VERSION = 2;
export interface Migration { from: number; to: number; migrate(doc: RawDoc): RawDoc }
export function migrateSceneDocument(
  input: unknown,
): { document: unknown; applied: Array<{ from: number; to: number }> }
```

- 逐级套用 `from → to`，每步必须命中
- `v1 → v2`：为 v1 文档 **materialize 出显式 view 默认值**（已有合法 `view` 则不覆盖），并置 `schemaVersion: 2`
- 幂等：v2 输入直通，`applied: []`

**错误**（`SceneErrorCode.Validation` + structured `detail`，不改错误码枚举）：

| 情形 | `detail.reason` |
|---|---|
| 缺 / 非整数 schemaVersion | `invalid-schema-version` |
| 版本超前（如 99） | `unsupported-schema-version`（含 `found`、`supported: [1, 2]`） |
| 迁移链断档 | `missing-migration`（含 `from`） |

`parseSceneDocument` 顺序：迁移 → 逐步 `onMigrate` 回调 → 严格 zod 校验 → 层级校验。

## 6. 可观测性

1. **`view-change` 事件**（facade 类型化；element 转 CustomEvent），payload `{ view, source }`：
   - `source: "interaction"` ← runtime 上报（OrbitControls `end`）
   - `source: "api"` ← 宿主调用 `setViewState()`
   - `source: "load"` ← 新场景加载应用文档视角（**不置脏**）
   
   源头区分使"视角为何变化 / 为何变脏"可归因。
2. **`getViewState()` 实时读**：文档中保存"最后一次记录的视角"，此 API 读 runtime 真值；二者在交互结束与 `setViewState()` 时收敛（决策 6：不做保存期隐式刷新）。
3. **迁移可观测**：`migrateSceneDocument()` 返回 `applied` 报告，宿主/测试可直接查询是否发生过迁移及 from/to。
4. **错误可观测**：所有迁移错误经既有 `error` 事件面暴露，携带 `detail.reason`。

**已知边界（显式化，避免歧义）**

- **同场景回流后的短暂不一致**：`loadDocument` / `applyRemote` 若 sceneId 未变，不改动视口（决策 4），因此 `doc.view` 采用文档中的值，可能与用户当前视口不一致，直到下一次交互或 `setViewState()` 才收敛（决策 6 的必然结果）。宿主可随时用 `getViewState()` 读取视口真值。
- **sceneId 变化即视为切换场景**：即使经 `applyRemote`，只要 sceneId 改变就应用文档视角（`applyRemote` 与 `loadDocument` 同规则）。
- **v2 文档缺 `view` 字段**：迁移为幂等直通，交由严格 zod 校验拒绝（`Validation` + zod issues），无专属 `detail.reason`。

## 7. 测试计划

- **core**：`migrations.test.ts`（v1→v2 补默认、幂等、四类错误）；`document-schema.test.ts` / `parse.test.ts` 更新（view 必填、hex 校验、字面量版本、`onMigrate` 回调）
- **runtime**：controller-view 测试（`setViewState` 置脏但 `canUndo` 不变、undo 不回滚视角；`loadDocument` 仅新 sceneId 应用；runtime `view-change` → 文档更新 + 置脏；`markSaved` / `clear` 复位）；`FakeRuntime` 补 `getViewState` / `applyViewState` + 调用计数
- **façade**：`view-change` 的 `source` 归因、`getViewState` / `setViewState`
- **element**：`view-change` CustomEvent 桥接
- **three**：`applyViewState` 设 position / target / fov；`getViewState` 往返；交互 end 恰好一次事件；apply 期间零事件
- **e2e**：游乐场加只读钩子暴露 runtime → 转视角 → `requestSave` → 断言 `__savedDocs[0].view` 反映当前相机 → 以新 sceneId `loadDocument` → 断言相机恢复为非默认
- **视觉回归**：默认值与原渲染一致（背景 `null` = 透明），预期既有 5 张快照不变；若变化即为回归

## 8. 影响面与版本

- **破坏性**：`SceneDocument.schemaVersion` 类型 `1 → 2`；既有 v1 测试 fixtures 需更新为 v2，或保留少量 v1 以覆盖迁移路径
- **兼容性**：读路径向后兼容（v1 自动迁移）；写路径一律输出 v2
- **版本**：minor bump → `0.3.0`（新增文档格式 + 向后兼容读取）

## 9. 非目标

- 不持久化 `near` / `far` / aspect、控制器手感参数、renderer 参数（D3 延续）
- 多相机 / 相机动画 / 关键帧
- 视角变化的撤销（决策 3）
- 保存期隐式刷新视角（决策 6）
- 配置开关（决策 2）

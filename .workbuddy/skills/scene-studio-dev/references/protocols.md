# 规程：排查 · 审查 · 发布 · 复盘

摘自仓库 Wiki「AI 开发规则（Agent 必读）」§5–§8，按本仓库的语境落地。

---

## 排查规程

| 轮次 | 要求 |
|---|---|
| 第 1 轮 | **先定根因再改代码**，禁止试错式修补。输出：现象 → 复现路径 → 根因假设 → 证据 |
| 第 2 轮 | 仍未修复 → 接入真实链路（真实输入、日志、trace、实际请求），**停止纯静态推理** |
| 第 3–4 轮 | 仍未修复 → **清空上下文**，重新定义问题、重述约束、重选解法，从零开始 |
| 修复后 | 必须留下**可复现用例**，纳入回归集 |

禁止：连续多轮微调同一处碰运气；未确认根因就叠加多层补丁；隐藏失败尝试。

### 本仓库的排查入口（按症状）

| 症状 | 先查这里 |
|---|---|
| 单测起不来 / `three` 相关报错 | `import` 是否漏了 `type`，或 core/runtime 混进了 three（跑 `check-boundaries.mjs`） |
| 元素在浏览器里行为不对，单测却是绿的 | 单测跑 node + happy-dom；真实链路用 `pnpm test:e2e`，别只信单测 |
| 视觉回归红了但看起来"差不多" | 只比 canvas，1% 容差；先看 `e2e/visual/__screenshots__` 的 diff，再怀疑 SwiftShader 差异 |
| 性能门禁挂了 | 先确认是不是合批失效（`perf.html?instancing=0` 同页对照），再看 draw calls |
| 卸载后 `geometries` 不回基线 | `flushDisposers()` 链断在哪个 rig；资源所有权在 `shared-resources.ts` / `asset-cache.ts` |
| 拖拽卡顿 / 不跟手 | `markDirty` 是否遍历子树；合批代理是否在 layer 1 被漏掉 |
| 首帧变慢 | `setExplode(0)` 是否短路；是否有 `needsUpdate` 全量遍历；是否多加载了 TransformControls |

---

## 审查规程

- **写审分离**：写代码的上下文不得自评为「已通过审查」。审查由独立上下文或独立执行者完成。
  同一次会话里被要求"顺便审一下"时，明确说明这是同一上下文、效力有限。
- **上限 3 轮**：第 3 轮仍未收敛 → 停止迭代，升级为人工决策或提出重构方案。
- **审查必须运行**：至少跑类型检查与相关测试，不能只读 diff。
- **固定六个维度**：
  1. 正确性
  2. 边界与异常
  3. 失败路径（`error` 事件 / `slot="error"` / 降级是否可见）
  4. 非功能项（性能 / 安全 / i18n / 可观测）
  5. 影响面遗漏（三个入口、文档、API.md、fixture）
  6. 可回滚性
- **不复述历史讨论**，输出只针对「当前是否可合并」。
- 违反 AGENTS.md 不变式 1–3 的改动，直接判不可合并，不需要讨论风格。

---

## 发布四要素（缺一不发布）

```
## 发布说明
- 做了什么：<变更内容与目的>
- 影响范围：<受影响的模块 / 入口 / 使用者>
- 如何验证：<命令与预期结果>
- 如何回滚：<回滚步骤与前置条件>
- 风险等级：<L0–L3，及需要人工确认的点>
```

### 本仓库发版前必跑

```bash
pnpm test          # 380 用例 / 37 文件
pnpm typecheck
pnpm build
pnpm test:release  # package/README/LICENSE/repository 一致性
pnpm test:pack     # npm pack → 干净消费者安装/类型检查/构建
```

结构变更再加 `pnpm test:e2e` / `test:e2e:visual` / `test:perf`。
版本号、`exports`、peer 范围、lockfile 变更 = **L3**，动手前先取批准。
`@scenio` 是已在用的 scope（`latest` 以 `npm view @scenio/scene-editor dist-tags` 为准，
2026-11-15 起为 0.7.1）。发布 = 推一个与包版本号相同的 tag，`publish.yml` 走 npm 信任发布
（OIDC），无 token / 无人工 OTP；**推 tag 即执行发布，属 L3，须用户明确要求**，
agent 不得自行 `npm publish`。OIDC 交换若报 `404 package not found`，是 npm 侧 Trusted Publisher
字段没匹配上（不是包不存在），逐字段清单见 TODOS.md §六。

---

## 复盘三步（线上/集成暴露问题后）

只修现象、不回写规则，**视为未完成复盘**。

1. **可复现用例**：产出用例并加入上线前必跑清单（e2e 或 vitest，能红过才算数）。
2. **举一反三**：扫描同类写法 / 同类模块，列出待修清单，而不是只修这一处。
3. **归因并回写**：判定属「规则缺失 / 上下文缺失 / 验证缺失」哪一类，回写到
   `AGENTS.md` / `AGENTS.zh-CN.md` / 本 skill 的 `references/repo-facts.md`。

### 回写到哪个文件

| 归因 | 回写位置 |
|---|---|
| 仓库技术事实变了（分层、陷阱、命令） | `AGENTS.md` + `AGENTS.zh-CN.md`，并同步本 skill 的 `references/repo-facts.md` |
| 流程/协作规则本身有洞 | Wiki「AI 开发规则」（不是 AGENTS.md，AGENTS.md 优先级更低） |
| 验证手段缺失（这个错误没有门禁能拦住） | 加测试用例 / 加门禁脚本，并更新 SKILL.md §1 的门禁矩阵 |
| 只是这次的上下文没给到 | 无需改文件，但在交付说明里写清「未覆盖项」 |

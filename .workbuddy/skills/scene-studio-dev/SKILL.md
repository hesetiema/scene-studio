---
name: scene-studio-dev
description: scene-studio 仓库（@scenio/scene-editor —— 可嵌入的 3D 场景编辑器 SDK，纯 TS 多层包 + playground 宿主）内做任何改动的强制流程。用于：修改 packages/scene-editor 的 core/runtime/element/three/assets 任一层、改 apps/playground（含 apps/playground/src/bim）、新增查看器或编辑器能力、修 bug、跑测试门禁、发版、审查改动、判断"这个改动该不该动手"。提供风险分级与停手判断、验收标准模板、分层落点选择、按改动类型匹配的验证命令、证据输出格式，以及可执行的 import 边界检查脚本。触发词：scene-studio、scene-editor、scenio、模块化体检、边界检查、跑门禁。
---

# scene-studio 开发流程

本 skill 把两套东西合起来用，缺一不可：

| 来源 | 回答的问题 |
|---|---|
| 仓库 Wiki「AI 开发规则（Agent 必读）」 | **能不能动手、什么时候必须停** |
| 仓库 `AGENTS.md` / `AGENTS.zh-CN.md` | **改哪里、怎么证明改对了** |

冲突时按 Wiki §0 优先级：安全规则 > 用户当次指令 > Wiki > 仓库约定（含 AGENTS.md）> 个人习惯。
无法裁决 → **停下来提问**，不要猜着推进。

---

## 0. 动手前先出 5 行清单（不超 5 行，不先写代码）

```
动作：读 / 改 / 删 / 发
风险：L0–L3 + 命中项
影响面：<模块 / 公开 API / 契约 / 调用方>
验收：<具体命令或断言>
缺口：<缺什么；无则写"无">
```

### 风险分级与义务

| 等级 | 特征 | 义务 |
|---|---|---|
| L0 | 文档、注释、无逻辑配置 | 直接做，改完自检 |
| L1 | 单模块内部逻辑，可局部回滚 | 类型检查 + 相关测试 + 自审 |
| L2 | 跨模块、涉及共享资源或**公开契约** | 全量验证 + 影响面清单 + 提请独立审查 |
| L3 | 不可逆、对外接口、CI/基建、全局共享 schema | **先停，取得人工明确批准** |

**本仓库常见的 L3 判定命中项**（看到先停）：

- `SceneDocument` schema 变更 / `view` 加字段（= 文档格式升版 + 迁移 + fixture 重写）
- `RuntimeContract` 加必选成员（一次性打断所有自定义运行时与全部单测）
- `package.json` 的 `exports` / 版本号 / peer 依赖范围 / `pnpm-lock.yaml`
- 删除或重命名任何 `export` 符号（`index.ts`、`element-entry.ts`、`three-entry.ts`）
- `core/events/errors.ts` 的错误码集合
- `.github/workflows/*`、`vite.config.ts` 的 entry / external
- 提交 `apps/playground/public/data/` 或 `public/bim/` 下任何文件（内部标识泄露）

---

## 1. 先定验收标准，再动代码

按改动类型挑门禁，**动手前**就把命令写进清单：

| 改了什么 | 必须跑 |
|---|---|
| 任何代码 | `pnpm typecheck && pnpm test` |
| 涉及跨层引用 / 新增 import | `pnpm test:boundaries` |
| 公开 API、exports、版本、文档 | 再加 `pnpm test:release` |
| 构建产物、入口、external | 再加 `pnpm test:pack && pnpm build` |
| 元素属性 / 查看器交互 / 加载路径 | 再加 `pnpm test:e2e` |
| 渲染输出（材质、光照、着色器） | 再加 `pnpm test:e2e:visual` |
| 合批、拾取、rig、资源生命周期 | 再加 `pnpm test:perf` |

单文件调试：`pnpm --filter @scenio/scene-editor test test/core/document-schema.test.ts`

> pnpm 若报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，说明 `node_modules` 比 lockfile 旧。
> 非交互 shell 下绕过依赖检查、直接调二进制
> （`packages/scene-editor/node_modules/.bin/vitest run <file>`）；**不要手删 `node_modules`**。

---

## 2. 找落点：这个改动属于哪一层

| 要写的是 | 落在 | 硬约束 |
|---|---|---|
| 文档结构、迁移、校验 | `core/document/` | 纯数据，无 DOM 无 three |
| 编辑操作 | `core/commands/` | 一命令一文件；**必须**实现 `mergeWith` |
| 事件、错误码 | `core/events/` | 错误码是封闭集合 |
| 状态机、选择、插件宿主 | `runtime/` | 必须能在 `FakeRuntime` 上跑 |
| 新运行时能力 | `runtime-contract.ts` + `fake-runtime.ts` + `three-runtime.ts` | 三处都写或都不写，且为新**可选**成员 |
| 资产加载、解码器 | `assets/` | |
| three.js：rig / 拾取 / 导出 | `three/` | 一个关注点一个 `*-rig.ts`；创建顺序与跨 rig 连线在 `three/assembly.ts` |
| DOM 属性、slot、生命周期 | `element/` | 分三层：`attribute-math` → `slot-chrome`/`viewer-attributes` → element；改前先读 §已知弱点 |
| 宿主 UI、面板、URL 参数 | `apps/playground/src/` | 永远不是改 SDK 的理由 |

**关键判断**：如果某个「查看器特性」让你想写 `if (isViewer)`，它应该落在
`mode` / `interactive: false` 之后，而不是第二条渲染路径。

详细不变式、陷阱、已知弱点 → `references/repo-facts.md`（改动涉及分层时必读）。

---

## 3. 编码期禁止项

- 不扩大范围：不修无关告警、不重命名无关标识符、不做全仓库格式化。
- 未获批准不新增/升级依赖。
- 不读取或输出密钥、令牌、`.env.*.local`。
- 不猜权限、字段语义、接口行为；不确定就查代码与契约，还不确定就问。
- **不为让测试变绿而放宽断言、加 `skip`、改超时。**
- 不把环境问题当代码问题打补丁。
- 没有可复现用例，不声称修好了缺陷。
- 发现 `docs/ARCHITECTURE.md` 与代码不一致时，改**文档**（准确规则在 AGENTS.md 不变式 3），
  不要反向改代码去迁就过期描述。

---

## 4. 收尾：证据格式（照抄，不要自创）

```
## 验证结果
- 改动范围：<文件/模块清单>
- 验收标准：<逐条 达成 / 未达成>
- 执行命令：
  - `pnpm typecheck` → <结果>
  - `pnpm test` → <通过数/失败数/文件数>
  - `pnpm test:boundaries` → <N 文件 / M 边 / 0 违规>
- 未覆盖项：<没验证的部分 + 原因>
- 风险与回滚：<风险点 + 回滚方式>
```

**没跑验证就只能写「未验证」**，不得用「应该没问题」暗示已完成。

---

## 5. 卡住 / 要审 / 要发 / 要复盘

| 场景 | 去读 |
|---|---|
| 排查修不好（连续多轮） | `references/protocols.md` §排查规程 —— 第 3–4 轮必须清空上下文重来 |
| 要审别人（或自己的）改动 | `references/protocols.md` §审查规程 —— 写审分离，上限 3 轮 |
| 提交 / 发版 | `references/protocols.md` §发布四要素 —— 缺一不发布 |
| 线上/集成暴露问题 | `references/protocols.md` §复盘三步 —— 只修现象不回写规则 = 未完成 |

---

## 常用事实速查

- 入口三个：`.`（core）、`./element`、`./three`；`three` 是 peer，不打包，不进 core/runtime。
  BIM 加载不属于 SDK，在 `apps/playground/src/bim/`（应用级、无单测）。
- 双形态单内核：查看器 = 合成单对象文档 + `mode="viewer"`，不是第二码路。
- SDK 不做宿主 I/O：`save-request` → 宿主 PUT → `markSaved(revision)`；冲突不自动合并。
- `src` 只读一次（连接时）；后改是刻意的空操作。
- 包不附带 CSS；元素是 light DOM，尺寸由宿主给。
- E2E 必须用 `127.0.0.1`，不用 `localhost`（dev server 只绑 IPv4）。
- 数据快照（`public/data/`、`public/bim/`）永不入库。

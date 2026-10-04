# dsh-evermemory — 技术方案概览（步骤 1 交付物）

> 状态：**待你确认**。确认后才进入步骤 2（搭骨架）。
> 本文档的每一条 API 结论都来自对本机真实 DSH 运行时的逆向核对，不是猜测。
> 核对对象：`@deepseek-ai/dsh-desktop-runtime` **0.1.7-rc.2**（从 `D:\软件\Deep桌面版\resources\app.asar` 提取，落在 `D:\SKILL制作\.recon\dsh\@deepseek-ai\`）。

---

## 一、复述：这个插件要做什么

给 DSH Agent 装上**跨会话的长期记忆**，加上一套**行为引导规则**。

目标体验：新开一个会话，Agent 已经知道你是谁、你的偏好、这个项目的技术约定和历史决策，不需要你重新自我介绍、重新对齐需求。你可以用自然语言说"记住这个""忘掉那个"，也可以从别的 AI 工具（WorkBuddy / Claude / ChatGPT / ZCode / Hermes）把记忆导进来。同时，Agent 每次回答前都会遵守你写的规则。

拆成两个模块，因为它们的**触发时机、注入通道、Token 模型完全不同**：

| 维度 | 模块一：行为引导规则 | 模块二：长期记忆库 |
|---|---|---|
| 触发 | 每轮 | 会话结束 / 按需检索 |
| 注入通道 | system-prompt section（早 order） | runtime context（动态）+ section（晚 order） |
| Token 模型 | 静态常驻，前缀缓存友好 | 动态检索，按需注入 |
| 存储 | `~/.dsh/rules/*.md` + 项目级 | SQLite |
| 交互 | 设置面板编辑规则 | 对话式记住/忘记 + 导入导出 |

## 二、八条硬约束（我的理解）

1. **省 Token** — 每轮持续开销 ≤1k tokens，且**不随记忆总量增长**；蒸馏零 LLM 调用。
2. **DSH 原生画风** — 全部用 `--dsw-*` 设计 token、官方 Button 组件、明暗自动跟随，零硬编码视觉值。
3. **四层记忆** — 身份 / 全局 / 项目 / 每日日志。
4. **项目隔离** — 以 git 仓库根为项目身份，worktree 共享同一份记忆。
5. **对话式管理** — 用户说"记住/忘记/更正"就能操作，不需要知道工具名。
6. **多源导入** — WorkBuddy / Claude / ChatGPT / ZCode / Hermes，去重 + 逐条确认。
7. **SQLite 存储** — Markdown 只是导出格式，**不是**存储格式。
8. **零 LLM 蒸馏** — 规则优先；LLM 蒸馏只作为可选的深度模式。

---

## 三、模糊点与需要你拍板的技术决策

核对真实 API 之后，有 **6 处**原方案要么不成立、要么需要你选择，我给出我的建议方案。

### 决策 1（必须改）：常驻索引不能用 system-prompt section

你原方案里"模块二常驻索引注册为一个 late-order section"。**这条在 DSH 里会破坏前缀缓存**。

依据（`dsh-system-prompt/README.md` 的 KV Cache 章节）：system prompt 以 system-role 消息的形式落在**派生历史**里；除非请求声明 `systemPromptUpdate: 'in-history'`，否则非空 prompt 文本会在**第一个 system 节点处被就地重写**，从第一个变化的 token 开始丢失 prefix reuse。

也就是说：**任何动态内容进 section = 每次变化都重写 prompt 头部 = 前缀缓存全废。** 这恰好是约束 1 要防的事。

**我的方案**：注入通道按"是否变化"二分，而不是按"是不是索引"分。

| 内容 | 通道 | 变化频率 |
|---|---|---|
| 行为规则、身份层 | `section()`（**order: 50**） | 用户手动编辑才变 |
| 记忆索引 + 按轮卡片 + 硬约束 | `context()` → user-role 快照 | 每次变化才追加 |

`ctx.systemPrompt.context({ name, order, text })` 的贡献**不进 prompt 文本**，而是被 loop 渲染成一条带 source 的 user-role 消息追加到历史尾部；关键在 `project()`（`dsh-agent-loop/lib/index.js:335-349`）：**渲染文本没变就返回 `undefined`，什么都不注入**。这是引擎自带的去重，我的 Token 预算可以建立在它之上。

**代价**：变化时是"追加"而非"改写"，所以只吃新增 token，不吃重写惩罚。

### 决策 2（必须选）：SQLite 驱动

**已验证**：DSH 宿主进程用 `node:sqlite`。证据 `dsh-session-query-sqlite/lib/index.js:51`：

```js
const { DatabaseSync } = await import("node:sqlite");
```

它同时提供 `ctx.sessionQuery` 的 FTS5 后端，用的就是 `CREATE VIRTUAL TABLE ... USING fts5(...)`（`:107` 持久化表，`:137` 临时表）。

**我的建议**：用 `node:sqlite`，零原生依赖，不打包任何 `.node` 二进制。动态 `import()` 以便优雅降级。

### 决策 3（必须选）：向量检索 vs 纯 FTS5

你原方案是 FTS5 + sqlite-vec + RRF 融合。**问题是 sqlite-vec 是原生扩展**，跨平台分发成本高（而且 asar 内的原生模块加载有额外限制）。

**我的建议**：检索层做成**可替换接口**，默认只上 FTS5（bigram 中文方案）。
- 第一版不引入 sqlite-vec，RRF 框架保留但只有一个检索源；
- 留 `Retriever` 接口，将来想加向量是一次实现替换，不动上层。

理由：约束 1 的省 Token 目标靠的是"注入多少"，不是"召回多准"；FTS5 + bigram 已经够用，而原生依赖会直接影响"可安装 bundle"这个交付物。

### 决策 4（需要定义）：终点蒸馏的触发时机

**已验证**：`agent/turn-stopping` 是**每轮边界都触发的 serial（observer）hook**，不是每会话一次（`dsh-agent-loop/lib/index.js:985`，且它会 steer 保持轮次不关闭）。

如果在这里做完整蒸馏：一个 20 轮的会话会跑 20 次蒸馏管道。

**我的方案**：拆成"采集"和"蒸馏"两段。
- **采集**：始终在跑，挂在 `session/event` 上，增量收集候选（用户消息、工具调用模式、`turn/end`）。
- **蒸馏**：真正落库只在一处——`session/disposed`（或 `agent/disposed`），配合一个空闲防抖兜底。

这样既满足"零 LLM、会话结束落库"，又不会每轮重跑管道。

### 决策 5（需要定义）：四层记忆的存储形态

约束 7 说 SQLite 是唯一存储格式；但你最初的表格里身份层写的是 `$DSH_HOME/evermemory/IDENTITY.md`、每日日志是 `YYYY-MM-DD.md`。

**我的建议**：四层全部是 `memories` 表里的行（`scope = identity | global | project | daily`，每日日志额外带日期字段），`IDENTITY.md` 和日志文件**只作为导出产物**存在，由"导出"动作生成。这样约束 7 无歧义，设置面板的编辑也走同一套 API。

如果你希望保留"`IDENTITY.md` 是真文件、可以手动 git 管理"，请告诉我，我改成单向同步（文件为真源，入库为索引）。

### 决策 6（**必须改**）：设置与面板通信 —— `installSection` 在 0.1.7 已被删除

你的原方案写"宿主半用 `ctx.settings.installSection()` 注册 namespace，浏览器半通过 `settings.plugin.item` / `settings.section` 注册卡片"。核对结果：**`installSection` 在 0.1.7 里已经不存在了。**

版本史（来自真实第三方插件的迁移注释）：

| 版本 | API |
|---|---|
| ≤ 0.1.2-alpha.1 | 自由函数 `installSettingsSection` / `settingsNamespace` |
| 0.1.2-alpha.2 … 0.1.6 | 实例方法 `ctx.settings.installSection(ctx, ns, Config, baseEntry, {setSource, onChange})` ← **你方案里写的这个** |
| **0.1.7+（本机）** | `dsh-settings` 重写为 `SettingsForms`，上述 API **全部删除** |

**0.1.7 的正确做法**：不"装 namespace"，而是**导出 `Config`**（`@deepseek-ai/schemastery` 对象 schema），把用户可编辑字段逐个标 `.volatile()`。**Loader entry 的 `id` 就是 namespace**，`SettingsForms` 自动发现并投影成设置表单。

三个必须绕开的坑：
1. `.volatile()` **返回副本**（不是原地修改），必须收集返回值 —— 否则该行会被判定"无 volatile 字段"而**从 `describe()` 里静默消失**，写入抛 `Plugin entry "<ns>" has no volatile fields`。
2. 必须用 **`@deepseek-ai/schemastery`**，不能用公开的 `schemastery`。只有 DSH 的构建会把 `meta.volatile` 包成 cosmokit `Volatile` 引用；用公开包的话**每次偏好写入都会静默丢失**（写入报成功，值永远不变）。
3. Loader 解析之后，volatile 字段是 **cosmokit 引用对象 `{get(), [write]}` 而不是原始值**，每次读配置都要递归 unwrap。

**还有第二个坑，更影响架构**：浏览器半**不能假设 `ctx.configForms` 可用**。生效中的第三方插件（`dsh-better-sidebar`）在代码里明确记录：*"the DSH settings RPC domain only serves allowlisted namespaces to configuration clients, so the client reads and writes THIS namespace through the plugin's own fenced /sidebar routes instead"*。

**我的方案**：
- 规则开关等**简单偏好** → 宿主导出 `Config` + `.volatile()`，用 entry id 当 namespace（拿到官方设置表单的免费通道）；客户端**先探测** `ctx.configForms`，不可用就降级。
- 记忆数据的 CRUD / 导入预览 / 导出 → 宿主用 `ctx.webServer.register({ kind: 'prefix', path: '/evermemory/api', handler })` 开自己的**带 fence 的路由**，浏览器半同源 fetch。这是唯一被第三方插件验证过可行的路径，不赌 allowlist。

### 决策 7（新增，必须选）：`ctx.storage` 用不用

核对时发现 DSH 自带存储抽象：`ctx.storage` / `ctx.storageDomain`（`defineDomain` + zod 表 schema），后端有 `json`（`single` 整文件重写 / `per-record` 单条重写）。官方文档自己写明：**"数据量大、写入频繁、需要跨记录事务时选 SQLite 后端"**；json 后端无二级索引、无跨表事务、无跨进程写锁。

**我的建议**：**不用 `ctx.storageDomain`，直接用 `node:sqlite`**。理由：
1. 约束 7 明确要求 SQLite；json 后端在 `single` 布局下是"每次写入重写整个文件"，和记忆库的增长模型直接冲突。
2. 我们需要 **FTS5 虚表 + 自建 bigram 索引**，这是 `defineDomain` 的表抽象表达不了的。
3. `dsh-session-query-sqlite` 已证明宿主进程里 `node:sqlite` 可用，直接用它反而依赖更少。

---

## 四、技术方案概览

### 4.1 全局架构

```
┌─ DSH Host 进程 ───────────────────────────────────────────────┐
│  dsh-evermemory (宿主半)                                       │
│    ├─ systemPrompt.section()  ← 模块一：规则 + 身份（静态）     │
│    ├─ systemPrompt.context()  ← 模块二：索引/卡片（动态去重）   │
│    ├─ ctx.on('agent/pre-step')      ← 意图预判 + 工具提示       │
│    ├─ ctx.on('session/event')       ← 候选采集（增量）          │
│    ├─ ctx.on('session/disposed')    ← 蒸馏落库（会话结束一次）  │
│    ├─ 工具集 (evermemory_remember / _forget / _update / _recall / _search …) │
│    ├─ ctx.webServer 带 fence 路由 /evermemory/api/*  ← 面板数据通道     │
│    └─ SQLite 域 (node:sqlite + FTS5 bigram)                    │
└───────────────────────────┬───────────────────────────────────┘
                 同源 fetch │ /evermemory/api/*（fenced）
┌───────────────────────────┴───────────────────────────────────┐
│  DSH Web Client (浏览器半)                                     │
│    └─ settings.section → "记忆与规则" 页面（order: 16）         │
│         ├─ 行为引导规则（全局/项目编辑器 + 预览）               │
│         ├─ 长期记忆（总览/搜索/编辑/导入向导/导出/统计）        │
│         └─ 项目记忆（typeahead 选择器 + 当前项目列表 + 摘要）   │
│    全部使用 --dsw-* token + 官方 Button，明暗自动跟随          │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 文件结构

```
dsh-evermemory/
├── package.json               # 真正的 manifest：dsh.bundle / dsh.client / exports
├── cordis.patch.yml           # loader id（insert.id = 导出的 cordis name = 设置命名空间）
├── dsh.plugin.json            # **市场目录用，非 manifest 规范**；删掉不影响运行
├── tsconfig.json              # 宿主半
├── tsconfig.client.json       # 浏览器半
├── tsdown.config.ts           # 双构建
├── README.md / README.en.md
├── LICENSE
├── src/                       # ── 宿主半 ──
│   ├── index.ts               # 插件入口：装配各子系统 + 注册 section/context/hooks/tools/routes
│   ├── config.ts              # 导出 Config（@deepseek-ai/schemastery，逐字段 .volatile()）
│   ├── constants.ts           # order 常量、预算常量、layer 枚举、工具名前缀
│   ├── routes.ts              # ctx.webServer.register 的 fenced API（CRUD/导入预览/导出）
│   ├── storage/
│   │   ├── db.ts              # node:sqlite 打开/迁移/schema
│   │   ├── schema.sql         # 你给的建表语句（含 FTS5 虚表）
│   │   └── memories.ts        # CRUD + 四态合并 + 冲突检测
│   ├── retrieval/
│   │   ├── tokenize.ts        # 查询片段切分（合并相邻 CJK）+ 长度 >=3 判定
│   │   ├── fts.ts             # FTS5 MATCH 构造：逐片段加引号，查询语法永远当数据（§4.6 ⑤）
│   │   ├── like.ts            # <3 字片段的 LIKE 兜底（ESCAPE '!'，通配符自行转义）
│   │   ├── rank.ts            # 排序 + RRF 框架（当前单源）
│   │   └── retriever.ts       # Retriever 接口
│   ├── distill/
│   │   ├── collect.ts         # 从 session/event 增量采集候选
│   │   ├── extract.ts         # 规则管道：偏好/模式/决策
│   │   ├── score.ts           # 质量问题："不记住会不会导致模型做错"
│   │   ├── scope.ts           # 层级判定
│   │   └── merge.ts           # NEW/MERGE/UPDATE/IGNORE + 冲突标记
│   ├── inject/
│   │   ├── context.ts         # systemPrompt.context 注册（索引/卡片/硬约束）
│   │   ├── budget.ts          # ≤300/≤200 硬截断
│   │   ├── dedup.ts           # 按 id 跨轮去重
│   │   └── index-card.ts      # 索引与卡片文本渲染
│   ├── rules/
│   │   ├── loader.ts          # ~/.dsh/rules + <project>/.dsh/rules 两级合并
│   │   └── section.ts         # 模块一 section 注册
│   ├── identity/
│   │   ├── project.ts         # git root / worktree / marker 文件 / cwd 回退
│   │   └── project-key.ts     # project_key + sub_id 计算
│   ├── tools/
│   │   ├── remember.ts / forget.ts / update.ts / recall.ts / search.ts
│   │   ├── import.ts / export.ts
│   │   └── hint.ts            # pre-step 关键词预判 → 注入工具提示
│   └── importers/
│       ├── workbuddy.ts / claude.ts / chatgpt.ts / zcode.ts / hermes.ts
│       ├── generic.ts         # 粘贴文本 / Markdown / JSONL
│       └── ledger.ts          # import_ledger 哈希去重
├── src/client/                # ── 浏览器半 ──
│   ├── index.ts               # 客户端插件入口
│   ├── settings-entry.ts      # settings.section 注册
│   ├── panels/                # RulesPanel / MemoryOverview / ProjectMemory / ImportWizard / DistillLog
│   ├── components/            # 官方 Button 封装、列表、卡片、开关
│   ├── api.ts                 # 远程命名空间客户端
│   └── locale.ts              # 中英文案
└── tests/                     # 见 §4.5
```

### 4.3 关键依赖

```jsonc
// peerDependencies —— 宿主提供，绝不打包（已在 profile 的 node_modules 中验证：
// @deepseek-ai/* 只有 cosmokit 和 schemastery，其余由宿主进程从 asar 注入）
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.4",
  "@deepseek-ai/dsh-agent": "0.1.7-rc.2",
  "@deepseek-ai/dsh-llm": "0.1.7-rc.2",          // createUserMessage
  "@deepseek-ai/dsh-settings": "0.1.7-rc.2",
  "@deepseek-ai/dsh-system-prompt": "0.1.7-rc.2",
  "@deepseek-ai/dsh-tools": "0.1.7-rc.2",         // defineTool
  "@deepseek-ai/schemastery": "~3.18.4"           // z（Config 的 volatile 字段）
},
// 浏览器半（宿主 web client 提供）
"@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings",
"@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-theme",
"@deepseek-ai/dsh-client-locale", "react"
```

零运行时 `dependencies`：SQLite 用 `node:sqlite`，其余全是宿主注入。宿主半需要 `ctx.inject(['tools','settings','webServer'], …)` 做**可选注入**。

构建：TypeScript + `tsdown`（双 tsconfig，与参考插件 `dshmarket` 同一套）；测试：`vitest`。

**客户端 bundle 必须是单文件**：DSH 客户端模块系统只支持自包含 chunk —— "entry and chunk outputs cannot synchronously require another relative `client*.js` output"。所以浏览器半要在构建期拼成一个 `lib/client.js`（`dsh-memory-palace` 就是按 `00-head … 90-tail` 拼的）。

### 4.4 已验证的注入代码形态

**工具注册** —— `ctx.tools.register(defineTool({...}))`，`parameters` 既不是 zod 也不是 schemastery，是 DSH 自己的属性表 DSL：

```ts
ctx.tools.register(defineTool({
  name: 'evermemory_remember',              // 工具名全局无前缀，必须自带命名空间
  description: '…',
  parameters: {
    text: { type: 'string', required: true, description: '…' },
    scope: { type: 'string', description: 'global | project | session' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'number', required: true } } },
    render: (_args, v) => [{ type: 'text', text: `已记住 #${v.id}` }],
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()            // C6 约定：任何 fs 工作之前
    return { id: await remember(args) }     // 返回 canonical JSON 值，不是 {content:[…]}
  },
}))
```

约定（来自参考插件注释引用的 `plugin-development-guide.md §3`，该文件本身不在盘上，只有四条存活在代码注释里）：**C1** 参数在 `execute` 之前 schema 校验；**C4** `execute` 返回一个 canonical JSON 值，`render` 是独立的纯投影；**C6** `exec.signal.throwIfAborted()` 在任何 fs 工作之前；**C10** canonical 值里不出现 UI/传输词汇。

错误就是 `throw new Error(msg)`，注册表自己合成模型可见的错误内容（模型看到 `Error: <msg>`）。`register()` 返回绑定到调用 fiber 的 disposer，所以工具可以随开关动态注销。

**模块一（静态 section）** — `ctx.systemPrompt.section()` 真实签名（`dsh-system-prompt/lib/index.js:241-244`）：

```js
section(section) {
  if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
  return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
}
// 字段：name（层内唯一）/ order（有限数）/ text: string | (ctx) => string
//       / interpolate?: boolean / complete?: true
// 没有 scope 字段 —— 作用域隐含在注册它的 context 上
```

order 100–200 **已确认不是空的** —— 生态实测表明 **100–199 是 tool guidance 的占用带**（`dsh-mnemosyne/docs/design.md:291` 原文："注册一个 order=95 的 prompt 段（**在 tool guidance 100-199 之前**）"）。我原先按"一线 harness 只占了 -1000/10000/10100/10200"判断它空闲，**这个判断是错的，必须修正**。

从 13 个生态插件实测汇编出的 order 地图：

| order | 占用者 |
|---|---|
| `-100` / `-1000` | harness identity |
| `0` | persona（`DEPLOYMENT_PERSONA_PREFIX`） |
| `1` | `@jipika/dsh-memory` 记忆段（"紧跟 persona，先于工具规范"） |
| `16` | `dsh-destinywind-memory` 的设置 slot |
| `50` | `dsh-memory` 召回段 **且** `dsh-charter` 规则段 **且** mnemosyne 设置 |
| `90` / `95` | memory-manager 索引/工具引导、mnemosyne prompt 块 |
| **`100–199`** | **tool guidance（权威占用）** |
| `216` | `dsh-destinywind-memory` 全库段 |
| `9999` | destinywind 末尾一行"记忆核对"提醒 |

**模块一取 `order: 50`** —— 有 `dsh-memory` 和 `dsh-charter` 两个先例，位置语义是"persona 之后、工具引导之前"，正是行为规则该待的地方。

**模块二（动态 context + pre-step）** — 这是 DSH 自己的 `dsh-agent/lib/index.js:194-205` 用法，我照抄：

```js
agentCtx.on("agent/pre-step", async ({ agent, messages, signal, step }, next) => {
  const decision = await next();                       // 先跑下游
  if (decision.kind === "reject" || signal.aborted) return decision;
  // …判定本次是否要注入…
  return { ...decision, messages: [...decision.messages, myUserMessage] };
}, { prepend: true });
```

要点：`agent/pre-step` 是 **waterfall**，**每个 step 都触发**（不是每轮），所以按轮卡片必须**按 memory id 跨整个会话去重**；`messages` 是本次 step 被 claim 的冻结批次；注入物是用 `createUserMessage()`（来自 `@deepseek-ai/dsh-llm`）构造的**完整 user-role 消息对象**，不是字符串。

**cwd**：`agent.session.header.cwd ?? process.cwd()`（`cwd` 是可选字段）。
**历史**：`agent.session.deriveMessages()`；`eventAt()`/`snapshotEvents()`/`ownEvents()` 已被官方标记为**禁止用于新生产代码**，不碰。
**轮末**：`agent/turn-stopping`（serial，可 steer 续轮）。
**持久事件**：`ctx.on('session/event', (session, event) => …)`，`event.type === 'turn/end'`。

### 4.5 生态实测证据（13 个同类插件汇编）

侦察了生态里 13 个记忆/规则插件（含 `dsh-memory-palace` 1403 dl/wk、`dsh-memory-manager` 692、`dsh-memory` 684、`@jipika/dsh-memory` 537、`dsh-memory-plus`、`dsh-mnemosyne`、`dsh-palimpsest`、`dsh-agent-memory`、`dsh-memory-porter`、`dsh-rules`、`dsh-charter`、`dsh-discipline-guard`）。四条直接改变设计的证据：

**① 你的 216/100/9999 三层方案已被实证。** `dsh-destinywind-memory` 的 README 原文表格：`order: 216` 全库段拆「硬性约束（必须遵守）」与「背景知识（相关时参考）」两组；运行时上下文 `order: 100` **只放硬性约束**，作为 user 角色快照每轮刷新；`order: 9999` 放一行"记忆核对"提醒利用末尾注意力。它的理由值得抄进设计文档：*"一条「请参考」的软措辞埋在系统提示中段，是模型最容易跳过的东西。"*

**② 每个文件的预算不是每轮的预算 —— 这是最大的设计陷阱。** `dsh-memory-palace` 自己承认的最坏情况：`userBudgetChars: 8000` / `workspaceBudgetChars: 6000` 是**每个文件各自**的上限，而注入份数 = 用户级 1 + 项目级 MEMORY.md（最多 4）+ 今日日志（最多 3），**实测最坏 8 条消息 ≈ 5 万字符 = 标称值的 7.1 倍**。

→ 我的预算必须**按轮强制**，不是按条目或按文件。这也解释了为什么"索引注入"（只给名字 + 描述，正文靠 `memory_get` 按需读）能比全量注入省一个数量级 —— `dsh-memory-manager` 的原话。

**③ 绝不允许读全局 `activeSession`。** `dsh-memory-palace` 真实 issue #1「E 投影在多会话并发/切换工作区时未透传会话 cwd 导致跨项目记忆串台」和 issue #3「写侧串台：#2 只修了『读』方向…`_settle` 仍读全局 `state.activeSession` 导致日志写错项目」—— 两个都已关闭，但这是**读方向修完写方向还在漏**的典型。

→ 设计约束：**读路径和写路径都必须显式传递 session / cwd**，任何地方都不从全局状态推断当前会话。

**④ 中文召回在整个生态里是坏的 —— 而且整个生态为此开错了药。** `dsh-memory-plus` 记录的实测：DSH 官方的 `dsh-session-query-sqlite` 用 FTS5 `unicode61`，对 CJK 不切词 —— 查询 `Token消耗` 返回 **0 命中**，必须完整复现整个句子才命中。它的结论是"**整个生态的中文召回都是坏的**"。我在本机复现了同一现象（下面的 §4.6 有完整实测）。

→ 我起初照抄了生态的解法："双 tokenizer 双表（unicode61 + bigram），按查询是否含 CJK 自动路由"。**但实测证明这个方案是多余的**：单张 trigram 表加上 1–2 字的 `LIKE` 兜底就覆盖了两者，而且没有"查错表"这个失败模式。详见 §4.6。

**其他值得抄的做法（不改变架构，写进实现规范）**：

| 来源 | 做法 |
|---|---|
| `dsh-rules` / `dsh-palimpsest` | 注入内容必须转义，使其**永远无法闭合插件自己的框架标签**（`</system-reminder>` 一类）；检索结果用随机 token 作边界，失败时 fail-closed |
| `@jipika/dsh-memory` | 写路由要求自定义头 `x-dsh-memory: 1` —— 浏览器跨站简单请求带不上自定义头，**省掉一整类 CSRF** |
| `dsh-memory` | 检索时**给每个 token 加引号**，模型顺手打的 FTS5 语法（`OR` `*` `-` `"`）一律按字面量匹配 |
| `dsh-charter` | *"SOUL 的教训是「文本存在 ≠ 被遵守」"* —— 能机械化的规则放代码层 gate，不能机械化的才放 prompt 文本。这划清了模块一和 `dsh-gates` 的边界 |
| `dsh-discipline-guard` | *"the model cannot argue with the tool pipeline never running"* —— prompt 级提醒只是建议性的，真正硬的门在 `tools/pre-execute` |
| `dsh-memory-porter` | 三条硬规矩：**无逐字证据不入库**（代码回原文逐字核对，不信模型自述）/ **AI 推断的绝不自动入库** / 数据只在用户自己机器上 |
| `dsh-project-memory` | *"Human approval is a hard boundary: model tools cannot approve or archive memory."* |
| `dsh-memory-palace` | 卸载不删数据，且需明确文档化这个策略 |
| `dsh-agent-memory` | 融合实测（382 条 held-out 查询）：纯词法 MRR 0.7248 / Recall@1 63.4%，纯语义 0.7121 / 61.3%（**输给词法**），融合 0.8432 / 76.4% —— "增益全来自融合"。且它**拒绝打包模型文件** |
| 生态普遍 | `node:sqlite` 在 Node 22/24 是 experimental，**每次运行会打一次 `ExperimentalWarning`**；`engines.node` 普遍要求 `>=22.19` |

**差异化结论**：生态里**没有任何一个插件支持多源导入** —— porter 做 Claude/Claude Code/ChatGPT，memory-manager 做 ZCode，palace 做 WorkBuddy/CodeBuddy。你的约束 6（WorkBuddy + Claude + ChatGPT + ZCode + Hermes 五源合一）是**尚未被占据的位置**，这是这个插件最清晰的差异化轴。

### 4.6 检索层实测（本机跑出来的，替换掉生态的通行做法）

生态里的标准解法是"双 tokenizer 双表 + 按语种路由"。我在本机把这条路径拆开验证，结论是**它解决的是症状，不是病因**，并且引入了一个新的失败模式。以下是全部实测数据（Node v24.19.0，`node:sqlite`，5000 行语料）。

**① `unicode61` 不是"对 CJK 不好"，是"完全不切"。** 文档 `索引优化减少Token消耗的句子` 的 FTS5 词表只有一个条目：

```
unicode61 vocabulary for the doc: ["索引优化减少token消耗的句子"]
```

整段中文被当成**一个 token**（英文部分被正常小写化）。所以对它的任何"部分匹配"都不可能命中 —— 查询 `索引优化` / `索引` / `句子` / `Token消耗` **全部返回 0 行**，只有复现整句才行。这解释了生态里所有同类报告。

**② `trigram` 一张表就覆盖了中英文，不需要双表。** 同一段文档：

| 查询 | unicode61 | trigram |
|---|---|---|
| `索引优化` | 0 | **1** |
| `Token消耗` | 0 | **1** |
| `Token` | 0 | **1** |

→ trigram 同时解决了 CJK 子串和无空格边界两个问题。再加一张 unicode61 表只会在查询时多一次"该查哪张表"的猜测，而猜错就是静默 0 命中。**决策：单张 trigram 表。**

**③ trigram 的硬边界是 3 个字符，不是"中文"还是"英文"。** 逐个字符测下来（中英文同一规则）：

| 长度 | CJK | 拉丁 |
|---|---|---|
| 1 字 | 0 命中 | — |
| 2 字 | 0 命中 | 0 命中 |
| 3 字 | **1 命中** | **1 命中** |

危险的细节：**低于 3 字符时 trigram 是静默返回 0，不报错。** 所以路由必须是显式的"分词后每个片段长度 ≥3 才走 FTS"，否则 2 字查询会得到一个看起来合法的空结果。

→ **决策：按"每个查询片段长度"路由，不按语种路由**；长度 <3 的片段走 `LIKE` 兜底。
→ 顺带一个好消息：我的关键词抽取器本来就要合并相邻 CJK 片段，所以 `项目 约定` 会被并成 `项目约定`（4 字）走 FTS 命中；而如果按生态的双表方案先做"是否含 CJK"判断，反而更容易把 `项目` 单独送去查 trigram 表拿到 0。

**④ `LIKE` 兜底便宜到不需要优化。** 5000 行、正文含长中文和 32 字符 UUID 的语料上：`LIKE '%项目%'` **1.8 ms**、`LIKE '%约定%'` **0.5 ms**（trigram `MATCH` 是 0.1–1.2 ms）。同一量级，所以 1–2 字查询直接 `LIKE` 即可，不必为它维护第二套索引。
→ 参数化时必须写 `ESCAPE '!'`：`LIKE` 的转义符只能是单字符，而且 `%` / `_` 仍要在传入前自行转义。

**⑤ 一个生态文档没写、但会直接抛异常的坑：原始用户文本不能直接喂给 `MATCH`。** 实测：

| 查询 | 原始 `MATCH` | 逐 token 加引号后 |
|---|---|---|
| `OR` | **抛** `fts5: syntax error near "OR"` | ok |
| `*` | **抛** `unknown special query:` | ok |
| `'` | **抛** `fts5: syntax error near "'"` | ok |
| `NEAR(` | **抛** `fts5: syntax error near ""` | ok |
| `项目 OR` | **抛** `fts5: syntax error near ""` | ok |
| `a AND b` | ok | ok |

`dsh-memory` 已经有"给每个 token 加引号"的做法，但生态文档没有说明**不加会抛异常**（多数插件的检索路径会因此直接失败，而不是降级）。而且这一条恰好是**用户最可能输入的** —— "记住 OR 的用法"这类内容并不罕见。

→ **决策：`MATCH` 的实参永远由代码构造，绝不拼接用户原文。** 逐片段加引号（内部 `"` 翻倍），相邻片段之间保持**隐式 AND**（实测 `"cache" "policy"` 与 `"cache" OR "policy"` 命中数相同，因为语料里两者共现；这里取**精确优先**的 AND 语义，符合 `dsh-agent-memory` 的 `noMatchThreshold` 教训："给一条勉强相关的记忆不是中性的 —— 它要花注意力，还会误导"）。

**⑥ `detail=none` / `detail=column` 不可用。** 两者都会让**短语查询直接抛** `fts5: phrase queries are not supported`，而上面的方案完全建立在加引号的短语查询上。
→ **决策：`tokenize='trigram'`，保持默认的 `detail=full`。**

**⑦ 顺带证伪了一条网上流传的说法。** 有资料称 trigram 的 `detail=full` 只索引前若干字符、尾部会丢。实测 554 字符文档，`uniquetailword` 位于**偏移 497**，`MATCH` 正常命中 1 行 —— 该说法在本环境不成立，不必为它设计分块补偿。

**⑧ 外键级联在本环境是可信的。** `ON DELETE CASCADE`（schema 里 `tags.memory_id` 靠它）实测生效：删父行后子表剩 0 行，`PRAGMA foreign_key_check` 返回空。前提是打开 `enableForeignKeyConstraints` —— SQLite 默认是关的。

→ **决策：`new DatabaseSync(path, { enableForeignKeyConstraints: true })`**，并把这条写进存储层的构造函数，不依赖"某处会记得执行 `PRAGMA`"。

### 4.7 测试计划（对应你列的 12 项）

| 测试 | 手段 |
|---|---|
| 跨会话召回 | 建库 → 写 → 重开 → 检索 |
| 对话式记住/忘记 | 工具直调 + 关键词预判 |
| 中文检索 | **单张 trigram 表** + 按片段长度路由（<3 字走 `LIKE`，`ESCAPE '!'`）+ `MATCH` 实参全部由代码加引号构造。已本地实测 unicode61 对中文整段成单 token、trigram 3 字为硬边界、原始查询文本会抛异常 |
| 冲突处理 | NEW/MERGE/UPDATE/IGNORE 四态 + outdated 标记 |
| 多源导入去重 | 五源 fixture + import_ledger 哈希 |
| 设置面板 CRUD | 宿主 API 层测试（浏览器半不跑 e2e） |
| 一键开关 | section/context 注册与注销 |
| 规则注入 | 断言渲染后的 prompt 文本 |
| 前缀缓存验证 | 断言未变化时 `project()` 不产生新消息 |
| 项目隔离 | git root / 嵌套仓库 / 非 git 回退 |
| worktree 共享 | git-common-dir 哈希一致 |
| **每轮预算强制** | 注入 8 层记忆 + 跨轮去重后，断言单轮总注入 ≤1k tokens（防 palace 那种"每文件达标、每轮 7.1 倍"） |
| **并发会话隔离** | 两个会话（不同 cwd/项目）交替读写，断言**读和写两个方向**都不串台 |
| DSH token 合规 | 扫源码：颜色/圆角/字号不得出现字面值，必须 `--dsw-*` |

---

## 五、请你确认的清单

1. **决策 1（必改项）** — 常驻索引不能走 section，改走 `context()`（动态、文本去重、追加不重写）。同意吗？
2. **决策 6（必改项）** — `installSection` 在 0.1.7 已删除：规则偏好改成"导出 `Config` + 逐字段 `.volatile()`，entry id 即 namespace"；记忆数据走自带 fenced 路由。同意吗？
3. **决策 2** — SQLite 用 `node:sqlite`，并用偏好开关做饥饿式注册（开关关掉时完全不注册相关工具），同意吗？
4. **决策 3** — 第一版不做 sqlite-vec，检索层留可替换接口，同意吗？
5. **决策 4** — 采集与蒸馏分离（`session/event` 采集 + `session/disposed` 落库），同意吗？
6. **决策 5** — 四层记忆全部入库，Markdown 仅作导出；`IDENTITY.md` 要不要保留为真文件？
7. **决策 7（新增）** — 不用 `ctx.storageDomain`，直接用 `node:sqlite`，同意吗？
8. **决策 8（新增，来自生态教训）** — 并发安全作为硬设计约束：读路径和写路径都显式传 session/cwd，任何地方都不读全局"当前会话"状态。同意吗？
9. **决策 9（新增）** — 模块一 section 取 `order: 50`（不是原方案的 100–200，那段被 tool guidance 占了）。同意吗？
10. **决策 10（新增）** — 要不要保留 `order: 9999` 的末尾一行"记忆核对"提醒？destinywind 用它吃到末尾位置的红利，但代价是它一变就重写 prompt 头。我倾向**做成开关，默认关**。
11. **工具命名** — 五个记忆工具加 `evermemory_` 前缀（`evermemory_remember` 等）避免全局撞名。可以吗，还是你想要短名？
12. 模块一规则目录：`~/.dsh/rules/*.md` + `<project>/.dsh/rules/*.md` 两级覆盖（项目优先）—— 确认吗？
13. 项目记忆库文件位置：全部集中在 `$DSH_HOME/evermemory/`（靠 `project_key` 隔离），而不是往每个项目里写 `.dsh/evermemory/`。我倾向集中，这样 worktree / 多仓库切换不会到处留文件。

---

## 六、还差的最后一块侦察

生态横评已完成并并入 §4.5。**客户端 slot / 设计 token 细节**（`settings.section` 的 props 形状、`--dsw-*` token 清单）仍在跑 —— 它只影响步骤 8 的实现细节，不改架构，不阻塞你现在确认。

另外侦察中发现了两个要在实现时验证的运行时风险，先记在这里：
- **`connection.rpc.handle()` 有已知路由 bug**（0.1.5-rc.2 引入，0.1.6-alpha.2 仍未修）：它内部用调用方 ctx 解析 `webServer`，解析不到就抛 `cannot get property "webServer" without inject`，表现为 HTTP 405 + 通道静默丢失。规避法是**先试 `handle()`，失败则回退到 `ctx.inject(['connection','webServer'])` 注册 prefix 路由**并复用 `connection.requestRejection()`。**需要重启才能生效。**
- **`node:sqlite` 在 Node 22/24 属 experimental**，每次运行会打一次 `ExperimentalWarning`；生态插件的 `engines.node` 普遍要求 `>=22.19`。所以 SQLite 相关能力要做**饥饿式注册**：开关关掉时完全不 import、不注册工具。

确认（或修正）之后我进入步骤 2：搭项目骨架。

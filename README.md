# dsh-evermemory

跨会话长期记忆 + 行为引导规则，为 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）提供"越用越懂你"的体验。

新开一个会话，不需要你再自我介绍一次、重新对齐需求、重新解释项目背景。

> **状态：功能完整，首个版本 0.1.0。** 存储层、蒸馏引擎、注入引擎、工具集、导入引擎与设置面板均已实现，
> 424 项测试覆盖契约、预算不变量与各模块行为；功能模块见 [路线图](#路线图)。

---

## 它解决什么问题

DSH 的会话是隔离的。昨天跟它讲清楚的项目约定、技术选型、你的输出偏好，今天全部归零。

`dsh-evermemory` 做两件事：

| | 模块一：行为引导规则 | 模块二：长期记忆 |
|---|---|---|
| **触发** | 每轮 | 会话结束 / 按需 |
| **注入** | 系统提示段落（早期 order） | 运行上下文（按需） |
| **Token 模型** | 静态常驻，前缀缓存友好 | 动态检索，变了才注入 |
| **存储** | `~/.dsh/rules/*.md` + 项目级 | SQLite |
| **交互** | 设置面板编辑 | 说话即可「记住/忘记」 |

两者共用一套存储层，除此之外几乎没有交集——**正是这个分工守住了 Token 预算**。

### 用对话管理记忆

记忆是「被要求才写」，不是「被偷看后写」。插件不拦截用户消息去猜什么值得记，而是提供四个工具，
并把「什么时候该用」写进提示：

| 工具 | 作用 |
|---|---|
| `evermemory_remember` | 记一条；层级（`global` / `project`）由文本推断，也可显式指定 |
| `evermemory_forget` | 按 id 归档一条——不删除；身份层会被拒绝，因为那是一份你自己编辑的文件 |
| `evermemory_search` | 按关键词检索，或按层列出 |
| `evermemory_log` | 追加到当天的工作日志，一天一行 |
| `evermemory_import` | 从别的 AI 工具的记忆/会话文件里搬东西进来，逐条报告判定 |

显式 `remember` 与自动路径走同一套门槛和合并逻辑，所以「记住」一条纠正会顶掉它纠正的那条陈述，
而不是并排躺着。被拒绝的写入会带着理由回给模型——「太长，不像一条记忆」是一个真实答案；
静默失败则会让模型宣称自己记住了其实没写进去的东西。

### 把别的工具的旧记忆搬过来

`evermemory_import` 只认你给的那个路径，从不自己到处翻。它按**内容形状**判断来源，而不是按文件名：
Claude 和 ChatGPT 导出的文件都叫 `conversations.json`，一个里面是扁平的 `chat_messages` 数组，
另一个是 `mapping` 树——信文件名就会把 ChatGPT 导出当成空的 Claude 导出，然后「成功」地导入 0 条。

| 来源 | 认什么 |
|---|---|
| ChatGPT | `conversations.json`（或导出的 .zip；分片 `conversations-1.json` 同样认） |
| claude.ai | `conversations.json`，扁平消息数组，附件正文一并取 |
| Claude 记忆 | `memories.json`：`conversations_memory` / `project_memories` / `memory_files` |
| Claude Code | `~/.claude/projects` 目录或单个 `.jsonl`（排除 thinking、工具调用、子代理旁支） |
| ZCode | `~/.zcode/cli/memories` 或其中单个项目（frontmatter 平铺或嵌在 `metadata:` 下都认） |
| WorkBuddy / CodeBuddy | `.workbuddy` / `.codebuddy` / `.deepseek-harness` 目录，或一个 `<workspace>_memory.md` |
| 通用 | Markdown（按标题或段落）、`.txt`、JSON Lines、JSON，以及本插件自己的导出（可回环） |

导入的条目默认进 `global` 层（可用 `scope: "project"` 指定进当前项目）；`dryRun` 只报数不落库；
同一个文件重复导入由 `import_ledger` 跳过，而**归档**一条记忆不会让它的原文被重新导入——
你收起来的东西不该被下一次导入翻出来。Hermes 没有可核对的落盘格式，因此按通用 JSON / JSONL /
Markdown 处理，不假装认识它的私有存储。

---

## 设计原则

### 1. 每轮开销 ≤1k tokens，且不随记忆量增长

这是首要约束，也是最容易悄悄失守的一条。

关键在于**预算按「轮」算，不是按「条」算、更不是按「文件」算**。生态里最典型的反面案例是
`dsh-memory-palace`：它公布了 8000 字符的用户级预算和 6000 字符的项目级预算，但两者都是
**「每个文件各自」**的上限——于是实测最坏情况是 8 条注入消息约 5 万字符，**是自己所定上限的 7.1 倍**。
每个限额都单独达标，整轮却爆了。

本项目的三条通道合计上限（2500 字符）被强制约束在轮预算（4000 字符）之内，并由
`tests/budget.test.ts` 断言，而不是写在文档里靠自觉。

### 2. 前缀缓存友好

DSH 的系统提示会作为**派生历史**的第 0 个系统节点发往模型。没有 `systemPromptUpdate` 时，
非空提示文本会在**第一个系统节点处按节点替换**——也就是说，**提示头部任何改动，都会从第一个变化的
token 起失去前缀复用**。

这决定了两条通道的分工，没有商量余地：

- **会变的** → 走运行上下文（runtime context）。它把内容作为一条带来源的 user 消息**追加**在缓存前缀
  之后，并且**只在渲染文本真的变化时才注入**。
- **不变的** → 才走 `section()`。规则与身份每次会话都稳定，放进提示头部，由前缀缓存付一次钱。

把每轮索引塞进 `section()` 是初版方案的错误，会把缓存收益整个赔掉。

### 3. 零 LLM 蒸馏

候选抽取走确定性规则（事件流里的显式偏好表达、重复出现的工具调用模式、用户给出反馈的决策），
质量评估与作用域判定同样走规则。**不额外调用任何模型**——当前会话的 Agent 顺手完成写入。

### 4. SQLite 是真源，Markdown 只是导出格式

唯一例外是身份层：`IDENTITY.md` 是**真源**，数据库里那行只是索引。它保持为一个用户可以手工编辑、
可以纳入 git 管理的普通文件，插件在启动时和文件变化时把它同步进数据库。

为什么不用 Markdown 存正文——同一个生态里的 `dsh-destinywind-memory` 从自己的 v1 Markdown 格式
迁移时记录了原因：正文里一行以 `## ` 开头的内容会**把这条记忆劈成两半并吞掉标题**；
一行 `<!-- tags: x -->` 注释会被当成**真实标签**写回去；`###`、列表、引用、代码围栏都可能被
宽松解析器**当作结构丢弃**。数据库没有这个歧义：**正文是一个不透明的值，任何解析器都不会再去解释它**。

### 5. 项目隔离以 git 仓库根为身份

`git rev-parse --show-toplevel` 取仓库根（嵌套仓库取最内层）；worktree 通过
`git rev-parse --git-common-dir` 共享同一个 `project_key`；非 git 目录向上找最近的标记文件
（`.dsh/`、`package.json`、`pyproject.toml` …）；都找不到才退回 `cwd`；仍无法确定时
**只在会话内临时记忆，永不写入项目层**。

记忆统一存放于 `$DSH_HOME/evermemory/`，按 `project_key` 隔离——**不往每个项目目录里写文件**。

### 6. 并发安全：显式传递会话，绝不读全局状态

这一条来自真实事故。`dsh-memory-palace` 的 #1 是「多会话并发时未透传会话 cwd，导致跨项目记忆串台」；
#3 记录了它的修复只覆盖了**读**方向——**写**方向的 `_settle` 仍在读全局 `state.activeSession`，
于是日志写进了错误的项目。

所以：**读路径和写路径都必须显式接收 session/cwd，任何一边都不许从全局状态推断当前会话。**

---

## 安装

```bash
# 从 npm
dsh plugin --profile web add dsh-evermemory

# 从本地 tarball —— 必须给绝对路径：`dsh plugin` 是在 profile 目录里执行 pnpm 的，
# 相对路径会相对那里解析，而不是相对你当前的目录。
npm pack
dsh plugin --profile web add "$(pwd)/dsh-evermemory-0.1.0.tgz"     # bash
dsh plugin --profile web add "$PWD\dsh-evermemory-0.1.0.tgz"       # PowerShell
```

profile 开了 `dsh-hmr` 就即时生效，否则重启 DSH；然后设置 → **记忆与规则**。

## 设置面板

设置 → **记忆与规则**，五个标签页：

| 标签页 | 做什么 |
|---|---|
| 偏好 | 十个开关、额外规则目录、保存 / 放弃（对着实时 config 快照改） |
| 记忆 | 分页列表、全文检索、按层级 / 状态 / 项目筛选、就地编辑、置顶、归档 |
| 记住 | 手写一条记忆（等同对话里的 `evermemory_remember`） |
| 每日 | 查看某一天的日志并追加一笔 |
| 数据 | 导出 Markdown；从别的工具导入（可先预览） |

面板的每一条数据都经宿主机侧的 `/evermemory/api` 路由读写，**面板本身不碰数据库**：

- 这条路由只依赖 `connection` 服务——同源校验（Host / Origin）与浏览器会话 cookie 组成的围栏
  在那里。只有 web server 而没有 connection 服务的宿主机**既拿不到路由、也看不到页面**：
  浏览器侧本来就要经同一个服务取数，两半一起降级，好过给用户一个每次请求都失败的页面。
- 请求体是从 socket 来的，所以宿主机侧把每个字段**重新校验**一遍，不信任前端送来的类型。
- 写入沿用对话工具的服务语义：同一句话记两次返回同一个 id，identity 层的条目不许归档，空补丁被拒。
- `dryRun` 预览**什么都不写**，因此面板把写入计数标成「将写入」而不是「写入」——一个已经完成的
  动作和一个预测值，读起来必须不一样。

深色 / 浅色跟随主题自动切换，所有颜色与尺寸走 `--dsw-*` 令牌（`npm run check:tokens` 审计），
并且**刻意不依赖** `@deepseek-ai/dsh-client-ui-primitives`：第三方插件一旦依赖它，组件抛错会让整个
slot 条目变成空白，而控制台只有一行 `slot entry crashed in '<slot>'`。

## 配置

全部偏好项在设置面板中可改——十个开关对应的就是十个 volatile 字段。部署级限额（如每轮预算）
**不在 UI 中暴露**，只能通过 profile 的 `cordis.patch.yml` 覆盖——这是刻意的：把预算做成可点开的
开关，就是把上面那条 7.1 倍的教训重新埋一遍。

profile 覆盖是**按 id 定位**，并且**必须重述整个 `config` 对象**（补丁会替换目标行的全部 config）：

```yaml
- id: dsh-evermemory
  name: dsh-evermemory
  config:
    rulesEnabled: false
    memoryEnabled: true
    # …其余键也必须一并列出
```

---

## 开发

```bash
npm install
npm run build         # 产出 lib/index.js（宿主机侧）+ lib/client.js（浏览器侧）
npm run typecheck     # 两侧分别类型检查
npm run check:tokens  # 设计令牌合规审计
npm test              # 契约、预算不变量、存储 / 检索 / 注入 / 工具 / 导入 / 面板
```

### 关于 `@deepseek-ai/*` 依赖

**它们不在 registry 上以本机运行时的版本发布。** 本机 DSH 运行时是 `0.1.7-rc.2`，而 registry 上
`@deepseek-ai/dsh-tools` 等是 `0.0.1-rc.1`、`-dsh-agent` 是 `0.1.0-rc.6`。

所以本包**不声明** `peerDependencies`：声明了只会把自己钉在一个永远不会运行的 API 上；
而且 npm 的 arborist 在放置通配版本的 peer 时会直接崩溃（`place-dep.js:299`）。

类型检查走 `types/shims/` 下的浅声明，测试运行时由 `scripts/peer-hooks.mjs` 这个 loader 钩子
把裸标识符重定向到 `scripts/shims/`。两者都不会进入发布产物——构建把每个 `@deepseek-ai/*`
说明符都视为 external。

### 三处必须一致的标识符

| 位置 | 值 |
|---|---|
| `cordis.patch.yml` 的 `insert.id` | `dsh-evermemory`（**同时是设置命名空间**——Loader 条目 id 就是它） |
| `lib/index.js` 导出的 cordis `name` | `dsh-evermemory` |
| `cordis.patch.yml` 的 `insert.name` | 包名 `dsh-evermemory` |

`tests/contract.test.ts` 会断言这三者一致。

> **关于 `dsh.plugin.json`**：它**不属于**真正的 manifest 规范。运行时 manifest 是
> `package.json` 里的 `dsh` 字段（由 `@deepseek-ai/dsh-package-manifest` 定义）。`dsh.plugin.json`
> 只在 `omdsh-dev/DSH-better-sidebar` 仓库里作为市场目录条目出现过，本包的依赖树、asar 与任何已安装
> 插件中都不存在。本包提供它是为了市场收录，**删掉不影响运行**。

### 构建产物的形状

浏览器侧最终是 `window.__ModuleLoader__.load({ id, factory })` 包起来的**单个自包含 chunk**。

这不是风格选择：客户端模块系统实现的是 CommonJS，`require` 只解析固定的模块表
（`react`、`@deepseek-ai/cordis` 以及少数客户端包），因此一个 `client*.js` 产物**无法同步
`require` 另一个相对路径的 `client*.js` 产物**——没有相对模块钩子能接住它。

构建里还有三道断言：产物中出现 React 内部符号 → 失败；`require` 了模块表以外的标识符 → 失败；
自身体积超出预算 → 失败。把 React 打进包里会让插件持有**第二个 React 实例**，hooks 在渲染时抛错，
而构建、加载、类型检查全程无感。

---

## 路线图

- [x] **步骤 1** 架构与约束复核、歧义澄清、技术方案
- [x] **步骤 2** 项目骨架（宿主机侧 + 浏览器侧 + 构建配置）
- [x] **步骤 3** 存储层：SQLite schema、迁移、基础 CRUD、四态合并
- [x] **步骤 4** 蒸馏引擎：规则管道
- [x] **步骤 5** 注入引擎：模块一 section + 模块二按需注入 + 预算强制
- [x] **步骤 6** 对话式工具集（`evermemory_*`）
- [x] **步骤 7** 多源导入引擎（WorkBuddy / Claude / ChatGPT / ZCode / Hermes）
- [x] **步骤 8** 设置面板（宿主机侧 + 浏览器侧完整功能）
- [ ] **步骤 9** 测试补全、双语文档、打包发布（测试、双语文档、0.1.0 打包与首次提交 `v0.1.0` 已完成；发布待仓库地址）

---

## 文档

- [PROPOSAL.md](./PROPOSAL.md) —— 完整技术方案：验证过的 API 事实、生态实测证据、每一项决策及其理由

## 许可

[MIT](./LICENSE)

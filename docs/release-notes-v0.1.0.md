# dsh-evermemory 0.1.0

Cross-session long-term memory and behavioural rules for DeepSeek Harness: four memory layers in
one SQLite file, rule-based distillation with no model call, and an injection model whose per-turn
cost stays inside a character budget however large the store grows.

## What is in it

- **Four layers** — `identity` (a hand-edited file the plugin never writes), `global`, `project`
  (keyed on the git repository root, so a linked worktree shares its checkout's memory) and a
  per-day `daily` journal.
- **Conversational tools** — `evermemory_remember`, `evermemory_forget`, `evermemory_search`,
  `evermemory_log` and `evermemory_import`. User messages are never intercepted: memory is written
  when the model calls a tool.
- **Rule-based distillation** — every statement is classified, compared against the store and
  resolved into one of four states (new, duplicate, supersede, reject) without an LLM call.
- **Bounded injection** — a system-prompt section (order 50) plus an on-demand runtime-context
  index, held to 900 + 900 + 700 characters per turn and enforced per turn.
- **Import engine** — Claude Code transcripts, ChatGPT and claude.ai exports, ZCode, WorkBuddy
  memory directories and plain Markdown/JSON, with a ledger so re-running an import changes
  nothing.
- **Settings panel** — a `settings.section` page over a fenced host route, built from `--dsw-*`
  tokens and the host's own components, light/dark automatic.

## Install

    dsh plugin add dsh-evermemory

From a tarball instead: `pnpm add <path-to-tgz>` **inside** `~/.dsh/profiles/<profile>`, then add
the package name to `dsh.profile.bundles` — that entry is what the plugin manager reconciles. Two
traps are worth knowing: a machine without pnpm on `PATH` has to drive the profile's own pnpm, and
reinstalling the same version from the same path needs `remove` before `add`, because pnpm
otherwise keeps the copy it already linked. Replacing an installed copy needs a host restart.

Requirements: Node `^22.19.0 || >=24.0.0`, DSH `>= 0.1.7-rc.2`.

## Verified before this release

- **437 tests, 85 suites** pass on Node 24.21.0 / Windows 11. Three of them ask a real `git` binary
  about worktrees and are skipped without one (429 tests then), which is why CI is the place they
  run. `prepack` runs the build, the declarations, the token audit, the typecheck and the whole
  suite before a tarball can be written.
- CI (`.github/workflows/ci.yml`) runs that gate on Node 22 and 24, Linux and Windows, and uploads
  the tarball as an artifact. It is where the third defect above was found: the suite is green on a
  Windows machine here, and was red on a fresh Windows runner, because the runner hands a temporary
  directory over under its 8.3 short name while `git` answers with the long one.
- The package is 78 files, about 255 kB packed, and was installed into a real DSH desktop profile
  and used from there: the five tools, the injected memory index and the panel route's
  registration were all exercised against the live host.
- Three defects were found and fixed around this first release, all three now under `### Fixed` in
  `CHANGELOG.md`. Two were caught before the tarball was published: the browser half shipped with
  every backtick escaped (it was not valid JavaScript), and a session whose working directory
  resolves to no project could write a journal entry it could never read back. The third was caught
  by this CI matrix minutes *after* publication, on both Windows jobs: an identity comparison that
  read an ordinary checkout as a linked worktree whenever the filesystem spelled its path
  differently from git, keying one repository two ways. The comparison now resolves real paths; the
  path a caller gets back is still the path it gave.

## 中文摘要

DeepSeek Harness 的跨会话长期记忆与行为规则插件：四层记忆（identity / global / project / daily）
存在一个 SQLite 文件里，蒸馏不调用模型，注入有字符预算 —— 每轮开销不随记忆体量增长。

- **四层记忆**：`project` 层以 git 仓库根为键，链接的 worktree 与它分叉出来的检出一致。
- **对话式工具**：`evermemory_remember` / `forget` / `search` / `log` / `import`，从不拦截用户消息。
- **规则蒸馏**：分类 → 比对 → 四态归并（新增 / 重复 / 取代 / 拒绝），不调用模型。
- **有界注入**：系统提示词段（order 50）+ 按需的运行时上下文索引，每轮 900 + 900 + 700 字符。
- **导入引擎**：Claude Code、ChatGPT / claude.ai 导出、ZCode、WorkBuddy、Markdown / JSON，
  带导入台账，重复导入不会产生重复记忆。
- **设置面板**：`settings.section` 页面 + 带围栏的宿主路由，只用 `--dsw-*` 设计令牌。

安装：`dsh plugin add dsh-evermemory`；用 tgz 时在 `~/.dsh/profiles/<profile>` 里 `pnpm add`，
并把包名写进 `dsh.profile.bundles`。同版本同路径重装要先 `remove` 再 `add`，替换已安装的副本
需要重启宿主。

发布前后实测：Node 24.21.0 / Windows 11 上 **437 项测试、85 个套件**全绿；`npm pack` 产出 78 个
文件、约 255 kB，并已装进真实的 DSH 桌面 profile 里用过（五个工具、注入的记忆索引、面板路由
的注册）。三个缺陷被抓到并修好：浏览器半边把每个反引号都转义掉了（根本不是合法 JavaScript），
以及解析不出项目身份的工作目录里会话写下的日记再也读不回来 —— 这两个在发布前；第三个是发布后
几分钟由 CI 在两台 Windows runner 上抓到的：身份比较把路径拼写与 git 不同的普通检出当成了
linked worktree，同一个仓库因此算出两个项目键。比较现在会解析真实路径，但返回给调用方的路径
仍然是它传进来的那个。

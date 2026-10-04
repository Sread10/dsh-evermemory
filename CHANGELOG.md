# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-03

### Added

**Packaging and build**

- Project skeleton: host half (`src/index.ts`) and browser half (`src/client/`), built by tsdown into
  `lib/index.js` (ESM, node22) and a single self-contained `lib/client.js` (CommonJS, wrapped in
  `window.__ModuleLoader__.load({ id, factory })`).
- `scripts/bundle-client.mjs` — folds the intermediate client body into the module-table wrapper,
  inlines `src/client/style.css` as a `<style data-plugin-css>` tag, removes the intermediate file, and
  fails the build if React internals appear in the artifact, if a `require` names something the client
  module table does not resolve, or if the body exceeds 120 kB. The budget was 40 kB while the browser
  half was one panel; the five-panel page measures 76 kB with nothing inlined, so the number now
  reflects what the page is rather than what the first draft of it was. The `require` allowlist is what
  enforces the project's own two rules — React stays external, and a third-party plugin must not reach
  for `@deepseek-ai/dsh-client-ui-primitives`.
- `scripts/check-tokens.mjs` — static audit of `src/client/**` for hard-coded visual values, with
  `style.css` allowlisted because it hosts the copied fallback custom properties.
- `scripts/clean.mjs`, `tsconfig.{base,host,client}.json` for checking, and
  `tsconfig.{host,client}.build.json` for declaration emission.
- `npm run types` emits `.d.ts` through TypeScript project references, so `exports["."].types` and
  `exports["./client"].types` resolve to real files. Build metadata is written to `.tsbuildinfo/`
  outside the published `lib/`.
- `prepack` runs build, types, token audit, type check and tests, so a publish cannot ship a stale or
  unchecked artifact. The published package is 78 files, about 765 kB unpacked, and that tarball was
  installed into a scratch consumer and loaded from there: `import.meta.resolve` answers for
  `dsh-evermemory` (`lib/index.js`), `dsh-evermemory/client` (`lib/client.js`) and
  `dsh-evermemory/cordis.patch.yml`, and the imported module carries the full export set with
  `VERSION` 0.1.0 — which is the check that catches a `files`/`exports` mismatch, the one packaging
  failure no test inside the repository can see.

**Host half**

- Configuration schema with ten volatile preferences and seven non-volatile deployment limits, plus
  `unwrapConfig()` for resolving cosmokit volatile references on read and `assertConfigUsable()`.
- `inject = ['tools', 'systemPrompt']` as hard dependencies; `settings` and `webServer` are to be
  injected optionally, so a Host without a web server still gets memory and rules.

**Storage layer**

- `src/storage/schema.ts` — the four-table SQLite schema (`memories`, `tags`, `import_ledger`, all
  `STRICT`) plus an external-content FTS5 index using the `trigram` tokenizer, kept in sync by three
  triggers. Migrations are an ordered array applied against `PRAGMA user_version`.
- A single trigram index rather than the ecosystem's usual dual `unicode61` + bigram tables. Measured
  on Node 24: `unicode61` indexes a whole Chinese run as ONE token (`索引优化减少Token消耗的句子` has the
  vocabulary `["索引优化减少token消耗的句子"]`), so it cannot match any part of it. `trigram` covers both
  scripts in one table, and a second table only adds a "which index do I query" guess whose wrong
  answer is a silent zero hits.
- `src/storage/db.ts` — `openStore()` reaching `node:sqlite` through a dynamic `import()`, so a runtime
  without it degrades to "rules work, memory unavailable" instead of failing the host's plugin tree.
  Foreign keys are enabled in the constructor. Transactions use `BEGIN`/`COMMIT` with savepoints above
  the first level, because every multi-row repository write is already transactional and refusing
  nesting would make the obvious composing code illegal.
- `src/storage/repository.ts` — typed CRUD with every value bound, never interpolated, including a
  closed `ORDER BY` record so no user string can reach SQL text. Timestamps use
  `strftime('%Y-%m-%d %H:%M:%f')` because `datetime('now')` is second-precision, which made four
  inserts share one value and left the eviction order dependent on luck.
- `src/storage/similarity.ts` and `src/storage/merge.ts` — the four-state merge (NEW / MERGE / UPDATE /
  IGNORE) with negation-aware contradiction detection. A correction is checked for contradiction
  BEFORE similarity, because a correction and the statement it corrects look alike, and scoring
  similarity first silently absorbs the correction into the text it was meant to replace.

**Retrieval layer**

- `src/retrieval/{tokenize,fts,like,rank,retriever}.ts` — query tokenization that fuses adjacent CJK
  runs, routes each fragment to FTS or `LIKE` by **character count** (`trigram` silently returns
  nothing below three characters, identically for Chinese and English) rather than by script, builds
  every `MATCH` argument in code with per-fragment quoting, and ranks by relevance, recency and
  pinned importance.
- An unquoted CJK run longer than a term is cut into overlapping three-character windows, because a
  fragment is matched as a PHRASE and Chinese arrives without spaces, so a whole question used to be
  one unmatchable phrase. Measured against a store holding `构建缓存\n缓存放在 .cache 目录，CI 上要清空`
  and two similar entries: `装依赖该用哪个包管理器`, `这个项目的缓存策略是什么`, `构建缓存应该怎么处理`
  and `提交前要不要跑测试` each matched **nothing**, while every query carrying a Latin term
  (`pnpm 和 npm 该用哪个`, `CI 上要清空缓存吗？`) matched — the Latin term was a second fragment for
  the OR retry to work with. The windows are ANDed first, so an exact store still answers exactly and
  only the store that knows part of the question falls back to OR.
- Raw user text must never reach `MATCH`: `OR`, `*`, `'` and `NEAR(` each raise a syntax error from
  SQLite. Quoting every fragment makes all of them safe without switching implicit AND to OR.

**Project identity**

- `src/identity/resolve.ts` — git repository root as the project key, `--git-common-dir` deciding
  whether a checkout is a worktree that shares its siblings' memory, then a marker-file walk, then the
  working directory marked explicitly untrustworthy, then nothing.
- Fails soft when git is absent, which is not hypothetical: git is not installed on the machine this
  was developed on. The git runner is injectable so all three git outcomes are testable there.

**Distillation engine (zero LLM)**

- `src/distill/patterns.ts` — the cue patterns, most consequential first: a correction is read as a
  correction before it is read as a preference, and "以后不要用 X" is a prohibition rather than a
  preference for X. Prohibitions and corrections are captured whole, because storing "不要用 npm" as
  "npm" inverts the user's meaning, and a store that occasionally records the opposite of what was
  said is worse than one that records nothing.
- `src/distill/extract.ts` — sentence splitting that consumes its delimiters, strips list markers,
  and drops clauses that are nothing but punctuation or a list number. Chinese users state a
  correction in one clause and its content in the next, so a bare lead-in ("更正一下") is joined to
  the clause that follows it: on its own it is a memory that corrects nothing.
- `src/distill/judge.ts` — the quality gate. `SESSION_RECALL_PATTERNS` runs first, because a question
  about memory otherwise distils into a memory of the user asking a question, which is
  self-amplifying. Vagueness is reported before length, because "照旧" is short AND vague and only
  one of those is the useful reason. Technology markers route a candidate to the project layer: a
  global "we use pnpm" leaks one codebase's stack into every other project.
- `src/distill/engine.ts` — extract → judge → scope → four-state merge → write, with the pool of
  competing entries cached per scope (the automatic path can produce dozens of candidates at a
  session boundary, and re-reading a 500-entry layer per candidate is a visible stall). A correction
  the merge cannot match widens its contradiction scan to the whole layer and is forced to `update`,
  because scoring it as `new` leaves the corrected entry alive beside its replacement.
- `src/distill/daily.ts` — the daily layer: one row per day, extended rather than re-created, keyed on
  LOCAL calendar days so an evening's work is not filed under tomorrow. Retention archives days older
  than 30 days instead of deleting them, and appending to an archived day revives it, since writing
  into a row no reader looks at would store the entry and show nothing.

**Conversational tools**

- `src/memory/service.ts` — the policy layer the tools and the injection path share. `createSession()`
  resolves the project identity once per call, and an untrustworthy identity yields a `null` project
  key rather than a placeholder, so a session that cannot be identified reads and writes the global
  layer instead of inventing a project. `listVisible()` is the single definition of "what a session
  may read"; `src/inject/context.ts` delegates to it, because an entry that is findable by asking but
  never injected — or the reverse — would make the store's contents depend on how you ask.
- `src/tools/memory.ts` — four global tools, `evermemory_remember`, `evermemory_forget`,
  `evermemory_search` and `evermemory_log`. Global rather than per agent: the calling agent is read
  from `exec`, so one registration serves every session, where per-agent registration would throw on
  the second one. Memory is stored by asking, never by watching messages, and a refused store is
  reported to the model with its reason instead of being swallowed — "too long to be a memory" is a
  real answer, and a silent no-op would let the model claim it remembered something.
- Explicit writes go through the same gate and merge as the automatic path, so a remembered
  correction supersedes the statement it corrects instead of sitting beside it.
- `evermemory_forget` archives rather than deletes, refuses the identity layer (that layer is a
  hand-edited file — editing it is the fix) and refuses rows belonging to another project, because
  honouring those would let any project delete any other project's memory by guessing an id.
- Tool output schemas set `additionalProperties: false` on every object, which the host enforces on
  the returned value, and `scripts/shims/dsh-tools.mjs` re-implements the host's eager schema
  compiler so a malformed schema fails a test instead of failing plugin mount.

**Injection engine**

- Two channels, chosen by whether the content changes. The rules section is registered at order 50,
  inside the prompt HEAD, and is therefore the one place where a change costs prefix-cache reuse
  from the first changed token onward — which is why it holds only text a human edits. Everything
  dynamic goes through the runtime-context channel, which the host appends as a sourced user-role
  message and only when the rendered text actually changed, so a busy memory store never rewrites
  the prompt head at all.
- `src/rules/loader.ts` — project rules render before global ones, because when two rules conflict
  a model is more reliably governed by the one it read first. The file cache is keyed on path,
  mtime AND size: mtime alone served a stale file, since a write can land inside the filesystem's
  timestamp resolution.
- `src/rules/section.ts` — the section is registered on the AGENT's context, not the plugin's,
  because it needs that agent's cwd and because the same section name registered globally for a
  second agent would throw. The text is refreshed at the step boundary against a 5 s TTL rather
  than inside the callback, so a filesystem read never lands in the middle of prompt assembly.
- `src/inject/context.ts` — three sub-channels, assembled in the order constraints → index → cards,
  so that when the budget runs out the model loses a card (one extra retrieval) rather than a
  constraint (the behaviour the user asked for). Ids are parsed back out of the KEPT text with
  line-anchored patterns rather than tracked separately, so "was it delivered" is answered by what
  the model can actually read and cannot drift from the renderer.
- `src/inject/budget.ts` — one total per turn, not a cap per channel. A section marked
  `partial: false` is dropped whole rather than cut: half a rule is a different rule. A partial
  section clamped to less than one complete line is dropped too, because a truncation marker with a
  fragment of heading attached announces an entry the model cannot read.
- `src/inject/dedup.ts` — a card body is delivered once per session, across steps, because
  `agent/pre-step` fires once per STEP and not once per turn. Recording is explicit and happens
  after the budget: a filter that recorded at offer time marked a memory as already in context when
  the transcript never received it, and since the index excludes delivered ids the memory became
  invisible in both channels at once.
- `src/inject/reminder.ts` — the optional one-line tail reminder at order 9999, off by default
  because it lives in the prompt head. It names the CONDITIONS for using memory rather than the
  tools, and interpolation is disabled so a stored memory containing `{{` can never become a prompt
  variable or throw during assembly.
- `src/index.ts` — the registration table: rules and the memory context per agent from
  `agent/created` (each reads that agent's project), an empty plugin-level memory context as the
  fallback for a session whose own context cannot be reached, the tail reminder on the plugin
  context at mount, and the per-step refresh on `agent/pre-step` registered `{ prepend: true }`,
  awaiting `next()` first and returning the decision unchanged.

**Import engine**

- `src/importers/detect.ts` — the source is chosen by CONTENT SHAPE, never by filename. Claude and
  ChatGPT both export `conversations.json`, one a flat `chat_messages` array and the other a `mapping`
  tree, so trusting the name would parse a ChatGPT export as an empty Claude one and report "0
  memories imported" without an error — the worst outcome, because it looks like success. The shape is
  read with regexes over a bounded head rather than `JSON.parse`, because the decision needs key
  presence and the file may be too large to hold. WorkBuddy is checked BEFORE ZCode: its user store is
  `~/.workbuddy/memory/`, whose `memory` child is exactly what the ZCode rule looks for, and the wrong
  reader would find no frontmatter there and import nothing at all.
- `src/importers/zip.ts` — a ZIP reader written against the format instead of added as a dependency.
  An export arrives as a zip, and pulling in `fflate` to open it would make a memory plugin carry an
  archive library forever. Stored and deflated entries both work, ZIP64 is refused with a sentence
  telling the user to unzip it rather than mis-parsed, and each entry streams through a byte-limiting
  transform into a temporary directory that a `finally` always removes.
- `src/importers/json.ts` — a streaming array reader. A ChatGPT `conversations.json` is routinely
  hundreds of megabytes, and `JSON.parse` of such a string sits near V8's maximum string length, so
  the file is walked one character at a time through a 64 KiB window and ONE element is parsed at a
  time: peak memory is one conversation, not one export.
- `src/distill/hygiene.ts` — text hygiene shared with the live extractor: fenced code removed, the
  attachment body marker respected, and a paste detector that skips a message which is mostly list
  markers. Inline code spans are stripped in imports but NOT on the live path, because users name
  commands in backticks ("we use `pnpm`, never `npm`") and removing the span stores a sentence with
  holes in it.
- Five readers, one per source: `sources/chatgpt.ts` (the `mapping` tree swept flat by author and
  time, because its branches are regenerated turns and dedup absorbs the repeats, where picking a
  trunk would silently discard the branch the user actually continued), `sources/claude.ts` (claude.ai
  flat message arrays including attachment bodies, Claude's `memories.json` with its three independent
  fields, and Claude Code transcripts with thinking blocks, tool calls, `isMeta` turns and subagent
  sidechains all excluded), `sources/zcode.ts` (frontmatter flat OR nested under `metadata:`, with
  `MEMORY.md` and `memory_summary.md` excluded as regenerated indexes), `sources/workbuddy.ts` (three
  generations of one store with a fixed read order, so the same memory in two of them is imported
  once, and the `RAW_JSON` trailer dropped because it repeats the whole memory block as JSON), and
  `sources/generic.ts` (Markdown by heading or paragraph, JSON Lines, JSON, and this plugin's own
  export, recognised by its header row so a round trip lands back where it started).
- `src/importers/run.ts` — the runner. Every item goes through the same distillation and four-state
  merge as the live path, so an import cannot deposit rows the live path would have refused; the
  identity layer is refused outright, since that layer is a file the user hand-edits; `dryRun` counts
  without writing; and the ledger skips material already imported.
- `src/tools/import.ts` — `evermemory_import` reports decisions rather than a count. "The file had 412
  conversations and 6 of them held something durable" is the answer a user needs; a bare number invites
  a second run that changes nothing and cannot say why.

**Panel data route**

- `src/panel/protocol.ts` — the wire shape both halves agree on: eleven methods (`overview`, `list`,
  `get`, `search`, `remember`, `forget`, `update`, `daily`, `log`, `export`, `import`), an envelope that
  makes a failure a *value* (`{ ok: false, error: { code, message } }`) rather than a transport status,
  and the three limits the page is allowed to know (`LIST_LIMIT_DEFAULT` 30, `LIST_LIMIT_MAX` 200,
  `LIST_TEXT_CHARS` 600). Sharing the types is what lets the browser half compile against the host's
  answers without either side importing the other's implementation.
- `src/panel/api.ts` — `createPanelApi({ store })` and its single `handle(method, payload)` dispatch.
  Every field is re-validated here (`number`, `text`, `scopes`, `cleanTags`) even though the TypeScript
  types say it is already the right shape, because the body arrives from a socket; the cast that keeps
  the dispatch readable is isolated in `requestOf<T>()` with that reason written next to it. Writes go
  through the same service semantics as the conversational tools, so the page cannot do anything the
  tools refuse: the same statement twice returns the same id, an identity row cannot be archived, and a
  patch must contain something.
- `src/panel/export.ts` — `exportMarkdown(repository, { scope, includeArchived })` builds the export as
  one Markdown document and reports its byte length from the UTF-8 encoding, so the page can offer a
  real size before the user downloads anything.
- `src/panel/route.ts` — `mountPanelRoute(ctx, store)` injects **only** `connection` and branches
  inside it: when the connection service exposes a channel registry the route registers there, and
  otherwise it falls back to a `kind: 'prefix'` handler on `webServer`. The fallback is not a
  degraded mode with weaker checks — the request is fenced first in both paths (Host/Origin check plus
  the browser session cookie, answered as a bodyless 401/403), and only then parsed: POST only, JSON
  only, 1 MiB cap, nested paths 404. A method name that belongs to the other HTTP method is answered
  as a 200 failure envelope on purpose, because the page renders the message and a transport error
  would replace it with the shell's own.
- A host with a web server but no connection service gets no route **and** no page: the browser half
  reaches its data through that same service, so the two halves are made to degrade together rather
  than to show a page whose every request fails.

**Browser half**

- Settings section registered at `settings.section` (order 16), with Chinese and English dictionaries
  (`src/client/dict.ts`, keyed `toggle.<configFieldName>` so a switch's label cannot drift from the
  field it writes) and hand-rolled `SectionHeading` / `Card` / `SwitchRow` / `TextField` / `Button`
  built entirely against `--dsw-*` tokens. Dark mode follows automatically with no JavaScript, since
  `body[data-ds-dark-theme]` redefines the same custom properties.
- The page has five tabs, all reading and writing through the route above and none of them touching a
  database: **偏好** (the ten volatile switches, the extra rule directories, save/discard against the
  live config snapshot), **记忆** (paged list, full-text search, scope/status/project filters, inline
  edit, pin, archive), **记住** (write one memory by hand), **每日** (read and append a day's log) and
  **数据** (Markdown export, and the import engine with a preview that reports what it *would* write).
- `src/client/services.ts` — the five optional services are read through `ctx.get` and may all be
  missing; `SlotsService.register` is generic over the component's props and takes the slot's business
  share from an `inject()` resolved per registration, so a connection service that mounts after the
  settings shell is still reachable.
- `src/client/hooks.ts` and `src/client/panels/memories.tsx` — the list normalises both answer shapes
  (ranked hits and paged rows) into one local row type before rendering. An absent field becomes `null`
  rather than a guess: a hit shown under a project it may not belong to is a wrong answer, while an
  empty column is visibly no answer at all. Retrieval does not page, so "load more" is offered only on
  the paged path.

**Tests**

- `tests/contract.test.ts` — the three-identifier packaging contract, plus artifact assertions on the
  built output (host imports, no browser framework in the host half, module-table wrapper, no inlined
  React, module-table-only `require` specifiers, no leftover intermediate body).
- `tests/artifact.test.ts` — the shipped artifact, mounted the way a host mounts it. Every other suite
  loads `src/` through the type-stripping loader and the contract suite only reads the build as text,
  so nothing proved the published half runs: this one imports `lib/index.js` (skipping itself when the
  build is absent, so a fresh checkout can still run `npm test`), asserts the identity contract against
  `package.json`, then mounts it on a fake context, fires `agent/created`, and asserts a memory body
  reaches the agent's prompt on the turn that asks and is deduplicated on the next. It is the test that
  found the CJK sentence defect, because it asks the question a user would.
- `tests/client-bundle.test.ts` — the shipped browser half, compiled and mounted. It runs `lib/client.js`
  in a VM with a fake `window.__ModuleLoader__` and a fake `document`, resolves the module's `require`
  against the real `react` the module table provides, then calls the `apply` the host would call with a
  fake settings shell. It asserts what makes the settings section appear at all: one module registered
  under the plugin id, the stylesheet injected once, both dictionaries under one namespace, the
  `settings.section` entry with the `id` a list slot requires and order 16, the share carrying `panel`
  only when a connection exists, and the panel reaching `/dsh-evermemory` with a dropped carrier arriving
  as `{ ok: false, code: 'transport' }` rather than as a rejection. It exists because the browser half had
  no execution coverage of any kind until the 0.1.0 defect listed under Fixed made that untenable.
- `tests/budget.test.ts` — per-turn budget invariants, volatility marking, `unwrapConfig` behaviour,
  and prompt orders against the verified occupied bands.
- `tests/storage.test.ts`, `tests/retrieval.test.ts`, `tests/identity.test.ts`, `tests/distill.test.ts`
  and `tests/daily.test.ts` — against a real SQLite file in a per-test temporary directory rather
  than a mock or `:memory:`, because the trigram tokenizer, foreign-key cascade and `user_version`
  are all invisible to a double. The retrieval suite includes the case the whole retrieval design
  exists for (finding a Chinese memory by a two-character query) and, since the card channel was
  wired, the sentence case: a memory found from the user's own question, a question that shares only
  three characters with the memory and is answered through the OR retry, and a question about a
  subject the store does not hold, which must still match nothing.
- `tests/inject-budget.test.ts`, `tests/inject-render.test.ts`, `tests/inject-context.test.ts`,
  `tests/rules.test.ts` and `tests/inject-mount.test.ts` — the injection engine. The budget suite
  counts code points rather than UTF-16 units, the assembly suite runs against a real SQLite file
  per test, and the wiring suite drives a fake context that reaches the prompt service through
  `ctx.get('systemPrompt')`, the way the plugin does, so a broken lookup cannot pass. That suite
  exists because the registration table is the one part of the design that is invisible to every
  other test: sections on the wrong context would apply one project's rules to every other project,
  and nothing else would notice. It is where the registration defects listed under Fixed were caught. Two cases were
  added for the brief's own hard constraint: the assembly suite seeds one store with a hundred
  memories and another with a thousand and asserts the rendered text is identical character for
  character — the same rows under the same ids, the nine hundred extra ones archived in one store and
  live in the other, so the only variable is volume — and the wiring suite drives a real step with a
  real `source.kind === 'user'` message and asserts the card arrives once, not twice, and arrives
  again after a conversational write. It also pins the per-agent scoping with two agents in two
  projects: each agent's context text holds its own project's memory and not the other's, which the
  plugin-context placement would have failed.
- `tests/tools.test.ts` — the conversational tool set, driven the way the host drives it: the fake
  context hands out a `register` that records definitions, and each call validates the tool's RETURNED
  value against its own output schema, because the host does that too and a service result that grows
  a field would otherwise fail only in production. The harness asserts a precondition — that the
  temporary directory it uses really did resolve to a project — so a project-layer assertion cannot
  pass for the wrong reason.
- `tests/import-archive.test.ts`, `tests/import-run.test.ts`, `tests/import-tool.test.ts`,
  `tests/import-detect.test.ts` and `tests/import-sources.test.ts` — the import engine. The archive
  suite builds ZIP bytes by hand, so the layout under test is one the test controls rather than one a
  library produced; the runner suite drives `applyScan` with literal items and therefore never touches
  the filesystem; the tool suite validates each returned value against the tool's own output schema;
  and the detection suite hands ChatGPT and Claude the SAME filename, which is the single claim the
  routing design exists for. The archive suite also pins the streaming reader's 64 KiB window edges,
  which the ordinary fixtures never reach: a Chinese character split across the boundary (asserted on
  where the character sits, not only on what came out), an escape pair split across it, an element
  spanning three windows, and a byte cap that cuts the array — each of which a byte-wise reader gets
  wrong quietly, by importing a memory that says something the user never wrote.
- `tests/panel-route.test.ts` and `tests/panel-api.test.ts` — the panel's two halves. The route suite
  drives the mount against a fake context and asserts what is registered *when*: nothing until a
  connection service exists, the channel when there is one, one prefix registration when there is not,
  and nothing at all when there is a web server but no connection service. The API suite drives
  `handle()` directly and pins the refusals — a blank search, a project name without a project, an
  identity row asked to archive, an unknown method — because those are the answers the page renders as
  text, and a crash there would be reported as a broken panel.
- `tests/panel-route-http.test.ts` — the same fallback route, carried by a real `node:http` server and
  driven by a real client. The suite above builds request and response objects by hand, which tests the
  decisions the handler makes but not what it assumes about Node: that a real request streams, that a
  real response reaches the client with its status and headers, that the socket is still usable
  afterwards (a handler that leaves the body half-read costs the next request its connection), that a
  cache-busting query string is not read as part of the endpoint, and what a client actually sees when
  the body is over the cap. It is the suite that shows the 413 arrives before the connection is dropped
  rather than the client merely being cut off.
- `tests/identity-git.test.ts` — project identity against a real git binary: the one thing the injected
  runner cannot show is `spawnGit` itself, meaning its argv, its working directory, the trimming of
  git's output, and the difference between the relative `--git-common-dir` an ordinary checkout prints
  and the absolute one a worktree prints. It initialises a repository with one commit, adds a worktree
  to it, and asks the product — not a fake — for the identity of the checkout, of the worktree and of a
  second repository with the same directory name. It skips when no git binary is on `PATH`, because a
  checkout without git must still be able to run `npm test`; it is the suite that caught the worktree
  key defect listed under Fixed.
- `tests/dict-keys.test.ts` — reads the browser half as text rather than importing it, which keeps the
  `.tsx` sources out of the host TypeScript program. It asserts the two dictionaries define the same
  keys, that the switch keys and the volatile `Config` fields match in both directions, and that every
  key the panels ask for exists. The failure it guards against is quiet: an untranslated key renders as
  `mem.list.empty` in the middle of a page instead of throwing.
- `scripts/probe-import.ts` — a probe that imports a real store from this machine into a throwaway
  database. Fixture tests can only show that the parsers agree with what I believe the formats are,
  and the probe is how the belief was corrected: it is where the WorkBuddy store turned out to be
  `<workspace-id>_memory.md` with a JSON trailer repeating the entire memory block, and where a ZCode
  note was found being discarded because one of its clauses contained 可能.
- `scripts/probe-patterns.ts` and `scripts/probe-distill.ts` — development probes that print which
  cue pattern matched, with its capture groups, for a fixed set of inputs. They exist because
  reading a regex is not evidence about what it matches: the pattern that looked like it captured
  "都用中文回答" was measured capturing "用中文回答", with 都 consumed as part of the marker.

### Fixed

- **A checkout whose path the filesystem spells differently was read as a linked worktree.**
  `isLinkedWorktree` in `src/identity/resolve.ts` compared git's `--git-common-dir` answer with
  `<root>/.git` after `normalize`, which fixes separators and nothing else: no real-path resolution,
  no case folding. Both spellings of one directory therefore counted as two directories, every
  ordinary checkout came back `source: 'git-worktree'` with a spurious `subId`, and one repository
  keyed differently depending on how the process had been handed its path — constraint #4 broken in
  the quietest available way. Found by the GitHub runner, which hands a temporary directory over as
  `C:\Users\RUNNER~1\...` while git answers with the long name: both Windows jobs failed
  `tests/identity-git.test.ts` with `actual: 'git-worktree', expected: 'git-repo'`. The comparison now
  canonicalises both sides through `realpathSync.native` — falling back to the normalized path when
  the filesystem cannot spell it back, because a directory that does not exist yet still has to be
  walked up from — and folds case, because the project key folds it. Resolving is confined to that
  comparison: `canonical`, which produces the root the product returns, still only normalizes. The
  first version of this fix resolved there too, which made an existing directory come back in its
  long spelling while a sibling that did not exist yet kept the short one — two project keys for one
  repository, and every Windows assertion that compared a returned root against the path it had
  handed over went red. The path a caller gets back is the path it gave. Fixing the comparison then
  exposed the key itself: git answers `--git-common-dir` as `.git` relative to the working directory
  it was handed for an ordinary checkout and as an absolute path for a linked worktree, so the two
  checkouts hashed two spellings of one directory and one repository held two memories — the next
  Windows run failed one test, `worktrees of one repository share one memory`, on both jobs. The key
  now hashes the resolved common directory, which is harmless because a key is a hash: the only thing
  its input has to do is agree. The other half of the same rule
  was asserted only on a case-INSENSITIVE filesystem, and so failed on Linux for the honest reason
  that `/tmp/ABC` and `/tmp/abc` are two directories there: `tests/identity.test.ts` now asserts the
  unconditional half everywhere and skips the filesystem-dependent half on a case-sensitive volume.
- **A session with no project key wrote a journal it could never read back.** `projectKey` is `null`
  when the working directory carries no trustworthy identity (no git repository, no marker file), and
  three readers in `src/memory/service.ts` treated that `null` as "no rows" rather than as the
  unprojected layer: `listVisible` returned early with the global layer, `#listScopes` answered `[]` to
  any request naming the `project` or `daily` layer, and the `#filter` used by the search tool dropped
  every `project`/`daily` row when the session's key was null. Every other layer in the plugin already
  read a null key as a real key — `repository.buildWhere` matches it with `project_key IS ?`
  ("the entries with no project"), the retrieval SQL filters `scope NOT IN ('project','daily') OR
  project_key IS ?`, and `appendDaily`'s own parameter documents `null` as "the unprojected layer" —
  so `evermemory_log` filed the day under a null key and `evermemory_search` then reported
  `no entry matched` about the row it had written seconds earlier. Found by using the installed plugin
  in a host whose working directory is `D:\SKILL制作`: the store held the day row (`scope: 'daily'`,
  `project_key: NULL`) and the raw index matched the query, while the tool could not. A null key is now
  a key everywhere: such a session reads back the day it wrote, can list the `daily` layer and archive
  its own day, still cannot reach a keyed row, and a keyed session still cannot reach the unprojected
  one. `tests/tools.test.ts` drives the round trip through the tools and
  `tests/inject-context.test.ts` pins the injection assembly.
- **The shipped browser half was not JavaScript.** `scripts/bundle-client.mjs` escaped every backtick
  and `${` in the bundled body before interpolating it into the module wrapper — escaping that belonged
  to an earlier revision which pasted the body into the wrapper template literal. The wrapper
  interpolates it as a VALUE, so interpolation inserts those characters verbatim and the escapes landed
  in the artifact instead of being consumed: the shipped `lib/client.js:68` read
  `const API_ROUTE_PREFIX = \`/\${PLUGIN_NAME}\`;`, `node --check` reported `SyntaxError: Invalid or
  unexpected token`, and every template literal in the browser half was destroyed. Nothing in the gate
  could see it, because everything that touched the artifact read it as text — the contract suite for
  its `require` allow-list and byte budget, the dictionary suite for the two dictionaries, the token
  checker for the `--dsw-*` names — while the typecheck and the other 420-odd tests exercise `src/`.
  It was found by running `node --check` against the copy installed in a real profile, after the host
  half had already been proven to mount. The escaping step is gone (the stylesheet needs none: it is
  embedded with `JSON.stringify`), the wrapper now compiles its own output with `new Script(out,
  { filename: 'lib/client.js' })` before writing it, so a body that does not parse fails the build, and
  `tests/client-bundle.test.ts` compiles, loads and mounts the artifact. The wrapper also gained the
  `Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })` line that all four reference
  bundles in the field carry (`dsh-client-locale`, `dsh-client-connection`, `dshmarket`,
  `dsh-better-sidebar`); measured, the artifact went from 85,253 bytes to 85,126.
- **A worktree and the checkout it was branched from did not share one project key, so constraint #4
  was not in force.** The linked-worktree branch keyed on `keyFor('git-common', commonDir)` while an
  ordinary checkout keyed on `keyFor('git-repo', root)` — a different namespace over a different path,
  so the two could never be equal however correctly the worktree was detected. Every test agreed because
  each asked for either two worktrees (both `git-common`) or one ordinary checkout (`git-repo`);
  nothing had ever asked one repository for both. Measured against git 2.56: an ordinary checkout is
  told `--git-common-dir` relative to its working directory (`.git`, and `../../.git` from a
  subdirectory) and a linked worktree is told the main repository's absolute `.git`, so both now key on
  that shared directory under one namespace, with `subId` still telling the checkouts apart where a
  caller cares. `tests/identity-git.test.ts` asks a real repository, and `tests/identity.test.ts` pins
  the same pair against the two shapes git prints.
- **The install instructions named a tarball path that cannot resolve.** Both READMEs said
  `dsh plugin --profile web add ./dsh-evermemory-0.1.0.tgz`, but the host's own reference states that
  `dsh plugin --profile <name> <pnpm args>` forwards the arguments "to pnpm in the profile directory"
  (`dsh/node_modules/@deepseek-ai/dsh/README.md:19`) — so the relative path was looked up inside
  `$DSH_HOME/profiles/web/`, where `npm pack` had not put it. Both now show an absolute path, and the
  restart note became "with `dsh-hmr` enabled this applies immediately, otherwise restart", which is
  what the plugin manager actually does.
- **A question written as a Chinese sentence matched no memory at all.** Fragments are matched as
  PHRASES and adjacent CJK is fused into one fragment, which is right for a term (`项目 约定` has to
  become `项目约定` to clear the trigram floor) and wrong for a question: Chinese is written without
  spaces, so `构建缓存应该怎么处理` arrived as one phrase and only found text containing it verbatim.
  Measured with a probe against a store holding `构建缓存\n缓存放在 .cache 目录，CI 上要清空` and two
  similar entries, four of seven realistic questions returned nothing — `装依赖该用哪个包管理器`,
  `这个项目的缓存策略是什么`, `构建缓存应该怎么处理`, `提交前要不要跑测试` — while every query that
  happened to carry a Latin term matched, because the term was a second fragment for the OR retry.
  The `evermemory_search` tool was unaffected in practice (its own description tells the model to
  search keywords), but the per-turn card channel sends the user's sentence, so the defect made it
  dead for the language this plugin is primarily used in. An unquoted CJK run longer than
  `CJK_TERM_CHARS` is now cut into overlapping three-character windows: the AND query over them still
  means the whole run, so an exact store answers exactly, and a store that knows only part of the
  question answers with that part instead of with nothing. A quoted run and a Latin word are never
  cut — the first is the user asking for that exact phrase.
- **The per-turn card channel was documented as shipping and had no producer.** `cardInjectionEnabled`
  defaults to `true`, `InjectionState` honoured it, the renderer and the dedup ledger were built and
  tested — but the only `rebuild()` call site passed no `cards` callback, so `#cards()` returned `[]`
  on every step in production and the channel fired only in the test that supplied its own. With it,
  `invalidateCards()` had no caller at all, so nothing could ever re-offer a memory a write had just
  changed. The step now extracts the turn's own user text (`stepQuery`, whitelisting
  `source.kind === 'user'` so a runtime-context snapshot or a model-switch notice is never mistaken for
  a question), retrieves through the same `Retriever` the `evermemory_search` tool uses — so what the
  model sees before asking cannot differ from what it is told when it asks — and passes the result as
  `cards`, wrapped so a retrieval failure returns `[]` instead of throwing into the host's waterfall.
  The conversational write path now calls `invalidateCards()` through a hook, and the retrieval runs
  once per user TURN rather than once per step: a tool-result step carries no user message of its own,
  so it costs nothing.
- **The injected memory text was shared by every agent, so one project's memories could reach another
  project's session.** `InjectionState` was created once in `apply()` and its `text` was registered on
  the plugin context, while the project key is read per agent (`sessions.cwdOf(agent)`) — and the rules
  section was already scoped per agent, precisely because two agents can sit in different projects. The
  last rebuild won, and its index, constraints and cards were then served to every agent, which is the
  opposite of the rule the README states for the read path. The state now lives in the `Sessions`
  record and the memory context is registered on `agent.ctx` from `agent/created`, the same way the
  rules section is; the plugin-level registration remains as an empty fallback for a session whose own
  context cannot be reached (a host that exposes no `systemPrompt` on the agent), and the agent's
  same-named registration shadows it, so a normal session still receives exactly one text. The write
  hook resolves the session that wrote, so a conversational write re-offers a memory to that session
  alone. `tests/inject-mount.test.ts` proves it with two agents in two projects: each one's context
  text holds its own memory and not the other's. The host dispatches `agent/created` serially
  ("Rejects if the id is already registered or a serial `agent/created` listener fails",
  `dsh-agent/lib/index.js:473`), so two slices can listen for it without either one vetoing the other.
- **A dry run's counter was labelled as work already done.** `evermemory_import` reports `written` on a
  preview as the number the run *would* write — `run.ts` skips the append and the ledger under
  `dryRun` — but the panel rendered that number under 写入, which reads as a completed action. The
  label now follows the mode (`data.field.wouldWrite`), and the API test asserts the property that
  actually proves a preview is harmless: after a dry run the store is still empty.
- **The memory store was never opened, so memory injection could never fire.** `apply()` mounted the
  lazy handle and then nothing called `repository()`, which is the only thing that both opens the
  database and installs the repository; `repositoryIfReady` therefore stayed `undefined` for the
  life of the process and every step returned early. Now the open is kicked at mount (without
  awaiting, since `apply()` is synchronous) and the per-step listener awaits the repository when it
  is not ready yet, so the first step of the first session already sees memory.
- **A rejected step still paid for an injection and recorded its cards as delivered.** The listener
  awaited `next()` and returned on abort, but never checked `decision.kind === 'reject'`: no request
  is sent for a rejected step, so the query and the render were wasted, and the cards it saw were
  recorded as delivered and never offered again — hiding those memories for the rest of the session
  behind an injection that never reached the model.
- **Every index line rendered as pinned.** `toIndexEntry` tested `record.pinned !== 0`, but the
  repository maps the column to a BOOLEAN and `false !== 0` is `true`, so background knowledge was
  presented to the model as a standing rule. The render tests had been passing `pinned: 1`, a shape
  the repository never produces, and were converted to a typed `row()` helper that fails to compile
  if the record shape changes. This is the defect where the tests were wrong in the same direction
  as the code, which is why it survived a green suite.
- **The assembled injection could exceed the turn budget** by two characters per join: each section
  subtracted its own size but never the separator between it and the previous one. Measured at 301
  characters against a 300-character budget before the fix, and now asserted directly.
- **Client bundle no longer inlines React.** Leaving React external is a correctness requirement, not
  an optimisation: a bundled copy is a second React instance, and hooks throw at render time while the
  build stays green. The build body dropped from 113.72 kB to 13.23 kB. The build now fails if React
  internals appear in the artifact, and a test asserts the same thing independently.
- **Per-turn budgets reduced** so the three injection channels (900 + 900 + 700) sum to 2500 characters
  against the 4000-character turn budget, restoring the intended headroom. The previous 1200 + 1200 +
  800 left only 20%.
- **One project's daily log was searchable from every other project.** The retrieval SQL filtered
  `scope != 'project' OR project_key IS ?`, treating the daily layer as global — but daily rows are
  filed under the session's project key, exactly like project rows, so another project's journal came
  back from a query. Both statements now filter `scope NOT IN ('project', 'daily')`.
- **An explicit layer could not be listed.** `evermemory_search({ scope: 'identity' })` listed the
  global layers and then filtered every row out, answering "nothing is known about the user" while the
  rows were in the store; a `project`-layer request also ignored the session's key in that path. The
  list is now built from the requested layers, with the project key bound only for the layers keyed by
  it, and the redundant project check compares KEYS instead of testing for null — the old check let any
  keyed row through and was correct only because the SQL above it happened to be.
- **A sentence that merely opened with a pointer word was rejected as vague.** The Chinese and English
  cue patterns were anchored at the start only, so "this project builds with pnpm, never npm" and
  "这样处理会导致死锁" were discarded as content-free. Both are now anchored at both ends, and the
  unanchored "as we discussed" alternative was dropped: a rejection now means the text carries no
  content, not that it begins with a common word.
- **The host-artifact guard searched for the word `react`.** It was a proxy for "React was bundled" and
  became wrong once the distillation marker list — which legitimately names the frameworks a project
  might build with — entered the host bundle. It now looks for strings only React's own source
  contains.
- **An imported note was thrown away for containing a hedge, and another for ending in a question
  mark.** The interrogative and hedge gates ask whether a SENTENCE is a statement, and a vouched input
  is not a sentence: measured against a real ZCode store, a note stating that the local proxy may only
  support prefix ranges was rejected and lost, and in a WorkBuddy profile the same applied to a section
  that happened to end in 可以吗？. Both gates now apply to mined text only, which leaves the live path
  — where a musing about what one might do must not become a rule — exactly as it was.
- **The real WorkBuddy store was routed to the ZCode reader**, because `~/.workbuddy/memory` contains a
  directory called `memory` and that is the ZCode rule's signature. The WorkBuddy markers are now
  consulted first, and the path itself is checked as well as its children, so `~/.workbuddy`,
  `~/.workbuddy/memory` and a `<workspace-id>_memory.md` file all reach the reader that understands
  them.
- **A ZIP entry that was stored empty produced an illegal byte range** (`start` with `end` one byte
  before it), and an entry over the per-file limit was reported as "0 MB" for anything under a
  megabyte. The empty entry is written as an empty file and sizes are formatted with a unit that
  matches their magnitude.
- **A directory was read for every Markdown file in it, so the workspace's persona templates came in as
  memories.** Pointing the importer at a real `~/.workbuddy` produced 50 items, among them `Emoji:**`,
  `City:**` and `Pronouns:** _(optional)_` — the store root also holds `BOOTSTRAP.md`, `IDENTITY.md`,
  `SOUL.md` and `USER.md`, which are fill-in-the-blank templates whose own text calls them "the source of
  truth for future runs". A directory is now read for its MEMORY DOCUMENTS: `MEMORY.md`, a
  `<workspace-id>_memory.md`, a daily log, or anything under a directory named `memory`. An item that is
  only a label with a placeholder left in it is dropped as well, since it would put a line in the index
  that carries nothing. The same re-probe now yields 29 real items and no persona text.
- **A hash whose memory had been deleted stayed "known" forever**, so emptying the store and
  re-importing the same file imported nothing. The ledger now counts only hashes that still name a row
  (`memory_id IS NOT NULL`), which keeps the intended behaviour — re-running an import never resurrects
  an entry the user archived — while making a deletion re-importable.

### Notes

- No `peerDependencies` are declared. Every `@deepseek-ai/*` package is injected by the DSH host
  process and is not published to the registry at the installed runtime's version (installed
  `0.1.7-rc.2`; published `0.0.1-rc.1` / `0.1.0-rc.6`), so declaring them would pin the plugin to an
  API it never runs against. npm's arborist also crashes outright when placing a wildcard-versioned
  peer (`place-dep.js:299`). Type checking uses the shallow declarations under `types/shims/`, and the
  test loader redirects the bare specifiers to `scripts/shims/`; neither reaches the published package.
- `dsh.plugin.json` is shipped for marketplace catalogue purposes only. It is not part of the runtime
  manifest spec, which lives in the `dsh` field of `package.json`.
- The published `files` list carries `lib` (built output) but not `src`, so the package cannot be
  loaded from source and end up mixing a compiled host half with an uncompiled browser half.
- `repository`, `homepage` and `bugs` are deliberately absent from `package.json` until the GitHub
  URL exists: a guessed URL is a wrong URL, and npm renders it as a link. The version is `0.1.0` —
  the first release, and the one this changelog section describes; `src/version.ts` must agree with
  it, which `tests/contract.test.ts` enforces.
- The tree's first commit and the `v0.1.0` tag were made with a portable MinGit 2.56.0 unpacked under
  `_scratch`, outside the repository and off `PATH`: this machine has no `git` binary — not on `PATH`,
  not under `Program Files` / `Program Files (x86)` / `%LOCALAPPDATA%\Programs`, and no scoop or
  chocolatey shim — and installing one would have been a system change nobody asked for. The commit
  identity is repository-local (`dsh-evermemory contributors <dsh-evermemory@users.noreply.github.com>`),
  and `.gitattributes` pins `text=auto eol=lf` so a Windows checkout cannot rewrite the tree. Replacing
  the portable copy with an ordinary installation changes nothing about the repository.

# dsh-evermemory

Cross-session long-term memory and behavioural rules for [DeepSeek Harness](https://github.com/deepseek-ai)
(DSH) — so it gets to know you the longer you use it.

Open a new session and you do not re-introduce yourself, re-align on requirements, or re-explain the
project background.

> **Status: feature complete, first release 0.1.0.** The storage layer, distillation engine, injection
> engine, tool set, import engine and settings panel are all implemented, with 437 tests covering the
> contracts, the budget invariants and each module's behaviour; see the [roadmap](#roadmap).

---

## The problem it solves

DSH sessions are isolated. The project conventions, technical decisions and output preferences you
explained yesterday are gone today.

`dsh-evermemory` does two things:

| | Module 1: behavioural rules | Module 2: long-term memory |
|---|---|---|
| **Trigger** | every turn | session end / on demand |
| **Injection** | system-prompt section (early order) | runtime context (on demand) |
| **Token model** | static resident, prefix-cache friendly | dynamic retrieval, injected only when changed |
| **Storage** | `~/.dsh/rules/*.md` plus a project level | SQLite |
| **Interaction** | edited from the settings panel | just say "remember" / "forget" |

They share one storage layer and almost nothing else — and **that split is what protects the token
budget.**

### Talking to memory

Memory is written by asking, never by watching. The plugin does not intercept messages looking for
things worth keeping — it exposes five tools and tells the model when to reach for them:

| Tool | Does |
|---|---|
| `evermemory_remember` | store a statement; the layer (`global` / `project`) is guessed from the text and can be forced |
| `evermemory_forget` | archive an entry by id — nothing is deleted, and the identity layer is refused because it is a file you edit |
| `evermemory_search` | find entries by keyword, or list them layer by layer |
| `evermemory_log` | append to today's work log, one row per day |
| `evermemory_import` | move memories and conversations in from another AI tool's files, reporting every decision |

An explicit `remember` runs through the same gate and merge as the automatic path, so remembering a
correction supersedes the statement it corrects instead of sitting beside it. A refused store is
reported back with its reason — "too long to be a memory" is a real answer, and a silent no-op would
let the model claim it remembered something.

### Bringing your old memories over

`evermemory_import` reads the one path you name and never goes looking on its own. It decides the
source by CONTENT SHAPE, never by filename: Claude and ChatGPT both export a file called
`conversations.json`, one holding a flat `chat_messages` array and the other a `mapping` tree, so
trusting the name would read a ChatGPT export as an empty Claude one and "successfully" import zero
memories.

| Source | What is recognised |
|---|---|
| ChatGPT | `conversations.json` (or the exported .zip; shards like `conversations-1.json` too) |
| claude.ai | `conversations.json`, the flat message array, attachment bodies included |
| Claude memories | `memories.json`: `conversations_memory` / `project_memories` / `memory_files` |
| Claude Code | a `~/.claude/projects` directory or a single `.jsonl` (thinking, tool calls and subagent sidechains excluded) |
| ZCode | `~/.zcode/cli/memories` or one project inside it (frontmatter flat or nested under `metadata:`) |
| WorkBuddy / CodeBuddy | a `.workbuddy` / `.codebuddy` / `.deepseek-harness` directory, or one `<workspace>_memory.md` file |
| Generic | Markdown (by heading or paragraph), `.txt`, JSON Lines, JSON, and this plugin's own export, which round-trips |

Imported entries land in the `global` layer by default (`scope: "project"` files them into the current
project); `dryRun` counts without writing; re-importing the same file is skipped through
`import_ledger`, and ARCHIVING an entry never makes its source re-importable — what you put away should
not be dug up by the next import. Hermes has no on-disk format that can be verified, so it is handled
as generic JSON / JSONL / Markdown rather than pretending to know its private store.

---

## Design principles

### 1. At most ~1k tokens per turn, not growing with memory volume

This is the headline constraint and the easiest one to lose quietly.

The load-bearing detail: **a budget is per turn, never per entry, and never per file.** The clearest
cautionary case in the ecosystem is `dsh-memory-palace`, which publishes an 8000-character user budget
and a 6000-character workspace budget — both of them "per file" limits — and then measures a worst case
of eight injected messages at roughly 50,000 characters, **7.1× its own stated bound**. Every limit was
satisfied individually while the turn blew through them collectively.

Here the three injection channels sum to 2500 characters against a 4000-character turn budget, and
`tests/budget.test.ts` asserts that relationship rather than trusting a document to stay true.

### 2. Prefix-cache friendly

DSH sends the system prompt as a system-role message of *derived history*. Without
`systemPromptUpdate`, non-empty prompt text is consolidated at the **first** system node through
per-node replacements — meaning **any change to the prompt head forfeits prefix reuse from its first
changed token.**

That settles the channel split with no room for negotiation:

- **Anything that changes** goes through the runtime-context channel, which *appends* a sourced
  user-role message after the cached prefix, and only when the rendered text actually changed.
- **Only what is stable** goes through `section()`. Rules and identity are identical every session, so
  they sit in the prompt head and the prefix cache pays for them once.

Putting a per-turn index in a section — the first draft's mistake — spends the entire cache benefit to
buy nothing.

### 3. Zero-LLM distillation

Candidate extraction runs on deterministic rules over the session event stream: explicitly stated
preferences, repeated tool-call patterns, decisions the user gave feedback on. Quality scoring and
scope selection are rules too. **No extra model call is ever made** — the current session's agent does
the writing in passing.

### 4. SQLite is the source of truth; Markdown is an export format

The one exception is the identity layer, where `IDENTITY.md` **is** the source of truth and the
database row is only an index. It stays an ordinary file the user can hand-edit and keep in git, and
the plugin syncs it into the database at startup and on change.

Why not store bodies as Markdown — the ecosystem answers this directly. `dsh-destinywind-memory`
documented what it hit migrating away from its own v1 Markdown format: a body line beginning with `## `
**split one memory into two and swallowed the heading**; a `<!-- tags: x -->` comment line had its
content written back as **real tags**; `###`, lists, quotes and code fences could all be **discarded as
structure** by a lenient parser. A database has none of that ambiguity: **the body is an opaque value,
and no parser will ever reinterpret it.**

### 5. Project isolation keyed on the git repository root

`git rev-parse --show-toplevel` gives the repository root (the innermost one, for nested repositories);
worktrees share a `project_key` through `git rev-parse --git-common-dir`; a non-git directory climbs to
the nearest marker file (`.dsh/`, `package.json`, `pyproject.toml`, …); failing that it falls back to
`cwd`; and when nothing can be determined the memory stays **session-scoped and never reaches the
project layer.**

Everything is stored centrally under `$DSH_HOME/evermemory/` and isolated by `project_key` — the plugin
**never writes files into your project directories.**

### 6. Concurrency: thread the session explicitly, never read global state

This one comes from a real incident. `dsh-memory-palace` issue #1 was "the E projection did not pass
the session cwd through under concurrent sessions or workspace switching, so memories crossed between
projects". Issue #3 records that the fix covered only the **read** direction: the **write** path's
`_settle` still read the global `state.activeSession`, so logs landed in the wrong project.

So: **both the read and the write path take session and cwd explicitly, and neither may infer the
current session from global state.**

---

## Install

```bash
# from npm
dsh plugin --profile web add dsh-evermemory

# from a local tarball — the path must be absolute: `dsh plugin` runs pnpm in the profile
# directory, so a relative path resolves there rather than in your current directory.
npm pack
dsh plugin --profile web add "$(pwd)/dsh-evermemory-0.1.0.tgz"     # bash
dsh plugin --profile web add "$PWD\dsh-evermemory-0.1.0.tgz"       # PowerShell
```

With `dsh-hmr` enabled in the profile this applies immediately, otherwise restart DSH; then
Settings → **Memory & Rules**.

`dsh plugin` only forwards its arguments to pnpm, so `pnpm` has to be on `PATH`. Without it, run the
same `add` / `remove` with the profile's own pnpm in that directory (the desktop build ships one:
`resources/runtime/pnpm/bin/pnpm.cjs` with
`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`) and then add the package name to
`dsh.profile.bundles` in `package.json` by hand — that reconciliation is the step `dsh plugin` performs.

> To reinstall after a rebuild, `remove` first and then `add`. The dependency spec is the same tarball
> path and the version is still 0.1.0, so pnpm considers itself already installed and leaves the old
> files in place.

## The settings panel

Settings → **Memory & Rules**, five tabs:

| Tab | What it does |
|---|---|
| Preferences | the ten switches, the extra rule directories, save / discard against the live config snapshot |
| Memories | paged list, full-text search, scope / status / project filters, inline edit, pin, archive |
| Remember | write one memory by hand — the same thing `evermemory_remember` does in conversation |
| Daily | read one day's log and append an entry |
| Data | export Markdown; import from another tool, with a preview first |

Every value the panel shows comes through the Host's `/evermemory/api` route; **the panel itself never
touches the database**:

- The route depends on one service, `connection`, because that is where the fence lives — the
  Host/Origin check plus the browser session cookie. A Host with a web server but no connection service
  gets **neither the route nor the page**: the browser half reads its data through that same service, so
  the two halves degrade together rather than presenting a page whose every request fails.
- The request body arrives from a socket, so the Host **re-validates every field** instead of trusting
  the types the browser sent.
- Writes keep the conversational tools' semantics: the same statement twice returns the same id, an
  identity row cannot be archived, an empty patch is refused.
- A `dryRun` preview **writes nothing**, so the panel labels that counter "would write" rather than
  "written" — a completed action and a projection must not read the same.

Dark and light follow the theme automatically, every colour and size resolves through a `--dsw-*` token
(audited by `npm run check:tokens`), and the page deliberately does **not** depend on
`@deepseek-ai/dsh-client-ui-primitives`: a third-party plugin that does gets its whole slot entry
blanked when a component throws, with nothing but `slot entry crashed in '<slot>'` in the console.

## Configuration

Every preference is editable from the settings panel — the ten switches *are* the ten volatile fields.
Deployment limits — the per-turn budget among them — are deliberately **not** exposed in the UI and can
only be overridden from a profile's `cordis.patch.yml`. Making a budget a clickable toggle is how the
7.1× lesson gets buried a second time.

Profile overrides are **id-targeted** and **must restate the whole `config` object**, because a patch
replaces the targeted row's entire config:

```yaml
- id: dsh-evermemory
  name: dsh-evermemory
  config:
    rulesEnabled: false
    memoryEnabled: true
    # …every other key must be listed too
```

---

## Development

```bash
npm install
npm run build         # emits lib/index.js (Host half) and lib/client.js (browser half)
npm run typecheck     # both halves, separately
npm run check:tokens  # design-token compliance audit
npm test              # contract, budget invariants, storage / retrieval / injection / tools / import / panel
```

### About the `@deepseek-ai/*` dependencies

**They are not published to the registry at the installed runtime's version.** The runtime on this
machine is `0.1.7-rc.2`, while the registry carries `@deepseek-ai/dsh-tools` and friends at
`0.0.1-rc.1` and `-dsh-agent` at `0.1.0-rc.6`.

So this package declares **no** `peerDependencies`. Declaring them would only pin the plugin to an API
it will never run against — and npm's arborist crashes outright when placing a wildcard-versioned peer
(`place-dep.js:299`).

Type checking uses the shallow declarations under `types/shims/`; the test runner has the bare
specifiers redirected to `scripts/shims/` by the loader hook in `scripts/peer-hooks.mjs`. Neither
reaches the published artifact: the build treats every `@deepseek-ai/*` specifier as external, so the
host resolves the real packages.

### The three identifiers that must agree

| Location | Value |
|---|---|
| `cordis.patch.yml` `insert.id` | `dsh-evermemory` — **also the settings namespace**, since the Loader entry id is what the host keys on |
| the cordis `name` exported by `lib/index.js` | `dsh-evermemory` |
| `cordis.patch.yml` `insert.name` | the package name, `dsh-evermemory` |

`tests/contract.test.ts` asserts all three.

> **On `dsh.plugin.json`:** it is **not** part of the real manifest spec. The runtime manifest is the
> `dsh` field of `package.json`, as defined by `@deepseek-ai/dsh-package-manifest`. `dsh.plugin.json`
> has only ever appeared as a marketplace catalogue entry in the `omdsh-dev/DSH-better-sidebar`
> repository; it is absent from that package's own dependency tree, from the asar, and from every
> installed plugin. This package ships one for marketplace listing, and **deleting it changes nothing
> at runtime.**

### The shape of the browser artifact

The client half ends up as a **single self-contained chunk** wrapped in
`window.__ModuleLoader__.load({ id, factory })`.

That is not a style preference. The client module system implements CommonJS whose `require` resolves
only against a fixed module table (`react`, `@deepseek-ai/cordis` and a few client packages), so one
`client*.js` output **cannot synchronously require another relative `client*.js` output** — there is no
relative-module hook to satisfy it.

The build also asserts that no React internals appear in the artifact, that no `require` names a
specifier outside the module table, and that the body stays inside its size budget. Bundling React
would give the plugin a **second React instance**; hooks would throw at render time while the build,
the load and the type check all stayed green.

---

## Roadmap

- [x] **Step 1** architecture and constraint review, ambiguity resolution, technical proposal
- [x] **Step 2** project skeleton (host half, browser half, build configuration)
- [x] **Step 3** storage: SQLite schema, migrations, CRUD, four-state merge
- [x] **Step 4** distillation engine: the rule pipeline
- [x] **Step 5** injection engine: module 1 section, module 2 on-demand injection, budget enforcement
- [x] **Step 6** conversational tool set (`evermemory_*`)
- [x] **Step 7** multi-source import (WorkBuddy / Claude / ChatGPT / ZCode / Hermes)
- [x] **Step 8** settings panel (host and browser halves, full function)
- [ ] **Step 9** test coverage, bilingual docs, packaging and release (tests, docs, the 0.1.0 package and
  the first commit `v0.1.0` are done; the release waits on a repository URL)

---

## Documentation

- [PROPOSAL.md](./PROPOSAL.md) — the full technical proposal: verified API facts, measured ecosystem
  evidence, and every decision with its rationale. (Written in Chinese.)

## License

[MIT](./LICENSE)

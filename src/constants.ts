/**
 * Fixed values that no deployment should be able to vary.
 *
 * Anything a user might reasonably want to change lives in `config.ts` as a schemastery
 * field instead. What stays here is structural: identifiers the Cordis Loader keys on,
 * numbers that encode a hard requirement from the project brief, and the enums the whole
 * codebase switches over.
 */

/**
 * The Cordis plugin name. This MUST equal `insert.id` in cordis.patch.yml.
 *
 * It is also the settings namespace: the Loader entry id is what the Host
 * `SettingsForms` service keys a preferences form on, so this one string decides both
 * how the plugin mounts and where its settings live.
 */
export const PLUGIN_NAME = 'dsh-evermemory'

/** Full tool-name prefix. Cordis tool names are global and unprefixed, so ours must be. */
export const TOOL_PREFIX = 'evermemory_'

/** The browser half's bundle id, which `dsh.client.platform: 'web'` makes the package name. */
export const CLIENT_BUNDLE_ID = PLUGIN_NAME

/**
 * The settings panel's data channel.
 *
 * One path segment, and that is a hard constraint rather than a naming choice: the DSH
 * connection service validates a channel against `/^\/[A-Za-z0-9._~-]+$/` on both sides
 * and reserves the literal `/api` for its own fetch bridge, so a two-segment value such as
 * `/dsh-evermemory/api` is rejected outright. A method name becomes the segment after this
 * one (`POST /dsh-evermemory/overview`), and the answer is the connection envelope
 * `{ok: true, value}` / `{ok: false, error}`.
 *
 * There is deliberately no write header here. The browser client's `connection.rpc.call`
 * posts JSON with `content-type` as its only header, so a custom header could not be
 * required without breaking the official client. The CSRF control is the connection's own
 * admission fence: a cross-site `Origin` is refused with 403 and an unauthenticated
 * request with 401, before any handler runs.
 */
export const API_ROUTE_PREFIX = `/${PLUGIN_NAME}`

// ─────────────────────────────────────────────────────────────────────────────
// Prompt section / runtime context orders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Order for module 1 (behavioural rules + identity).
 *
 * The band 100–199 is NOT free: ecological reconnaissance of 13 comparable plugins shows
 * it is the authoritative tool-guidance band (`dsh-mnemosyne/docs/design.md:291` says so
 * in as many words). `50` is the established slot for "after the persona, before tool
 * guidance", already used by `dsh-memory`'s recall section and `dsh-charter`'s rules.
 */
export const ORDER_RULES = 50

/**
 * Order for the resident memory index section.
 *
 * `dsh-destinywind-memory` occupies 216 with the same shape — the whole bank split into
 * hard constraints and background knowledge — and 216 is verified in the field.
 */
export const ORDER_MEMORY_INDEX = 216

/**
 * Optional one-line "memory check" reminder at the very tail of the prompt.
 *
 * Off by default. It exploits recency, which is real, but any change to it rewrites the
 * prompt head and forfeits prefix reuse from the first changed token — so it must stay
 * byte-identical across turns or it is a net loss.
 */
export const ORDER_MEMORY_TAIL_REMINDER = 9999

/**
 * Order for the runtime-context contribution.
 *
 * `dsh-destinywind-memory` uses 100 here for hard constraints only. Runtime context is a
 * separate channel from sections, so this number shares no namespace with the orders
 * above; 100 is reused only because it is the verified field value.
 */
export const ORDER_RUNTIME_CONTEXT = 100

// ─────────────────────────────────────────────────────────────────────────────
// Token budgets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard per-turn ceiling, in characters, for everything this plugin injects in one turn.
 *
 * Enforced per turn, never per entry and never per file. The distinction is the single
 * most common budget bug in this ecosystem: `dsh-memory-palace` documents an 8000-char
 * user budget and a 6000-char workspace budget that are each per FILE, and then measures
 * a worst case of 8 injected messages ≈ 50k characters — 7.1× its own stated bound.
 *
 * 4000 characters is the ~1k-token headline constraint expressed in the unit the code
 * actually counts, for the mixed Chinese-and-English text these layers hold.
 */
export const TURN_BUDGET_CHARS = 4000

/**
 * Budget for the resident index (names + keywords only, never bodies).
 *
 * These three caps are deliberately set so their sum leaves a quarter of the turn budget
 * for the rules section and framing. They are caps rather than costs: the index and card
 * are skipped outright when their rendered text is unchanged, which is the common case.
 */
export const INDEX_BUDGET_CHARS = 900

/** Budget for the per-turn relevance card. */
export const CARD_BUDGET_CHARS = 900

/**
 * Bodies retrieved per turn for the card channel, before the char budget cuts them down.
 *
 * Four rather than the retriever's own default of ten: the card budget is 900 characters, so a
 * tenth result can never be rendered, and ranking more rows than can be shown would let a
 * long-shot match that scores above a relevant one consume the turn's retrieval for nothing.
 */
export const CARD_RECALL_LIMIT = 4

/**
 * Longest user text used as a retrieval query.
 *
 * Taken from the END of the message, because a question follows the material it is about far more
 * often than it precedes it — pasting a file and then asking about it is the common shape. The
 * retriever tokenises at most eight fragments of 64 characters, so this bound is about not walking
 * a 100 kB paste, not about what can be matched.
 */
export const STEP_QUERY_CHARS = 2000

/**
 * Budget for hard constraints injected through runtime context.
 *
 * Smaller than the other two because this channel is always sent — it is not deduplicated
 * away when stable, so every character here is paid for on every step.
 */
export const CONSTRAINT_BUDGET_CHARS = 700

// ─────────────────────────────────────────────────────────────────────────────
// Memory layers
// ─────────────────────────────────────────────────────────────────────────────

/** The four layers, in precedence order for retrieval. */
export const MEMORY_SCOPES = ['identity', 'global', 'project', 'daily'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/** Lifecycle states. `pending` is for imported or low-confidence candidates awaiting approval. */
export const MEMORY_STATUSES = ['active', 'outdated', 'archived', 'pending'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** Where an entry came from, which decides whether it may auto-activate. */
export const MEMORY_SOURCES = ['auto', 'dialogue', 'import', 'manual'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

/** Which of the four states a merge decided on. */
export const MERGE_DECISIONS = ['new', 'merge', 'update', 'ignore'] as const
export type MergeDecision = (typeof MERGE_DECISIONS)[number]

// ─────────────────────────────────────────────────────────────────────────────
// Caps (deployment limits, deliberately NOT user-editable)
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum entries retained in the global layer before eviction to `archived`. */
export const GLOBAL_ENTRY_CAP = 200

/** Maximum entries retained per project before eviction to `archived`. */
export const PROJECT_ENTRY_CAP = 500

/** Days a daily log stays verbatim before it is compressed into a weekly summary. */
export const DAILY_LOG_RETENTION_DAYS = 30

/** Default and maximum `limit` a tool call may request. */
export const SEARCH_LIMIT_DEFAULT = 10
export const SEARCH_LIMIT_MAX = 50

/** Maximum characters accepted for a single memory body. */
export const MAX_MEMORY_CHARS = 8000

// ─────────────────────────────────────────────────────────────────────────────
// Storage layout
// ─────────────────────────────────────────────────────────────────────────────

/** Environment variable that relocates the whole DSH home directory. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Subdirectory of the DSH home that holds this plugin's SQLite database. */
export const STORAGE_DIR_NAME = 'evermemory'

/** Filename of the database. `.sqlite` rather than `.db` to say what actually wrote it. */
export const STORAGE_FILE_NAME = 'evermemory.sqlite'

/** Recognised origin platforms, for the `source_platform` column and import dedup. */
export const SOURCE_PLATFORMS = ['workbuddy', 'claude', 'chatgpt', 'zcode', 'hermes', 'evermemory'] as const
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number]

/**
 * Marker files that identify a project root when git cannot.
 *
 * Ordered most-specific first. The rule is that the nearest ancestor containing any of
 * these is the root — an inner `package.json` beats an outer one, which is what makes a
 * monorepo package its own memory scope rather than inheriting the repository's.
 */
export const PROJECT_MARKERS = [
  '.dsh',
  '.git',
  'pnpm-workspace.yaml',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
] as const

/**
 * How long a `git` probe result is trusted, in milliseconds.
 *
 * Identity is resolved inside the per-step injection path, and spawning a process on every
 * step would be both wasteful and visible. A project root does not move while the process
 * is alive, so one probe per window per directory is enough.
 */
export const GIT_PROBE_TTL_MS = 30_000

/** Wall-clock ceiling for a single `git` invocation before it is treated as unavailable. */
export const GIT_PROBE_TIMEOUT_MS = 2000

/**
 * The wire contract between the host route and the settings page.
 *
 * It lives in its own module, with no runtime imports, because both halves need it: the host
 * dispatch (`api.ts`) types its answers with it, and the browser page types its calls with it. A
 * type-only import costs the client bundle nothing, while a shared runtime module would drag host
 * code into a bundle that is loaded by a browser with no `node:` builtins at all.
 *
 * The envelope is not invented here. It is the one `@deepseek-ai/dsh-client-connection` already
 * speaks: the browser calls `connection.rpc.call(channel, endpoint, payload)` and gets back the
 * parsed `result` field of a `server-response`, i.e. exactly {@link PanelEnvelope}. A business
 * failure therefore arrives as a fulfilled promise carrying `ok: false` — it never rejects — so
 * every branch below can be handled where it happens instead of in a `catch`.
 */

import type { MemoryScope, MemorySource, MemoryStatus, SourcePlatform } from '../constants.js'

/** Methods this route serves. The endpoint segment of `channel/method`. */
export type PanelMethod =
  | 'overview'
  | 'list'
  | 'get'
  | 'search'
  | 'remember'
  | 'forget'
  | 'update'
  | 'daily'
  | 'log'
  | 'export'
  | 'import'

/** The failure half of an answer. `code` is stable; `message` is for the user. */
export interface PanelError {
  readonly code: PanelErrorCode
  /** One line, ready to render. Written in Chinese: every reader of this route is the panel. */
  readonly message: string
  readonly details: Record<string, unknown>
}

/** Stable failure codes, so the page can branch without matching on prose. */
export type PanelErrorCode =
  /** The store could not be opened; `message` carries `StoreHandle.describeFailure()`. */
  | 'store/unavailable'
  /** The payload did not match the method's shape. */
  | 'request/invalid'
  /** The named row does not exist. */
  | 'memory/not-found'
  /** The store rejected the operation. */
  | 'memory/refused'
  /** Anything unexpected; `details.detail` carries the original text. */
  | 'internal'

/** One answer, as `connection.rpc.call` hands it back. */
export type PanelEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PanelError }

/**
 * A project a panel action applies to.
 *
 * The panel has no agent, so it has no working directory to derive an identity from. It sends the
 * pair it read out of `overview.projects` instead, which is also what makes a row's own project
 * visible to `forget` — the service refuses to touch a project layer the caller cannot name.
 */
export interface PanelProjectRef {
  readonly key: string
  readonly path?: string | null
}

/** One memory row, as the panel renders it. */
export interface PanelMemory {
  readonly id: number
  readonly title: string
  /** Cut at {@link LIST_TEXT_CHARS} in list answers; the `get` method returns all of it. */
  readonly text: string
  /** True when `text` was cut, so the page knows to fetch the row before editing it. */
  readonly textTruncated?: boolean
  readonly scope: MemoryScope
  readonly status: MemoryStatus
  readonly projectKey: string | null
  readonly projectPath: string | null
  readonly tags: readonly string[]
  readonly source: MemorySource
  readonly sourcePlatform: SourcePlatform | null
  readonly pinned: boolean
  readonly importance: number
  readonly lastUsedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** How much of a row's text a list answer carries. */
export const LIST_TEXT_CHARS = 600

/** Rows one `list` answer may carry, whatever the caller asks for. */
export const LIST_LIMIT_MAX = 200

/** Rows a `list` answer carries when the caller names no limit. */
export const LIST_LIMIT_DEFAULT = 30

/** `overview`: what the store holds, without loading any rows. */
export interface PanelOverview {
  /** `StoreHandle.status`: `idle` before the first open, then `opening`/`ready`/`failed`. */
  readonly status: string
  /** The SQLite file, once known. */
  readonly database: string | null
  /** `StoreHandle.describeFailure()`, or an empty string while the store is fine. */
  readonly failure: string
  readonly version: string
  /** Rows per scope. */
  readonly scopes: Readonly<Record<MemoryScope, number>>
  /** Rows per status. */
  readonly statuses: Readonly<Record<MemoryStatus, number>>
  /** Rows per source, so an import's footprint is visible. */
  readonly sources: Readonly<Record<string, number>>
  readonly total: number
  /** Every project the store knows, newest first. */
  readonly projects: readonly PanelProjectRow[]
  /** Tag vocabulary with counts. */
  readonly tags: readonly PanelTagRow[]
}

/** One project as the overview reports it. */
export interface PanelProjectRow {
  readonly projectKey: string
  readonly projectPath: string | null
  readonly count: number
}

/** One tag as the overview reports it. */
export interface PanelTagRow {
  readonly tag: string
  readonly count: number
}

/** `list`: a filtered page of rows. */
export interface PanelListRequest {
  readonly scope?: readonly MemoryScope[]
  readonly status?: readonly MemoryStatus[]
  /** Restrict to one project layer. Omit for every layer. */
  readonly project?: PanelProjectRef
  /** Restrict to rows with no project. Mutually exclusive with `project`. */
  readonly globalOnly?: boolean
  readonly tag?: string
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: 'created' | 'used' | 'importance'
}

/** `list` answer. */
export interface PanelListResult {
  readonly items: readonly PanelMemory[]
  /** Rows matching the filter, ignoring `limit`/`offset`. */
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** `get`: one row, whole. */
export interface PanelGetRequest {
  readonly id: number
}

/** `get` answer. */
export interface PanelGetResult {
  readonly item: PanelMemory
}

/** `search`: retrieval, the same engine the injection path uses. */
export interface PanelSearchRequest {
  readonly query: string
  readonly scope?: readonly MemoryScope[]
  readonly limit?: number
  readonly project?: PanelProjectRef
}

/** One retrieval hit. Mirrors `SearchHit` from the memory service. */
export interface PanelSearchHit {
  readonly id: number
  readonly title: string
  readonly text: string
  readonly scope: MemoryScope
  readonly status: MemoryStatus
  readonly pinned: boolean
  readonly importance: number
  readonly tags: readonly string[]
  readonly updatedAt: string
}

/** `search` answer. */
export interface PanelSearchResult {
  readonly hits: readonly PanelSearchHit[]
}

/** `remember`: the panel's write path, through the same gate the tools use. */
export interface PanelRememberRequest {
  readonly text: string
  readonly title?: string
  readonly scope?: 'global' | 'project'
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly importance?: number
  readonly project?: PanelProjectRef
}

/** `remember` answer. Mirrors `RememberResult`. */
export interface PanelRememberResult {
  readonly decision: string
  readonly id: number | null
  readonly scope: string
  readonly text: string
  readonly reason: string
  readonly superseded: readonly number[]
}

/** `forget`: archive one row. Never a delete — the store keeps its history. */
export interface PanelForgetRequest {
  readonly id: number
  readonly project?: PanelProjectRef
}

/** `forget` answer. Mirrors `ForgetResult`. */
export interface PanelForgetResult {
  readonly ok: boolean
  readonly id: number
  readonly text: string
  readonly status: string
  readonly reason: string
}

/** `update`: the fields the panel may rewrite. */
export interface PanelPatch {
  readonly title?: string
  readonly text?: string
  readonly scope?: MemoryScope
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly importance?: number
  readonly status?: MemoryStatus
}

/** `update` request. */
export interface PanelUpdateRequest {
  readonly id: number
  readonly patch: PanelPatch
  readonly project?: PanelProjectRef
}

/** `update` answer. */
export interface PanelUpdateResult {
  readonly item: PanelMemory
}

/** `daily`: read one day's log. */
export interface PanelDailyRequest {
  readonly date?: string
  readonly project?: PanelProjectRef
}

/** `daily` answer. */
export interface PanelDailyResult {
  readonly log: {
    readonly date: string
    readonly text: string
    readonly entries: readonly string[]
    readonly createdAt: string
    readonly updatedAt: string
    readonly status: string
  } | null
}

/** `log`: append entries to today's log. */
export interface PanelLogRequest {
  readonly entries: readonly string[]
  readonly date?: string
  readonly project?: PanelProjectRef
}

/** `log` answer. Mirrors `LogResult`. */
export interface PanelLogResult {
  readonly date: string
  readonly written: number
  readonly id: number | null
  readonly reason: string
}

/** `export`: the Markdown document. */
export interface PanelExportRequest {
  readonly scope?: readonly MemoryScope[]
  /** Include archived and outdated rows. Off by default — an export is usually a handover. */
  readonly includeArchived?: boolean
  readonly project?: PanelProjectRef
}

/** `export` answer. */
export interface PanelExportResult {
  readonly markdown: string
  readonly filename: string
  readonly count: number
  readonly bytes: number
}

/** `import`: the step-7 engine, driven from the panel. */
export interface PanelImportRequest {
  readonly path: string
  readonly dryRun?: boolean
  readonly scope?: 'global' | 'project'
  readonly project?: PanelProjectRef
}

/** `import` answer: the engine's own report, which is already JSON-clean. */
export interface PanelImportResult {
  readonly ok: boolean
  readonly path: string
  readonly source: string
  readonly platform: string | null
  readonly scanned: number
  readonly considered: number
  readonly skipped: number
  readonly known: number
  readonly oversized: number
  readonly written: number
  readonly merged: number
  readonly updated: number
  readonly ignored: number
  readonly rejected: number
  readonly logged: number
  readonly dryRun: boolean
  readonly truncated: boolean
  readonly errors: readonly string[]
  readonly samples: readonly { readonly uri: string; readonly text: string; readonly decision: string; readonly reason?: string }[]
}

/** Request shapes per method, so the page and the dispatch agree on one table. */
export interface PanelRequestMap {
  readonly overview: undefined
  readonly list: PanelListRequest
  readonly get: PanelGetRequest
  readonly search: PanelSearchRequest
  readonly remember: PanelRememberRequest
  readonly forget: PanelForgetRequest
  readonly update: PanelUpdateRequest
  readonly daily: PanelDailyRequest
  readonly log: PanelLogRequest
  readonly export: PanelExportRequest
  readonly import: PanelImportRequest
}

/** Answer shapes per method. */
export interface PanelResultMap {
  readonly overview: PanelOverview
  readonly list: PanelListResult
  readonly get: PanelGetResult
  readonly search: PanelSearchResult
  readonly remember: PanelRememberResult
  readonly forget: PanelForgetResult
  readonly update: PanelUpdateResult
  readonly daily: PanelDailyResult
  readonly log: PanelLogResult
  readonly export: PanelExportResult
  readonly import: PanelImportResult
}

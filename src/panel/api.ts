/**
 * The panel's method dispatch.
 *
 * Kept separate from the HTTP wiring (`route.ts`) for two reasons: the interesting behaviour —
 * validation, policy, what a failure code means — is testable without a socket, and the route then
 * has exactly one job, which is to speak the connection envelope.
 *
 * The policy it enforces is the panel's, not a session's. An agent may only write the layers it can
 * name, which is why `remember` and `forget` route through `MemoryService` with a session built
 * from the project the caller selected. Everything else here — reading every project's rows,
 * patching status, exporting — is an operator action, and the service's own documentation names
 * this surface as the reason `get repository()` is public at all.
 */

import {
  MAX_MEMORY_CHARS,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} from '../constants.js'
import type { MemoryScope, MemorySource, MemoryStatus } from '../constants.js'
import { runImport } from '../importers/run.js'
import { MemoryService, createSession } from '../memory/service.js'
import type { MemorySession } from '../memory/service.js'
import type { StoreHandle } from '../storage/handle.js'
import type { MemoryPatch, MemoryQuery, MemoryRecord, MemoryRepository } from '../storage/repository.js'
import { VERSION } from '../version.js'
import { exportMarkdown } from './export.js'
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, LIST_TEXT_CHARS } from './protocol.js'
import type {
  PanelDailyRequest,
  PanelDailyResult,
  PanelEnvelope,
  PanelErrorCode,
  PanelExportRequest,
  PanelExportResult,
  PanelForgetRequest,
  PanelForgetResult,
  PanelGetRequest,
  PanelGetResult,
  PanelImportRequest,
  PanelImportResult,
  PanelListRequest,
  PanelListResult,
  PanelLogRequest,
  PanelLogResult,
  PanelMemory,
  PanelMethod,
  PanelOverview,
  PanelProjectRef,
  PanelRememberRequest,
  PanelRememberResult,
  PanelSearchHit,
  PanelSearchRequest,
  PanelSearchResult,
  PanelUpdateRequest,
  PanelUpdateResult,
} from './protocol.js'

/**
 * What the connection service calls to serve one request.
 *
 * The parameter list is the official handler's, not a simplification of it: the connection service
 * invokes `handler(endpoint, payload, signal, peer)`, so a handler declared with two parameters
 * would work today and lose access to cancellation the moment it needed it.
 */
export type PanelHandler = (
  method: string,
  payload: unknown,
  signal?: unknown,
  peer?: unknown,
) => PanelEnvelope<unknown> | Promise<PanelEnvelope<unknown>>

/** What the route needs to serve requests. */
export interface PanelApiOptions {
  /** The plugin's one store handle. Read lazily: a panel call is what opens the store if needed. */
  readonly store: StoreHandle
  /** Clock injection for the export header. */
  readonly now?: () => Date
}

/** The mounted dispatch. */
export interface PanelApi {
  readonly handle: PanelHandler
}

/** An expected failure, carried out of a method and turned into an envelope by the dispatcher. */
class PanelFailure extends Error {
  constructor(
    readonly code: PanelErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'PanelFailure'
  }
}

/** Bounds for one cheap call, so a hostile payload cannot turn a panel click into a scan. */
const TAGS_MAX = 32
const TAG_CHARS = 40
const TITLE_CHARS = 200
const LOG_ENTRIES_MAX = 200
const IMPORT_TAGS = ['panel'] as const

/**
 * Build the dispatch.
 *
 * @param options - the store handle and an optional clock.
 * @returns the handler the route registers.
 */
export function createPanelApi(options: PanelApiOptions): PanelApi {
  const handle: PanelHandler = async (method, payload) => {
    try {
      return { ok: true, value: await dispatch(options, method, payload) }
    } catch (error) {
      if (error instanceof PanelFailure) {
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
      }
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'internal', message: `面板操作失败：${detail}`, details: { detail } } }
    }
  }

  return { handle }
}

/**
 * Route one method.
 *
 * @param options - the store handle.
 * @param method - the endpoint segment.
 * @param payload - the request body, unvalidated.
 * @returns the method's answer.
 * @throws PanelFailure for anything the caller can fix.
 */
async function dispatch(options: PanelApiOptions, method: string, payload: unknown): Promise<unknown> {
  const store = options.store
  const repository = await open(store)
  const db = store.dbIfReady
  if (db === undefined) throw new PanelFailure('store/unavailable', store.describeFailure() || '记忆数据库不可用。')
  const service = new MemoryService(repository, db)

  switch (method as PanelMethod) {
    case 'overview':
      return overview(store, repository)
    case 'list':
      return list(repository, requestOf<PanelListRequest>(payload))
    case 'get':
      return get(repository, requestOf<PanelGetRequest>(payload))
    case 'search':
      return search(service, requestOf<PanelSearchRequest>(payload))
    case 'remember':
      return remember(service, requestOf<PanelRememberRequest>(payload))
    case 'forget':
      return forget(service, requestOf<PanelForgetRequest>(payload))
    case 'update':
      return update(repository, requestOf<PanelUpdateRequest>(payload))
    case 'daily':
      return daily(service, requestOf<PanelDailyRequest>(payload))
    case 'log':
      return log(service, requestOf<PanelLogRequest>(payload))
    case 'export':
      return exportDocument(repository, requestOf<PanelExportRequest>(payload), options.now)
    case 'import':
      return importPath(repository, requestOf<PanelImportRequest>(payload))
    default:
      throw new PanelFailure('request/invalid', `未知的面板方法：${method}`, { method })
  }
}

/**
 * The repository, opening the store if this is the first call.
 *
 * The panel is a user action, so waiting for a disk operation here is honest in a way it is not on
 * the injection path: the click was made seconds ago and the answer is what the user asked for. A
 * failure keeps `StoreHandle`'s remembered reason, which is the one message worth showing.
 */
async function open(store: StoreHandle): Promise<MemoryRepository> {
  const ready = store.repositoryIfReady
  if (ready !== undefined) return ready
  try {
    return await store.repository()
  } catch (error) {
    const described = store.describeFailure()
    const detail = error instanceof Error ? error.message : String(error)
    throw new PanelFailure('store/unavailable', described === '' ? `记忆数据库无法打开：${detail}` : described)
  }
}

/** `overview`: counts and vocabularies, loaded with `COUNT` queries only. */
function overview(store: StoreHandle, repository: MemoryRepository): PanelOverview {
  const scopes = {} as Record<MemoryScope, number>
  for (const scope of MEMORY_SCOPES) scopes[scope] = repository.count({ scope })

  const statuses = {} as Record<MemoryStatus, number>
  for (const status of MEMORY_STATUSES) statuses[status] = repository.count({ status })

  const sources: Record<string, number> = {}
  for (const source of MEMORY_SOURCES as readonly MemorySource[]) {
    const count = repository.count({ source })
    if (count > 0) sources[source] = count
  }

  return {
    status: store.status,
    database: store.path ?? null,
    failure: store.describeFailure(),
    version: VERSION,
    scopes,
    statuses,
    sources,
    total: repository.count({}),
    projects: repository.projects(),
    tags: repository.allTags(),
  }
}

/** `list`: one filtered page, with the same filter counting the total. */
function list(repository: MemoryRepository, request: PanelListRequest): PanelListResult {
  const limit = clamp(number(request.limit) ?? LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX)
  const offset = clamp(number(request.offset) ?? 0, 0, 1_000_000)
  const filter = filterOf(request)

  const items = repository
    .list({ ...filter, limit, offset, orderBy: request.orderBy ?? 'used' })
    .map((row) => view(row, true))

  return { items, total: repository.count(filter), limit, offset }
}

/** `get`: one row with its text intact, which is what the editor needs. */
function get(repository: MemoryRepository, request: PanelGetRequest): PanelGetResult {
  const id = number(request.id)
  if (id === undefined) throw new PanelFailure('request/invalid', '缺少记忆 id。', { id: request.id })
  const row = repository.get(id)
  if (row === undefined) throw new PanelFailure('memory/not-found', `找不到编号为 ${String(id)} 的记忆。`, { id })
  return { item: view(row, false) }
}

/** `search`: the retrieval engine, so the panel ranks rows the way a session would. */
function search(service: MemoryService, request: PanelSearchRequest): PanelSearchResult {
  const query = text(request.query)
  if (query === '') throw new PanelFailure('request/invalid', '请输入搜索内容。')
  const limit = clamp(number(request.limit) ?? SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX)
  const scope = scopes(request.scope)
  const hits: PanelSearchHit[] = service
    .search(sessionOf(request), scope === undefined ? { query, limit } : { query, scope, limit })
    .map((hit) => ({
      id: hit.id,
      title: hit.title,
      text: hit.text,
      scope: hit.scope,
      status: hit.status,
      pinned: hit.pinned,
      importance: hit.importance,
      tags: hit.tags,
      updatedAt: hit.updatedAt,
    }))
  return { hits }
}

/** `remember`: the panel's write path, through the same gate the conversational tools use. */
function remember(service: MemoryService, request: PanelRememberRequest): PanelRememberResult {
  const body = text(request.text)
  if (body === '') throw new PanelFailure('request/invalid', '记忆内容不能为空。')
  if (body.length > MAX_MEMORY_CHARS) {
    throw new PanelFailure('request/invalid', `记忆内容超过 ${String(MAX_MEMORY_CHARS)} 字上限。`, { chars: body.length })
  }

  const scope = request.scope ?? 'global'
  if (scope !== 'global' && scope !== 'project') {
    throw new PanelFailure('request/invalid', `无法写入层级 ${String(scope)}：面板只能写全局或项目层。`, { scope })
  }
  if (scope === 'project' && request.project === undefined) {
    throw new PanelFailure('request/invalid', '写入项目层需要先选择项目。')
  }

  const result = service.remember(sessionOf(request), {
    text: body,
    scope,
    ...(request.title === undefined ? {} : { title: cut(request.title, TITLE_CHARS) }),
    ...(request.tags === undefined ? {} : { tags: cleanTags(request.tags) }),
    ...(request.pinned === undefined ? {} : { pinned: request.pinned === true }),
    ...(number(request.importance) === undefined ? {} : { importance: clamp(number(request.importance) ?? 0, 0, 5) }),
  })

  return {
    decision: String(result.decision),
    id: result.id,
    scope: String(result.scope),
    text: result.text,
    reason: result.reason,
    superseded: result.superseded,
  }
}

/** `forget`: archive one row through the service, which refuses what a session may not touch. */
function forget(service: MemoryService, request: PanelForgetRequest): PanelForgetResult {
  const id = number(request.id)
  if (id === undefined) throw new PanelFailure('request/invalid', '缺少记忆 id。', { id: request.id })
  const result = service.forget(sessionOf(request), { id })
  return {
    ok: result.ok,
    id: result.id,
    text: result.text,
    status: String(result.status),
    reason: result.reason,
  }
}

/** `update`: the operator's edit, validated field by field. */
function update(repository: MemoryRepository, request: PanelUpdateRequest): PanelUpdateResult {
  const id = number(request.id)
  if (id === undefined) throw new PanelFailure('request/invalid', '缺少记忆 id。', { id: request.id })
  const patch = patchOf(asRecord(request.patch))
  if (Object.keys(patch).length === 0) throw new PanelFailure('request/invalid', '没有要修改的字段。')

  const current = repository.get(id)
  if (current === undefined) throw new PanelFailure('memory/not-found', `找不到编号为 ${String(id)} 的记忆。`, { id })

  if (patch.scope === 'project') {
    const project = request.project
    if (project === undefined && current.projectKey === null) {
      throw new PanelFailure('request/invalid', '改为项目层需要先选择项目。')
    }
    // Moving a row into a project layer must also move its ownership, or it would be filed under
    // the project's name while remaining invisible to that project's sessions.
    if (project !== undefined) {
      const moved: MemoryPatch = { ...patch, projectKey: project.key, projectPath: project.path ?? null }
      const updated = repository.update(id, moved)
      if (updated === undefined) throw new PanelFailure('memory/not-found', `找不到编号为 ${String(id)} 的记忆。`, { id })
      return { item: view(updated, false) }
    }
  }

  const updated = repository.update(id, patch)
  if (updated === undefined) throw new PanelFailure('memory/not-found', `找不到编号为 ${String(id)} 的记忆。`, { id })
  return { item: view(updated, false) }
}

/** `daily`: one day's log. */
function daily(service: MemoryService, request: PanelDailyRequest): PanelDailyResult {
  const log = service.daily(sessionOf(request), date(request.date))
  if (log === undefined) return { log: null }
  return {
    log: {
      date: log.date,
      text: log.text,
      entries: log.entries,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
      status: String(log.status),
    },
  }
}

/** `log`: append to one day's log. */
function log(service: MemoryService, request: PanelLogRequest): PanelLogResult {
  const entries = (Array.isArray(request.entries) ? request.entries : [])
    .map((entry) => text(entry))
    .filter((entry) => entry !== '')
    .slice(0, LOG_ENTRIES_MAX)
    .map((entry) => ({ text: entry }))

  if (entries.length === 0) throw new PanelFailure('request/invalid', '没有要写入的日志条目。')
  const day = date(request.date)
  const result = service.log(
    sessionOf(request),
    day === undefined ? { entries } : { entries, date: day },
  )
  return { date: result.date, written: result.written, id: result.id, reason: result.reason }
}

/** `export`: the Markdown document, rendered from the store rather than from a client cache. */
function exportDocument(
  repository: MemoryRepository,
  request: PanelExportRequest,
  now: (() => Date) | undefined,
): PanelExportResult {
  const project = request.project
  const scope = scopes(request.scope)
  const document = exportMarkdown(repository, {
    ...(scope === undefined ? {} : { scope }),
    ...(request.includeArchived === undefined ? {} : { includeArchived: request.includeArchived === true }),
    ...(project === undefined ? {} : { projectKey: project.key }),
    ...(now === undefined ? {} : { now: now() }),
  })
  return { markdown: document.markdown, filename: document.filename, count: document.count, bytes: document.bytes }
}

/** `import`: the step-7 engine against the path the user typed. */
async function importPath(repository: MemoryRepository, request: PanelImportRequest): Promise<PanelImportResult> {
  const path = text(request.path)
  if (path === '') throw new PanelFailure('request/invalid', '请输入要导入的路径。')

  const scope = request.scope ?? 'global'
  if (scope !== 'global' && scope !== 'project') {
    throw new PanelFailure('request/invalid', `导入目标层级 ${String(scope)} 不被支持。`, { scope })
  }
  if (scope === 'project' && request.project === undefined) {
    throw new PanelFailure('request/invalid', '导入到项目层需要先选择项目。')
  }

  const outcome = await runImport(repository, {
    path,
    scope,
    tags: IMPORT_TAGS,
    dryRun: request.dryRun === true,
    maxChars: MAX_MEMORY_CHARS,
    projectKey: request.project?.key ?? null,
    projectPath: request.project?.path ?? null,
  })

  return {
    ok: outcome.ok,
    path: outcome.path,
    source: outcome.source,
    platform: outcome.platform,
    scanned: outcome.scanned,
    considered: outcome.considered,
    skipped: outcome.skipped,
    known: outcome.known,
    oversized: outcome.oversized,
    written: outcome.written,
    merged: outcome.merged,
    updated: outcome.updated,
    ignored: outcome.ignored,
    rejected: outcome.rejected,
    logged: outcome.logged,
    dryRun: outcome.dryRun,
    truncated: outcome.truncated,
    errors: outcome.errors,
    samples: outcome.samples.map((sample) => ({
      uri: sample.uri,
      text: sample.text,
      decision: sample.decision,
      ...(sample.reason === undefined ? {} : { reason: sample.reason }),
    })),
  }
}

/**
 * The session a panel action runs as.
 *
 * Deliberately project-less by default. The panel has no agent and therefore no working directory
 * that means anything to the user — `process.cwd()` is wherever the desktop app was launched from,
 * and filing memories under that path as a project would invent a project nobody asked for. A
 * project layer is reached the only honest way: the caller names one, having read it out of
 * `overview.projects`.
 */
function sessionOf(request: { readonly project?: PanelProjectRef | undefined }): MemorySession {
  const base = createSession(undefined)
  const project = request.project
  if (project === undefined) return base
  return {
    ...base,
    projectKey: project.key,
    projectPath: project.path ?? null,
    projectName: project.path?.split(/[\\/]/u).filter((part) => part !== '').at(-1) ?? project.key,
  }
}

/** Translate the list request into a repository query. */
function filterOf(request: PanelListRequest): MemoryQuery {
  const scope = scopes(request.scope)
  const status = statuses(request.status)
  const tag = text(request.tag)
  const project = request.project
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(status === undefined ? {} : { status }),
    ...(tag === '' ? {} : { tag }),
    ...(project === undefined
      ? request.globalOnly === true
        ? { projectKey: null }
        : {}
      : { projectKey: project.key }),
  }
}

/** One row as the panel sees it, with the text cut for list answers. */
function view(row: MemoryRecord, cutText: boolean): PanelMemory {
  const tooLong = cutText && row.text.length > LIST_TEXT_CHARS
  return {
    id: row.id,
    title: row.title,
    text: tooLong ? row.text.slice(0, LIST_TEXT_CHARS) : row.text,
    ...(tooLong ? { textTruncated: true } : {}),
    scope: row.scope,
    status: row.status,
    projectKey: row.projectKey,
    projectPath: row.projectPath,
    tags: row.tags,
    source: row.source,
    sourcePlatform: row.sourcePlatform,
    pinned: row.pinned,
    importance: row.importance,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Validate the fields a patch may carry, dropping unknown keys rather than passing them on. */
function patchOf(raw: Record<string, unknown>): MemoryPatch {
  const patch: {
    title?: string
    text?: string
    scope?: MemoryScope
    tags?: readonly string[]
    pinned?: boolean
    importance?: number
    status?: MemoryStatus
  } = {}

  if (typeof raw.title === 'string') patch.title = cut(raw.title, TITLE_CHARS)
  if (typeof raw.text === 'string') {
    const body = text(raw.text)
    if (body === '') throw new PanelFailure('request/invalid', '记忆内容不能为空。')
    if (body.length > MAX_MEMORY_CHARS) {
      throw new PanelFailure('request/invalid', `记忆内容超过 ${String(MAX_MEMORY_CHARS)} 字上限。`, { chars: body.length })
    }
    patch.text = body
  }
  if (typeof raw.scope === 'string') {
    const scope = MEMORY_SCOPES.find((candidate) => candidate === raw.scope)
    if (scope === undefined) throw new PanelFailure('request/invalid', `未知层级：${raw.scope}`, { scope: raw.scope })
    patch.scope = scope
  }
  if (typeof raw.status === 'string') {
    const status = MEMORY_STATUSES.find((candidate) => candidate === raw.status)
    if (status === undefined) throw new PanelFailure('request/invalid', `未知状态：${raw.status}`, { status: raw.status })
    patch.status = status
  }
  if (Array.isArray(raw.tags)) patch.tags = cleanTags(raw.tags)
  if (typeof raw.pinned === 'boolean') patch.pinned = raw.pinned
  const importance = number(raw.importance)
  if (importance !== undefined) patch.importance = clamp(importance, 0, 5)

  return patch
}

/** Tags, cleaned and bounded: the store's tag vocabulary is a UI surface, not a dumping ground. */
function cleanTags(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>()
  for (const value of values.slice(0, TAGS_MAX)) {
    const tag = cut(text(value), TAG_CHARS)
    if (tag !== '') seen.add(tag)
  }
  return [...seen]
}

/** Layer filter, or `undefined` when the caller named none. */
function scopes(values: readonly MemoryScope[] | undefined): readonly MemoryScope[] | undefined {
  if (!Array.isArray(values)) return undefined
  const kept = values.filter((value): value is MemoryScope => MEMORY_SCOPES.some((scope) => scope === value))
  return kept.length === 0 ? undefined : kept
}

/** Status filter, or `undefined` when the caller named none. */
function statuses(values: readonly MemoryStatus[] | undefined): readonly MemoryStatus[] | undefined {
  if (!Array.isArray(values)) return undefined
  const kept = values.filter((value): value is MemoryStatus => MEMORY_STATUSES.some((status) => status === value))
  return kept.length === 0 ? undefined : kept
}

/** `YYYY-MM-DD` or `undefined`. The service validates the calendar; this rejects the shape. */
function date(value: unknown): string | undefined {
  const raw = text(value)
  return /^\d{4}-\d{2}-\d{2}$/u.test(raw) ? raw : undefined
}

/** A payload object, or an empty one. Never throws: every method validates its own fields. */
function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

/**
 * A payload seen as one request shape.
 *
 * The cast is deliberate and the validation is not skipped by it: every field a method reads is
 * re-checked by `number` / `text` / `scopes` / `cleanTags` before use, because the body arrives from
 * a socket and its TypeScript shape is an assumption, not a guarantee. What the cast buys is that
 * the checks live in one place instead of in a hand-written mirror of the protocol.
 */
function requestOf<T>(payload: unknown): T {
  return asRecord(payload) as unknown as T
}

/** A trimmed string, or `''`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A finite number, or `undefined`. */
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Clamp into range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Cut to a code-point budget, so a surrogate pair is never split. */
function cut(value: string, max: number): string {
  const points = [...value.trim()]
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

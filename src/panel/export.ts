/**
 * Markdown export.
 *
 * SQLite stays the only storage format, so this is a one-way door by design: a document a person
 * can read, diff and paste, not a second source of truth the plugin might later start reading
 * back. That constraint is why nothing here is round-trippable — no ids in the output, no
 * front-matter contract, no schema version — and why the daily layer exports as prose rather than
 * as the rows it is stored in.
 *
 * Ordering is fixed (identity, global, project, daily) instead of "whatever the query returned",
 * because a handover document whose section order changes between two exports cannot be diffed.
 */

import { MEMORY_SCOPES } from '../constants.js'
import type { MemoryRecord, MemoryRepository, MemoryQuery } from '../storage/repository.js'
import type { MemoryScope } from '../constants.js'

/** What the caller may narrow. */
export interface ExportOptions {
  /** Layers to include. Every layer when omitted. */
  readonly scope?: readonly MemoryScope[]
  /** Include archived and outdated rows. Off by default: an export is usually a handover. */
  readonly includeArchived?: boolean
  /** Restrict the project layer to one project. */
  readonly projectKey?: string | null
  /** Clock injection, for tests. */
  readonly now?: Date
}

/** The finished document. */
export interface ExportDocument {
  readonly markdown: string
  readonly filename: string
  readonly count: number
  readonly bytes: number
}

/** Statuses an export carries when the caller did not ask for everything. */
const LIVE_STATUSES = ['active', 'pending'] as const

/** Section titles, in export order. */
const SCOPE_TITLES: Readonly<Record<MemoryScope, string>> = {
  identity: '身份层 Identity',
  global: '全局记忆 Global',
  project: '项目记忆 Project',
  daily: '每日日志 Daily',
}

/**
 * Render the store as one Markdown document.
 *
 * @param repository - open repository.
 * @param options - layers, statuses and project to include.
 * @returns the document, its filename and its size.
 */
export function exportMarkdown(repository: MemoryRepository, options: ExportOptions = {}): ExportDocument {
  const scopes = options.scope ?? MEMORY_SCOPES
  const statuses = options.includeArchived === true ? undefined : LIVE_STATUSES
  const rows: MemoryRecord[] = []

  for (const scope of scopes) {
    const query: MemoryQuery = {
      scope,
      // The identity layer is a hand-edited file, so its rows are few and always worth exporting;
      // filtering them by status would silently drop a row a user had marked outdated.
      ...(statuses === undefined || scope === 'identity' ? {} : { status: statuses }),
      ...(scope === 'project' && options.projectKey !== undefined ? { projectKey: options.projectKey } : {}),
      limit: 5000,
      orderBy: scope === 'daily' ? 'created' : 'importance',
    }
    rows.push(...repository.list(query))
  }

  const at = options.now ?? new Date()
  const lines: string[] = [
    '# dsh-evermemory 记忆导出',
    '',
    `- 导出时间：${stamp(at)}`,
    `- 条目：${rows.length}`,
    `- 层级：${scopes.join(' / ')}`,
    `- 状态：${statuses === undefined ? '全部' : LIVE_STATUSES.join(' / ')}`,
    '',
  ]

  for (const scope of scopes) {
    const group = rows.filter((row) => row.scope === scope)
    if (group.length === 0) continue
    lines.push(`## ${SCOPE_TITLES[scope]}`, '')
    if (scope === 'project') {
      for (const [key, bucket] of groupByProject(group)) {
        lines.push(`### 项目 ${key}`, '')
        for (const row of bucket) lines.push(...entry(row))
      }
    } else {
      for (const row of group) lines.push(...entry(row))
    }
  }

  const markdown = `${lines.join('\n').trimEnd()}\n`
  return {
    markdown,
    filename: `evermemory-${dayStamp(at)}.md`,
    count: rows.length,
    bytes: Buffer.byteLength(markdown, 'utf8'),
  }
}

/** One entry: heading, metadata line, text, rule. */
function entry(row: MemoryRecord): string[] {
  const meta = [
    `状态 ${row.status}`,
    `重要度 ${String(row.importance)}`,
    row.pinned ? '已固定' : '',
    row.projectKey === null ? '' : `项目 ${row.projectKey}`,
    row.tags.length === 0 ? '' : `标签 ${row.tags.join(', ')}`,
    `来源 ${row.source}${row.sourcePlatform === null ? '' : `/${row.sourcePlatform}`}`,
    `更新 ${row.updatedAt}`,
  ].filter((part) => part !== '')

  return [`### ${row.title}`, '', `- ${meta.join(' · ')}`, '', row.text.trim(), '', '---', '']
}

/** Project rows grouped by key, in first-seen order. */
function groupByProject(rows: readonly MemoryRecord[]): Map<string, MemoryRecord[]> {
  const groups = new Map<string, MemoryRecord[]>()
  for (const row of rows) {
    const key = row.projectKey ?? '(未命名项目)'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }
  return groups
}

/** `2026-05-12 09:41` in local time. */
function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** `2026-05-12` in local time. */
function dayStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

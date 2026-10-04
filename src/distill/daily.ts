/**
 * The daily log — the fourth memory layer, and the only one that is append-only.
 *
 * The other three layers answer "what should the agent know"; this one answers "what happened",
 * which is a different question with a different lifecycle. What happened yesterday is worth
 * keeping verbatim for a while and then worth keeping only as a summary, so the layer has a
 * retention rule (see {@link purgeDaily}) rather than a cap and a merge.
 *
 * Two decisions are load-bearing here:
 *
 * 1. **The unit is a day, and the row is upserted.** One session does not own a day, and a user
 *    who starts three sessions before lunch has had one day. Appending a row per session would
 *    make the layer grow with session count — precisely the "growth with memory volume" that
 *    constraint #1 forbids — and would push the reader through three rows to answer one question.
 * 2. **Nothing here throws.** This runs at a session boundary, after the user has stopped
 *    watching, where a thrown error surfaces as a failed teardown rather than as a failed memory
 *    write. A day that could not be logged is a missing log line, not a broken session.
 */

import { DAILY_LOG_RETENTION_DAYS, type MemoryScope } from '../constants.js'
import type { MemoryRecord, MemoryRepository, NewMemory } from '../storage/repository.js'

/** The scope every row in this module carries. */
const DAILY: MemoryScope = 'daily'

/** Separator between the day's entries. Chosen to survive a Markdown round-trip. */
const ENTRY_SEPARATOR = '\n\n'

/**
 * One thing that happened, in the form it will be stored in.
 *
 * `text` is required and `label` is not, because a log entry without an actor is still a useful
 * record and an entry without content is not.
 */
export interface DailyEntry {
  readonly text: string
  /** Who or what produced it — a tool name, a file, a person. Prefixed in the rendered line. */
  readonly label?: string
}

/** A day's log, in the shape a reader wants rather than the shape a table wants. */
export interface DailyLog {
  readonly date: string
  readonly text: string
  readonly entries: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly status: MemoryRecord['status']
}

/**
 * The calendar day a timestamp belongs to, as `YYYY-MM-DD`.
 *
 * Uses LOCAL time on purpose. A log is read by a person asking "what did I do today", and UTC
 * would file an evening's work under tomorrow for anyone east of Greenwich — including the
 * timezone this project is being written in, where the working day would split across two rows.
 *
 * @param at - the instant to place, defaulting to now.
 */
export function dayKey(at: Date = new Date()): string {
  const year = at.getFullYear()
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The `YYYY-MM-DD` a date is expected to look like, for validating caller input. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/** Whether a string is a well-formed day key. Callers pass dates from routes and pickers. */
export function isDayKey(value: string): boolean {
  return DAY_PATTERN.test(value)
}

/**
 * The day a stored row belongs to.
 *
 * Reads the title, and falls back to parsing `created_at`. The fallback matters because the title
 * is user-editable through the settings panel: a renamed row must not silently change which day
 * it is filed under, and `created_at` is the field that cannot be renamed away.
 */
export function dateOf(record: MemoryRecord): string {
  if (isDayKey(record.title)) return record.title
  const parsed = record.createdAt.slice(0, 10)
  return isDayKey(parsed) ? parsed : 'unknown'
}

/** Renders one entry as a single line: `- [label] text`, or `- text` when unlabelled. */
export function renderEntry(entry: DailyEntry): string {
  const text = entry.text.trim()
  const label = entry.label?.trim()
  return label === undefined || label === '' ? `- ${text}` : `- [${label}] ${text}`
}

/**
 * Splits a stored daily body back into its entries.
 *
 * The inverse of {@link renderEntry}, and deliberately tolerant: an entry may itself contain a
 * blank line if a caller stored one, and a body that was hand-edited through the settings panel
 * may have any shape at all. Returning `[text]` for an unparseable body is better than returning
 * `[]`, because the reader can still see it.
 */
export function parseEntries(text: string): string[] {
  return text
    .split(ENTRY_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * The title a day's row carries.
 *
 * The day key itself, so the panel's list is sorted by date for free and a search for "2026-08"
 * finds that month without a tags table. The `每日日志` prefix is not added: titles are also
 * injected into the resident index, and a prefix repeated on every row is pure overhead.
 */
function titleFor(date: string): string {
  return date
}

/**
 * Appends entries to today's log, creating the day's row on first write.
 *
 * @param repository - the store.
 * @param entries - what to record. Blank entries are dropped; an empty list is a no-op.
 * @param options - the day to file under (defaults to today), the project, and tags.
 * @returns the day's row after the write, or `undefined` if there was nothing to write or the
 *   write failed.
 */
export function appendDaily(
  repository: MemoryRepository,
  entries: readonly DailyEntry[],
  options: {
    readonly date?: string
    readonly projectKey?: string | null
    readonly projectPath?: string | null
    readonly subId?: string | null
    readonly tags?: readonly string[]
  } = {},
): MemoryRecord | undefined {
  const lines = entries
    .map(renderEntry)
    .filter((line) => line !== '- ' && line !== '-')
  if (lines.length === 0) return undefined

  const date = options.date ?? dayKey()
  const projectKey = options.projectKey ?? null

  try {
    return repository.transact(() => {
      const existing = findDay(repository, date, projectKey)
      const body = lines.join(ENTRY_SEPARATOR)

      if (existing === undefined) {
        const input: NewMemory = {
          title: titleFor(date),
          text: body,
          scope: DAILY,
          projectKey,
          projectPath: options.projectPath ?? null,
          subId: options.subId ?? null,
          tags: options.tags ?? ['daily'],
          source: 'auto',
          // Days are not important in the retrieval sense — the relevance ranking is what decides
          // whether a day surfaces. Giving them a high score would let a log entry outrank a rule.
          importance: 2,
        }
        return repository.insert(input)
      }

      const merged = [...parseEntries(existing.text), ...lines].join(ENTRY_SEPARATOR)
      // Reactivated, not merely extended. Appending to a day the retention sweep has archived
      // would otherwise write into a row no reader looks at — the entry would be stored and
      // invisible, which is worse than not storing it, because the confirmation would still say
      // it worked.
      return repository.update(existing.id, {
        text: merged,
        ...(existing.status === 'archived' ? { status: 'active' as const } : {}),
      }) ?? existing
    })
  } catch {
    // A session boundary is the wrong place to raise. See the module comment.
    return undefined
  }
}

/** The day's row in a project, or `undefined`. Internal because callers use the public readers. */
function findDay(
  repository: MemoryRepository,
  date: string,
  projectKey: string | null,
): MemoryRecord | undefined {
  // 'archived' is included deliberately. Retention archives these rows rather than deleting
  // them, so excluding it here would make an archived day — the answer to "what was I doing last
  // month" — indistinguishable from a day that never had a log at all.
  const rows = repository.list({
    scope: DAILY,
    projectKey,
    status: ['active', 'pending', 'archived'],
    limit: 50,
  })
  return rows.find((row) => dateOf(row) === date)
}

/**
 * Reads one day's log.
 *
 * @param repository - the store.
 * @param date - the day key, or a `Date`.
 * @param projectKey - the project, or `null` for entries written without one.
 */
export function readDaily(
  repository: MemoryRepository,
  date: string | Date,
  projectKey: string | null = null,
): DailyLog | undefined {
  const key = typeof date === 'string' ? date : dayKey(date)
  const row = findDay(repository, key, projectKey)
  if (row === undefined) return undefined
  return {
    date: key,
    text: row.text,
    entries: parseEntries(row.text),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
  }
}

/**
 * Lists days with a log, newest first.
 *
 * @param repository - the store.
 * @param options.limit - how many days to return.
 * @param options.projectKey - restrict to one project, or `null` for the unprojected layer.
 * @param options.anyProject - ignore the project filter entirely, for an all-projects view.
 */
export function listDaily(
  repository: MemoryRepository,
  options: { readonly limit?: number; readonly projectKey?: string | null; readonly anyProject?: boolean } = {},
): DailyLog[] {
  const rows = repository.list({
    scope: DAILY,
    status: ['active', 'archived', 'pending'],
    ...(options.anyProject === true ? { anyProject: true } : { projectKey: options.projectKey ?? null }),
    limit: options.limit ?? 60,
  })

  return rows
    .map((row) => ({
      date: dateOf(row),
      text: row.text,
      entries: parseEntries(row.text),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.status,
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

/** What {@link purgeDaily} did. */
export interface PurgeResult {
  readonly archived: number
  readonly dates: readonly string[]
}

/**
 * Retires daily logs older than the retention window.
 *
 * Days are archived rather than deleted: the retention rule exists to bound what the injection
 * path can surface, not to destroy the record, and a user who asks "what was I doing last month"
 * can still be answered from an archived row. Deletion stays a deliberate, manual act.
 *
 * @param repository - the store.
 * @param options.now - the reference instant, so the cutoff is testable without waiting a month.
 * @param options.retentionDays - defaults to the project's fixed 30-day window.
 * @param options.projectKey - restrict to one project.
 */
export function purgeDaily(
  repository: MemoryRepository,
  options: { readonly now?: Date; readonly retentionDays?: number; readonly projectKey?: string | null } = {},
): PurgeResult {
  const retention = options.retentionDays ?? DAILY_LOG_RETENTION_DAYS
  const cutoff = new Date((options.now ?? new Date()).getTime() - retention * 24 * 60 * 60 * 1000)
  const cutoffKey = dayKey(cutoff)

  const rows = repository.list({
    scope: DAILY,
    status: ['active'],
    projectKey: options.projectKey ?? null,
    limit: 1000,
  })

  const stale = rows.filter((row) => dateOf(row) < cutoffKey)
  if (stale.length === 0) return { archived: 0, dates: [] }

  let archived = 0
  const dates: string[] = []
  repository.transact(() => {
    for (const row of stale) {
      if (repository.update(row.id, { status: 'archived' }) !== undefined) {
        archived += 1
        dates.push(dateOf(row))
      }
    }
  })

  return { archived, dates }
}

/**
 * Renders days as the Markdown this layer exports to.
 *
 * Export is the ONLY place Markdown appears in this project — the store is SQLite, and a file is
 * something you hand to a person or another tool, never something you read back as truth.
 */
export function toMarkdown(logs: readonly DailyLog[], heading = 'Daily log'): string {
  const out: string[] = [`# ${heading}`, '']
  for (const log of logs) {
    out.push(`## ${log.date}`, '', log.text, '')
  }
  return out.join('\n').trimEnd() + '\n'
}

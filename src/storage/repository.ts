/**
 * Read/write access to the memory tables.
 *
 * The repository is the only module that writes SQL. Retrieval reads through it, the
 * distillation engine writes through it, and the tools calls it - so a rule about what may
 * enter the store is enforced in one place rather than at every call site.
 */
import type { MemoryScope, MemorySource, MemoryStatus, SourcePlatform } from '../constants.js'
import { MAX_MEMORY_CHARS } from '../constants.js'
import type { SqliteDatabase } from './db.js'
import { transaction } from './db.js'

/** A memory as it exists in the store. */
export interface MemoryRecord {
  readonly id: number
  readonly title: string
  readonly text: string
  readonly scope: MemoryScope
  /** Git-derived identity of the owning project, or `null` for global and identity layers. */
  readonly projectKey: string | null
  /** Human-readable project path at write time, for display only - never used for matching. */
  readonly projectPath: string | null
  /** Worktree discriminator when several checkouts share one project key. */
  readonly subId: string | null
  readonly tags: readonly string[]
  readonly source: MemorySource
  readonly sourcePlatform: SourcePlatform | null
  readonly pinned: boolean
  readonly importance: number
  readonly lastUsedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly status: MemoryStatus
}

/** Fields a caller supplies when creating an entry. */
export interface NewMemory {
  readonly title?: string
  readonly text: string
  readonly scope: MemoryScope
  readonly projectKey?: string | null
  readonly projectPath?: string | null
  readonly subId?: string | null
  readonly tags?: readonly string[]
  readonly source?: MemorySource
  readonly sourcePlatform?: SourcePlatform | null
  readonly pinned?: boolean
  readonly importance?: number
  readonly status?: MemoryStatus
}

/** Fields a caller may change on an existing entry. */
export interface MemoryPatch {
  readonly title?: string
  readonly text?: string
  readonly scope?: MemoryScope
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly importance?: number
  readonly status?: MemoryStatus
  readonly projectKey?: string | null
  readonly projectPath?: string | null
  readonly subId?: string | null
}

/** Filters accepted by {@link MemoryRepository.list} and {@link MemoryRepository.count}. */
export interface MemoryQuery {
  readonly scope?: MemoryScope | readonly MemoryScope[]
  readonly status?: MemoryStatus | readonly MemoryStatus[]
  readonly projectKey?: string | null
  /** `true` matches rows with any project key, which is how the picker lists known projects. */
  readonly anyProject?: boolean
  /** `true` (or `false`) restricts to pinned (or unpinned) rows; omit for either. */
  readonly pinned?: boolean
  readonly tag?: string
  readonly source?: MemorySource
  readonly sourcePlatform?: SourcePlatform
  readonly limit?: number
  readonly offset?: number
  /** `'created'` (newest first) or `'used'` (most recently used first). */
  readonly orderBy?: 'created' | 'used' | 'importance'
}

/**
 * Timestamp expression, in milliseconds.
 *
 * NOT `datetime('now')`, which has one-second resolution. Measured: four entries inserted in
 * a row all recorded `2026-10-03 13:40:40`, and a `touch` immediately afterwards wrote the
 * same value — so `last_used_at` was equal to `created_at`, the eviction sort key collapsed
 * to a single value, and the choice of what to evict became whichever row SQLite happened to
 * visit first. `%f` gives `SS.SSS`, and the format still sorts lexicographically, which is
 * all the ordering relies on.
 */
const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')"

/** Raw row shape, before tags are attached. */
interface MemoryRow {
  id: number
  title: string
  text: string
  scope: string
  project_key: string | null
  project_path: string | null
  sub_id: string | null
  tags: string | null
  source: string
  source_platform: string | null
  pinned: number
  importance: number
  last_used_at: string | null
  created_at: string
  updated_at: string
  status: string
}

/** Columns selected for a record, in the order {@link toRecord} expects them. */
const COLUMNS = `id, title, text, scope, project_key, project_path, sub_id, tags, source,
  source_platform, pinned, importance, last_used_at, created_at, updated_at, status`

/**
 * Map a raw row to a record.
 *
 * The two `tags` sources disagree by design: the `memories.tags` column is a denormalised
 * copy kept for cheap rendering, while the `tags` table is the queryable truth. Reads prefer
 * the table, falling back to the column only when the table has no rows for the entry -
 * which happens for a row written before its tags were split, not for one written here.
 *
 * @param row - raw row from SQLite.
 * @param tableTags - tags read from the `tags` table, already ordered by position.
 * @returns the record.
 */
function toRecord(row: MemoryRow, tableTags: readonly string[]): MemoryRecord {
  const columnTags = row.tags === null || row.tags === '' ? [] : row.tags.split(',')
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    scope: row.scope as MemoryScope,
    projectKey: row.project_key,
    projectPath: row.project_path,
    subId: row.sub_id,
    tags: tableTags.length > 0 ? tableTags : columnTags,
    source: row.source as MemorySource,
    sourcePlatform: row.source_platform as SourcePlatform | null,
    pinned: row.pinned !== 0,
    importance: row.importance,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as MemoryStatus,
  }
}

/**
 * Normalise a tag list for storage.
 *
 * Tags are compared, so they are trimmed, de-duplicated and length-capped here rather than
 * at each call site. Order is preserved because the user's own ordering carries meaning.
 *
 * @param tags - the caller's tags, possibly absent, possibly dirty.
 * @returns a clean list, at most 12 entries.
 */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim().slice(0, 48)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length === 12) break
  }
  return out
}

/**
 * Reject a body that cannot be stored usefully.
 *
 * @param text - candidate body.
 * @returns the trimmed body.
 * @throws RangeError when empty or over {@link MAX_MEMORY_CHARS}.
 */
export function validateText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') throw new RangeError('a memory must have a non-empty body')
  if (trimmed.length > MAX_MEMORY_CHARS) {
    throw new RangeError(`a memory body is limited to ${MAX_MEMORY_CHARS} characters, got ${trimmed.length}`)
  }
  return trimmed
}

/** Memory CRUD. */
export class MemoryRepository {
  readonly #db: SqliteDatabase

  /** @param db - an open, migrated database handle. */
  constructor(db: SqliteDatabase) {
    this.#db = db
  }

  /**
   * Insert one entry, together with its tag rows.
   *
   * @param input - the entry to create.
   * @returns the stored record, including its assigned id.
   */
  insert(input: NewMemory): MemoryRecord {
    return transaction(this.#db, () => {
      const text = validateText(input.text)
      const tags = normalizeTags(input.tags)
      const info = this.#db
        .prepare(
          `INSERT INTO memories (title, text, scope, project_key, project_path, sub_id, tags, source, source_platform, pinned, importance, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW})`,
        )
        .run(
          input.title?.trim() ?? '',
          text,
          input.scope,
          input.projectKey ?? null,
          input.projectPath ?? null,
          input.subId ?? null,
          tags.join(','),
          input.source ?? 'auto',
          input.sourcePlatform ?? null,
          input.pinned === true ? 1 : 0,
          input.importance ?? 0,
          input.status ?? 'active',
        )
      const id = Number(info.lastInsertRowid)
      this.#writeTags(id, tags)
      return this.get(id) as MemoryRecord
    })
  }

  /**
   * Insert many entries in one transaction.
   *
   * Import is the caller that needs this: a partial import is worse than no import, because
   * the user cannot tell which half landed.
   *
   * @param inputs - the entries to create.
   * @returns the stored records, in the order given.
   */
  insertMany(inputs: readonly NewMemory[]): MemoryRecord[] {
    return transaction(this.#db, () => inputs.map((input) => this.insert(input)))
  }

  /**
   * Read one entry.
   *
   * @param id - primary key.
   * @returns the record, or `undefined` when no such row exists.
   */
  get(id: number): MemoryRecord | undefined {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id) as unknown as MemoryRow | undefined
    if (row === undefined) return undefined
    return toRecord(row, this.#tagsOf([id]).get(id) ?? [])
  }

  /**
   * Read several entries by id, preserving the caller's order.
   *
   * @param ids - primary keys.
   * @returns the records that exist, in the order the ids were given.
   */
  getMany(ids: readonly number[]): MemoryRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryRow[]
    const tagMap = this.#tagsOf(rows.map((row) => row.id))
    const byId = new Map(rows.map((row) => [row.id, toRecord(row, tagMap.get(row.id) ?? [])]))
    return ids.map((id) => byId.get(id)).filter((record): record is MemoryRecord => record !== undefined)
  }

  /**
   * List entries matching a filter.
   *
   * @param query - filters and paging.
   * @returns matching records.
   */
  list(query: MemoryQuery = {}): MemoryRecord[] {
    const { where, params } = buildWhere(query)
    const order = ORDER_BY[query.orderBy ?? 'created']
    // SQLite only accepts OFFSET after LIMIT, so an offset without a limit is not
    // expressible and not meaningful either, since it would just mean "skip rows" with no
    // bound on where to stop.
    const paging = query.limit === undefined ? '' : ' LIMIT ? OFFSET ?'
    if (query.limit !== undefined) params.push(query.limit, query.offset ?? 0)
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM memories ${where} ORDER BY ${order}${paging}`)
      .all(...params) as unknown as MemoryRow[]
    const tagMap = this.#tagsOf(rows.map((row) => row.id))
    return rows.map((row) => toRecord(row, tagMap.get(row.id) ?? []))
  }

  /**
   * Count entries matching a filter, ignoring paging.
   *
   * @param query - filters.
   * @returns the number of matching records.
   */
  count(query: MemoryQuery = {}): number {
    const { where, params } = buildWhere(query)
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM memories ${where}`).get(...params) as { n: number }
    return row.n
  }

  /**
   * Apply a partial update.
   *
   * Only the fields present in `patch` are written, so two callers editing different fields
   * cannot clobber each other's work by passing a whole record back.
   *
   * @param id - primary key.
   * @param patch - fields to change.
   * @returns the updated record, or `undefined` when no such row exists.
   */
  update(id: number, patch: MemoryPatch): MemoryRecord | undefined {
    return transaction(this.#db, () => {
      const assignments: string[] = []
      const params: (string | number | null)[] = []

      if (patch.title !== undefined) {
        assignments.push('title = ?')
        params.push(patch.title.trim())
      }
      if (patch.text !== undefined) {
        assignments.push('text = ?')
        params.push(validateText(patch.text))
      }
      if (patch.scope !== undefined) {
        assignments.push('scope = ?')
        params.push(patch.scope)
      }
      if (patch.projectKey !== undefined) {
        assignments.push('project_key = ?')
        params.push(patch.projectKey)
      }
      if (patch.projectPath !== undefined) {
        assignments.push('project_path = ?')
        params.push(patch.projectPath)
      }
      if (patch.subId !== undefined) {
        assignments.push('sub_id = ?')
        params.push(patch.subId)
      }
      if (patch.pinned !== undefined) {
        assignments.push('pinned = ?')
        params.push(patch.pinned ? 1 : 0)
      }
      if (patch.importance !== undefined) {
        assignments.push('importance = ?')
        params.push(patch.importance)
      }
      if (patch.status !== undefined) {
        assignments.push('status = ?')
        params.push(patch.status)
      }
      if (patch.tags !== undefined) {
        const tags = normalizeTags(patch.tags)
        assignments.push('tags = ?')
        params.push(tags.join(','))
        this.#writeTags(id, tags)
      }

      if (assignments.length > 0) {
        assignments.push(`updated_at = ${NOW}`)
        params.push(id)
        this.#db.prepare(`UPDATE memories SET ${assignments.join(', ')} WHERE id = ?`).run(...params)
      }

      return this.get(id)
    })
  }

  /**
   * Mark entries as used, which is what eviction orders by.
   *
   * Batched, and a no-op on an empty list, because it is called from the retrieval path on
   * every step. `at` exists because an import carries the source's own usage times, and a
   * freshly imported entry should not claim to have been read just now — that would make it
   * outrank the user's real entries in every future eviction pass.
   *
   * @param ids - entries that were injected or returned.
   * @param at - explicit timestamp in `YYYY-MM-DD HH:MM:SS.SSS` form; defaults to now.
   * @returns how many rows changed.
   */
  touch(ids: readonly number[], at?: string): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const info =
      at === undefined
        ? this.#db.prepare(`UPDATE memories SET last_used_at = ${NOW} WHERE id IN (${placeholders})`).run(...ids)
        : this.#db
            .prepare(`UPDATE memories SET last_used_at = ? WHERE id IN (${placeholders})`)
            .run(at, ...ids)
    return Number(info.changes)
  }

  /**
   * Delete an entry outright.
   *
   * Deleting is deliberately not the default: forgetting archives. This exists for a user
   * who has asked for the row to be gone, and for cleaning up a store that was built wrong.
   * The `tags` and `import_ledger` rows go with it through the foreign keys.
   *
   * @param id - primary key.
   * @returns `true` when a row was removed.
   */
  remove(id: number): boolean {
    const info = this.#db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(info.changes) > 0
  }

  /**
   * Entries eligible for eviction, worst first.
   *
   * Ordering is `(last_used_at, created_at, importance, id)`. The first key is the real
   * signal: an entry nobody has read is a better eviction candidate than a heavily used one.
   * The rest exist to make the result stable. Without a final tiebreaker, entries that agree
   * on every key come back in whichever order SQLite happened to scan them, so an eviction
   * pass would not be reproducible and neither would a test of it — measured live, before
   * this was fixed, `keep=1` returned `[3, 4]` and `keep=2` returned `[4]`, sets that are not
   * even nested in each other.
   *
   * `pinned` entries are excluded - pinning is the user saying "keep this regardless".
   *
   * @param scope - which layer to evict from.
   * @param projectKey - required when `scope` is `project`.
   * @param keep - how many active entries to retain.
   * @returns ids to archive, worst first.
   */
  evictionCandidates(scope: MemoryScope, projectKey: string | null, keep: number): number[] {
    // The clause and its parameters are built together so they cannot drift apart. An
    // earlier version appended the project placeholder conditionally while always passing
    // the value, which made SQLite count three parameters against two placeholders and fail
    // with "column index out of range" — for every scope, including the global one that has
    // no project clause at all.
    const clauses = ["scope = ?", "status = 'active'", 'pinned = 0']
    const params: (string | number | null)[] = [scope]
    if (scope === 'project') {
      clauses.push('project_key IS ?')
      params.push(projectKey)
    }
    params.push(keep)

    const rows = this.#db
      .prepare(
        `SELECT id FROM memories
         WHERE ${clauses.join(' AND ')}
         ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC, importance DESC, id ASC
         LIMIT -1 OFFSET ?`,
      )
      .all(...params) as unknown as { id: number }[]
    return rows.map((row) => row.id)
  }

  /**
   * Distinct project keys with a human-readable path and entry count.
   *
   * @returns one row per project that has any memory.
   */
  projects(): { projectKey: string; projectPath: string | null; count: number }[] {
    return this.#db
      .prepare(
        `SELECT project_key AS projectKey,
                MAX(project_path) AS projectPath,
                COUNT(*) AS count
         FROM memories
         WHERE project_key IS NOT NULL
         GROUP BY project_key
         ORDER BY count DESC`,
      )
      .all() as { projectKey: string; projectPath: string | null; count: number }[]
  }

  /**
   * Every distinct tag with its usage count.
   *
   * @returns tags ordered by frequency, then alphabetically.
   */
  allTags(): { tag: string; count: number }[] {
    return this.#db
      .prepare('SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag ASC')
      .all() as { tag: string; count: number }[]
  }

  /**
   * Run several repository calls as one atomic unit.
   *
   * Exposed because the merge needs "demote the old entry, then insert the new one" to be
   * all-or-nothing - a crash between the two would retire a memory and store nothing in its
   * place. Keeping the handle private and offering this instead means no caller has a reason
   * to reach for the raw database.
   *
   * @param body - the work to run.
   * @returns whatever `body` returned.
   */
  transact<T>(body: () => T): T {
    return transaction(this.#db, body)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Import ledger
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Record that content with a given hash has been imported.
   *
   * @param hash - content hash of the imported entry.
   * @param memoryId - the entry it produced, when it produced one.
   */
  recordImport(hash: string, memoryId: number | null): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO import_ledger (hash, memory_id) VALUES (?, ?)')
      .run(hash, memoryId)
  }

  /**
   * Test a content hash against the ledger.
   *
   * Only hashes that still point at an entry count as imported. The foreign key is `ON DELETE SET
   * NULL`, so a hash whose entry was deleted falls out here and the material can be imported
   * again — which is the behaviour a user expects after emptying the store. An entry the user
   * merely ARCHIVED still counts, and that is the point of the ledger: re-running an import must
   * never resurrect something they deliberately put away.
   *
   * @param hashes - candidate hashes.
   * @returns the subset already imported and still present.
   */
  knownHashes(hashes: readonly string[]): Set<string> {
    if (hashes.length === 0) return new Set()
    const placeholders = hashes.map(() => '?').join(', ')
    const rows = this.#db
      .prepare(`SELECT hash FROM import_ledger WHERE memory_id IS NOT NULL AND hash IN (${placeholders})`)
      .all(...hashes) as { hash: string }[]
    return new Set(rows.map((row) => row.hash))
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Replace an entry's tag rows.
   *
   * @param memoryId - owning entry.
   * @param tags - already-normalised tags, in display order.
   */
  #writeTags(memoryId: number, tags: readonly string[]): void {
    this.#db.prepare('DELETE FROM tags WHERE memory_id = ?').run(memoryId)
    const insert = this.#db.prepare('INSERT INTO tags (memory_id, tag, position) VALUES (?, ?, ?)')
    tags.forEach((tag, index) => insert.run(memoryId, tag, index))
  }

  /**
   * Read the tag rows for a set of entries in one query.
   *
   * @param ids - entry ids.
   * @returns tags per id, ordered by position.
   */
  #tagsOf(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>()
    if (ids.length === 0) return out
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.#db
      .prepare(`SELECT memory_id, tag FROM tags WHERE memory_id IN (${placeholders}) ORDER BY memory_id, position`)
      .all(...ids) as { memory_id: number; tag: string }[]
    for (const row of rows) {
      const list = out.get(row.memory_id)
      if (list === undefined) out.set(row.memory_id, [row.tag])
      else list.push(row.tag)
    }
    return out
  }
}

/** Sort orders, kept as whole strings so nothing user-supplied can reach the SQL text. */
const ORDER_BY: Record<NonNullable<MemoryQuery['orderBy']>, string> = {
  created: 'created_at DESC, id DESC',
  used: 'COALESCE(last_used_at, created_at) DESC, id DESC',
  importance: 'importance DESC, created_at DESC, id DESC',
}

/**
 * Turn a query into a `WHERE` clause and its bound parameters.
 *
 * Values are always bound, never interpolated, and array-valued filters expand to a
 * generated run of placeholders. This is the reason a tag from an imported file cannot
 * change the shape of a statement.
 *
 * @param query - filters.
 * @returns the clause (empty string when unfiltered) and the parameter list.
 */
function buildWhere(query: MemoryQuery): { where: string; params: (string | number | null)[] } {
  const clauses: string[] = []
  const params: (string | number | null)[] = []

  const addIn = (column: string, value: string | readonly string[]): void => {
    const values = typeof value === 'string' ? [value] : value
    if (values.length === 0) return
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`)
    params.push(...values)
  }

  if (query.scope !== undefined) addIn('scope', query.scope)
  if (query.status !== undefined) addIn('status', query.status)
  if (query.source !== undefined) addIn('source', query.source)
  if (query.sourcePlatform !== undefined) addIn('source_platform', query.sourcePlatform)
  if (query.anyProject === true) clauses.push('project_key IS NOT NULL')
  else if (query.projectKey !== undefined) {
    // `IS` rather than `=` so that a `null` project key matches the global rows, which is
    // what "the entries with no project" has to mean.
    clauses.push('project_key IS ?')
    params.push(query.projectKey)
  }
  // `undefined` means "either"; `false` must stay expressible, so this cannot be a truthiness
  // test — the injection path asks for pinned rows and the panel asks for the unpinned ones.
  if (query.pinned !== undefined) clauses.push(`pinned = ${query.pinned ? 1 : 0}`)
  if (query.tag !== undefined) {
    clauses.push('id IN (SELECT memory_id FROM tags WHERE tag = ?)')
    params.push(query.tag)
  }

  return { where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params }
}

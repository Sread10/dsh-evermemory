/**
 * Database handle.
 *
 * `node:sqlite` is imported through a dynamic `import()` rather than a static one, and that
 * is a load-bearing choice rather than a stylistic one. It is an experimental Node module:
 * where it is unavailable, a static import makes the whole plugin fail to load, and a failed
 * plugin takes its host's plugin tree down with it. Reaching for it lazily means the failure
 * lands on the one feature that needs a database — memory — while behavioural rules, which
 * need no storage at all, keep working.
 *
 * The corresponding decision is in `src/index.ts`: nothing here is imported until the
 * memory preference is on, so a user who only wants rules never loads this file.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { SCHEMA_VERSION, migrate } from './schema.js'
import { databasePath } from './paths.js'

/** Structural type for the handle, so this module does not depend on the module's types. */
export type SqliteDatabase = import('node:sqlite').DatabaseSync

/** Raised when the store cannot be opened, with a message safe to show a user. */
export class StorageUnavailableError extends Error {
  override readonly name = 'StorageUnavailableError'

  /**
   * @param message - what went wrong, in terms a user can act on.
   * @param cause - the underlying error, kept for logs.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

/**
 * Load `node:sqlite` or explain why it is missing.
 *
 * @returns the module namespace.
 * @throws StorageUnavailableError when the runtime does not provide `node:sqlite`.
 */
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  try {
    return await import('node:sqlite')
  } catch (error) {
    throw new StorageUnavailableError(
      'this Node runtime has no built-in node:sqlite module, so dsh-evermemory cannot open its memory database',
      error,
    )
  }
}

/** An open store plus the metadata worth reporting back to the caller. */
export interface OpenStore {
  readonly db: SqliteDatabase
  /** Absolute path of the file that was opened, or `:memory:`. */
  readonly path: string
  /** Schema versions this call applied. Empty when the database was already current. */
  readonly migrated: number[]
  /** Schema version after opening. */
  readonly version: number
}

/** Options for {@link openStore}. */
export interface OpenStoreOptions {
  /** Absolute database path, or `:memory:` for an ephemeral store. */
  readonly path?: string
  /** Override for the DSH home directory, used to derive the default path. */
  readonly dshHome?: string
}

/**
 * Open the memory database, creating and migrating it as needed.
 *
 * @param options - path overrides; the defaults point at the real store.
 * @returns the open store.
 * @throws StorageUnavailableError when the module is missing or the file cannot be opened.
 */
export async function openStore(options: OpenStoreOptions = {}): Promise<OpenStore> {
  const sqlite = await loadSqlite()
  const path = options.path ?? databasePath(options.dshHome)

  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch (error) {
      throw new StorageUnavailableError(`cannot create the memory directory for ${path}`, error)
    }
  }

  let db: SqliteDatabase
  try {
    db = new sqlite.DatabaseSync(path, {
      // SQLite defaults foreign keys OFF. The schema's `tags.memory_id REFERENCES
      // memories(id) ON DELETE CASCADE` therefore does nothing at all unless this is set —
      // verified by deleting a parent row and finding the child rows still present. Passing
      // it here rather than relying on a `PRAGMA` keeps the guarantee attached to the
      // connection instead of to someone remembering to run a statement.
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    })
  } catch (error) {
    throw new StorageUnavailableError(`cannot open the memory database at ${path}`, error)
  }

  try {
    // WAL keeps a reader from blocking the writer, which matters because a tool call can
    // read while the distillation pass at turn end is writing.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const migrated = migrate(db)
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    return { db, path, migrated, version: Number(row?.user_version ?? SCHEMA_VERSION) }
  } catch (error) {
    db.close()
    throw new StorageUnavailableError(`cannot migrate the memory database at ${path}`, error)
  }
}

/**
 * Execute a statement, checking the parameter count first.
 *
 * This exists because `node:sqlite` reports a parameter-count mismatch as
 * `datatype mismatch` — the SAME error it gives for binding a bigint into a TEXT column. A
 * query with six placeholders and four values therefore reads as a type problem and sends the
 * reader looking at column definitions, which is exactly what happened while building the
 * retriever. Counting first turns that into a message that names the actual mistake.
 *
 * @param db - the open handle.
 * @param sql - statement text.
 * @param params - values, in placeholder order.
 * @returns the rows.
 */
export function runAll(
  db: SqliteDatabase,
  sql: string,
  params: readonly unknown[],
): unknown[] {
  const placeholders = countPlaceholders(sql)
  if (placeholders !== params.length) {
    throw new Error(
      `SQL parameter count mismatch: ${placeholders} placeholder(s) for ${params.length} value(s). ` +
        'SQLite reports this as "datatype mismatch", which names neither the query nor the argument.',
    )
  }
  return db.prepare(sql).all(...(params as never[])) as unknown[]
}

/** Number of `?` placeholders outside of string literals. */
function countPlaceholders(sql: string): number {
  let count = 0
  let inLiteral = false
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    if (character === "'") {
      // A doubled quote inside a literal is an escaped quote, not the end of the literal.
      if (inLiteral && sql[index + 1] === "'") index += 1
      else inLiteral = !inLiteral
    } else if (character === '?' && !inLiteral) {
      count += 1
    }
  }
  return count
}

export function transaction<T>(db: SqliteDatabase, body: () => T): T {
  const depth = OPEN_TRANSACTIONS.get(db) ?? 0
  const savepoint = `evermemory_sp_${depth}`
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
  OPEN_TRANSACTIONS.set(db, depth + 1)

  let result: T
  try {
    result = body()
  } catch (error) {
    if (depth === 0) db.exec('ROLLBACK')
    else db.exec(`ROLLBACK TO ${savepoint}`)
    throw error
  } finally {
    // The depth is restored before the commit so that a throwing COMMIT cannot leave the
    // counter claiming a transaction that no longer exists.
    if (depth === 0) OPEN_TRANSACTIONS.delete(db)
    else OPEN_TRANSACTIONS.set(db, depth)
  }

  if (depth > 0) db.exec(`RELEASE ${savepoint}`)
  else db.exec('COMMIT')
  return result
}

/**
 * Transaction depth per handle.
 *
 * A `WeakMap` rather than a counter so that a leaked handle cannot pin an entry, and keyed
 * by handle rather than global so two stores — the real one and a test's — stay independent.
 */
const OPEN_TRANSACTIONS = new WeakMap<SqliteDatabase, number>()

/**
 * Lazy handle on the memory store, shared by every consumer in the plugin.
 *
 * Opening the database is asynchronous, and the plugin's `apply()` is not. Rather than block the
 * mount on a disk operation — which would stall the whole plugin tree on a slow or unreachable
 * path — the store is opened on first use and the promise is cached, so concurrent callers share
 * one open rather than racing to create two connections to the same file.
 *
 * A failure is remembered. Retrying on every call would mean a `statSync`-and-throw on the hot
 * path of every step, and the reason a store cannot be opened (no `node:sqlite`, a read-only home
 * directory) does not fix itself mid-session. The remembered error is re-thrown so the caller can
 * report it; `status()` exists so the panel can show it without triggering a retry.
 */

import { openStore } from './db.js'
import type { OpenStore, SqliteDatabase } from './db.js'
import { StorageUnavailableError } from './db.js'
import { MemoryRepository } from './repository.js'
import { resolveDshHome } from './paths.js'

/** Where the store is in its lifecycle. */
export type StoreStatus = 'idle' | 'opening' | 'ready' | 'failed'

/**
 * One process-wide store handle.
 *
 * A single instance is created per plugin mount and passed to everything that needs storage. Two
 * handles on the same file would be two connections, two WAL writers and two migration runs, and
 * `node:sqlite` would serialise them the hard way.
 */
export class StoreHandle {
  #open: Promise<OpenStore> | undefined
  #store: OpenStore | undefined
  #repository: MemoryRepository | undefined
  #status: StoreStatus = 'idle'
  #failure: unknown
  #path: string | undefined

  constructor(private readonly home: string | undefined = undefined) {}

  /** Current state, without triggering a load. */
  get status(): StoreStatus {
    return this.#status
  }

  /** The file that was opened, once known. */
  get path(): string | undefined {
    return this.#path
  }

  /** The remembered failure, if any. */
  get failure(): unknown {
    return this.#failure
  }

  /** The DSH home the path is derived from, resolved once at construction. */
  get dshHome(): string {
    return this.home ?? resolveDshHome()
  }

  /**
   * Open the store if needed and return it.
   *
   * @returns the open store.
   * @throws StorageUnavailableError or the underlying SQLite error, both remembered.
   */
  async open(): Promise<OpenStore> {
    if (this.#open !== undefined) return this.#open
    if (this.#status === 'failed') {
      // Remembered, not retried. The reasons a store cannot be opened — no `node:sqlite`, a
      // read-only home directory — do not fix themselves mid-session, and retrying would put a
      // throwing filesystem call on the hot path of every step.
      throw this.#failure
    }
    this.#status = 'opening'
    const pending = openStore(
      this.home === undefined ? {} : { dshHome: this.home },
    ).then(
      (store) => {
        this.#status = 'ready'
        this.#path = store.path
        this.#store = store
        return store
      },
      (error: unknown) => {
        this.#status = 'failed'
        this.#failure = error
        // Drop the rejected promise so a later `open()` reports the remembered failure instead of
        // handing back the same rejection object.
        this.#open = undefined
        throw error
      },
    )
    this.#open = pending
    return pending
  }

  /**
   * The repository, opening the store if needed.
   *
   * Asynchronous only because the first open is. Every write path in the plugin is asynchronous,
   * which is why this is enough; a synchronous reader checks `status` instead and injects nothing
   * while the store is not ready.
   */
  async repository(): Promise<MemoryRepository> {
    if (this.#repository !== undefined) return this.#repository
    const store = await this.open()
    this.#repository ??= new MemoryRepository(store.db)
    return this.#repository
  }

  /** The repository, or `undefined` when the store is not open. Never opens. */
  get repositoryIfReady(): MemoryRepository | undefined {
    return this.#repository
  }

  /** The database handle, or `undefined` when the store is not open. Never opens. */
  get dbIfReady(): SqliteDatabase | undefined {
    return this.#store?.db
  }

  /**
   * The one-line reason the store is unusable, for a panel or a tool result.
   *
   * Written for a user, not a log: it says which file and what to do about it.
   */
  describeFailure(): string {
    if (this.#status !== 'failed') return ''
    if (this.#failure instanceof StorageUnavailableError) return this.#failure.message
    const detail = this.#failure instanceof Error ? this.#failure.message : String(this.#failure)
    return `记忆数据库无法打开：${detail}`
  }

  /**
   * Set the repository directly.
   *
   * For tests that drive the injection path against a temporary database. Not used by the host.
   */
  adopt(repository: MemoryRepository, store?: OpenStore): void {
    this.#repository = repository
    this.#store = store
    this.#status = 'ready'
    this.#path = store?.path ?? ':memory:'
  }

  /** Close the store. Idempotent, and safe to call before the store ever opened. */
  async close(): Promise<void> {
    const store = this.#store
    const pending = this.#open
    this.#open = undefined
    this.#store = undefined
    this.#repository = undefined
    this.#status = 'idle'
    if (store !== undefined) {
      try {
        store.db.close()
      } catch {
        // Nothing actionable, and nowhere to report it during teardown.
      }
      return
    }
    if (pending === undefined) return
    try {
      const opened = await pending
      opened.db.close()
    } catch {
      // A store that failed to open needs no closing.
    }
  }
}

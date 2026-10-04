/**
 * The retrieval entry point.
 *
 * One method, three steps, and the steps are separated because each has a different failure
 * mode. FTS is precise and ranked but blind below three characters; `LIKE` sees everything and
 * can rank nothing; and the score decides order. Fusing them here rather than inside a
 * tokenizer keeps the blind spot in one place instead of spread across a query builder.
 *
 * Both match paths are always run when they apply, rather than falling back only when the
 * first returns nothing. A query like `pnpm 缓存` has one fragment above the trigram floor and
 * one below, and that below-floor fragment is exactly the disambiguating term — dropping it
 * because the other fragment matched would answer a different question than the one asked.
 */
import type { MemoryRecord, MemoryRepository } from '../storage/repository.js'
import type { SqliteDatabase } from '../storage/db.js'
import { runAll } from '../storage/db.js'
import type { MemoryScope } from '../constants.js'
import { buildAllQuery, buildAnyQuery } from './fts.js'
import { buildAllCondition, escapeLike, LIKE_ESCAPE } from './like.js'
import type { MatchKind, RankWeights, RankedMemory } from './rank.js'
import { DEFAULT_WEIGHTS, relevanceFromRank, scoreMemory, sortRanked } from './rank.js'
import type { QueryFragment } from './tokenize.js'
import { ftsFragments, likeFragments, tokenize } from './tokenize.js'

/** A retrieved memory plus the reason it ranked where it did. */
export interface RetrievedMemory extends RankedMemory {
  /** The memory itself, hoisted for call-site convenience. */
  readonly memory: MemoryRecord
}

/** What to search for, and how much to return. */
export interface RetrieveOptions {
  /** Raw user text. Tokenised here, so callers pass what the user wrote. */
  readonly query: string
  /** Project identity to include the project layer for. `null` searches global layers only. */
  readonly projectKey?: string | null
  /** Layers to search. Accepted for symmetry with the repository; the SQL filters by `scope`. */
  readonly scopes?: readonly MemoryScope[]
  /** Maximum returned, after ranking. Defaults to {@link DEFAULT_LIMIT}. */
  readonly limit?: number
  /** Overrides for {@link DEFAULT_WEIGHTS}. */
  readonly weights?: RankWeights
  /** Reference time for the recency term, injected so tests do not read the clock. */
  readonly now?: Date
}

/** Results per search when the caller does not say. */
export const DEFAULT_LIMIT = 10

/** Candidates pulled from each match path before ranking, scaled by the requested limit. */
const CANDIDATE_FACTOR = 4

/** Ceiling on candidates from one path, so a broad query cannot pull in the whole store. */
const MAX_CANDIDATES = 200

/** Boost applied to a row both paths found, capped at a relevance of 1. */
const AGREEMENT_BOOST = 1.25

/** One row from a match path, before scoring. */
interface Candidate {
  readonly id: number
  /** FTS rank, absent when the row was found by `LIKE` alone. */
  readonly rank: number | undefined
  /** How many below-floor fragments the row satisfied. */
  readonly matched: number
}

/**
 * Search the memory store.
 *
 * Synchronous by design, matching `node:sqlite`: there is no I/O to await, and an `async`
 * signature would only invite the caller to believe a call is cheap enough to issue per token.
 */
export class Retriever {
  readonly #db: SqliteDatabase
  readonly #repository: MemoryRepository
  /** The FTS statement is prepared once; this runs on every step of every turn. */
  readonly #ftsStatement: ReturnType<SqliteDatabase['prepare']>

  /**
   * @param db - an open database handle.
   * @param repository - the repository over the same handle.
   */
  constructor(db: SqliteDatabase, repository: MemoryRepository) {
    this.#db = db
    this.#repository = repository
    // Two project-keyed layers, one filter. The daily layer is keyed by project exactly as the
    // project layer is (`appendDaily` files a day under the session's project), so treating it as
    // global here would inject one project's journal into another project's session — the leak
    // constraint #4 exists to prevent, arriving through the one layer nobody thinks of as
    // project-scoped. `IS` rather than `=` because the key is legitimately NULL.
    this.#ftsStatement = db.prepare(
      `SELECT memories_fts.rowid AS id, rank AS rank
         FROM memories_fts
         JOIN memories ON memories.id = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND memories.status = 'active'
          AND (memories.scope NOT IN ('project', 'daily') OR memories.project_key IS ?)
        ORDER BY rank
        LIMIT ?`,
    )
  }

  /**
   * Run a search.
   *
   * @param options - see {@link RetrieveOptions}.
   * @returns the best matches, ranked, most relevant first.
   */
  retrieve(options: RetrieveOptions): RetrievedMemory[] {
    const fragments = tokenize(options.query)
    if (fragments.length === 0) return []

    const long = ftsFragments(fragments)
    const short = likeFragments(fragments)
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
    const candidates = Math.min(MAX_CANDIDATES, limit * CANDIDATE_FACTOR)
    const projectKey = options.projectKey ?? null

    const byId = new Map<number, Candidate>()
    for (const hit of this.#searchFts(long, projectKey, candidates)) byId.set(hit.id, hit)
    for (const hit of this.#searchLike(short, projectKey, candidates)) {
      const existing = byId.get(hit.id)
      byId.set(hit.id, existing === undefined
        ? hit
        : { id: hit.id, rank: existing.rank, matched: existing.matched + hit.matched })
    }
    if (byId.size === 0) return []

    const records = new Map(this.#repository.getMany([...byId.keys()]).map((record) => [record.id, record]))
    const now = options.now ?? new Date()
    const weights = options.weights ?? DEFAULT_WEIGHTS
    const scored: RetrievedMemory[] = []

    for (const candidate of byId.values()) {
      const record = records.get(candidate.id)
      if (record === undefined) continue
      // `matched` counts below-floor fragments only, so it is zero for a pure FTS hit and
      // therefore already expresses "did the LIKE path also find this".
      const both = candidate.rank !== undefined && candidate.matched > 0
      const match: MatchKind = both ? 'both' : candidate.rank !== undefined ? 'fts' : 'like'
      const base = candidate.rank !== undefined
        ? relevanceFromRank(candidate.rank)
        : candidate.matched / Math.max(1, fragments.length)
      const relevance = Math.min(1, base * (both ? AGREEMENT_BOOST : 1))
      scored.push({ ...scoreMemory(record, relevance, match, now, weights), memory: record })
    }

    return sortRanked(scored).slice(0, limit)
  }

  /**
   * Query the FTS index, retrying with `OR` when the implicit `AND` finds nothing.
   *
   * The retry is not a heuristic. A multi-term `AND` that matches nothing is indistinguishable
   * from a store that has never heard of the subject, and the two call for opposite responses:
   * one should report "I know nothing about this", the other should list what it does have.
   *
   * @param fragments - fragments above the trigram floor.
   * @param projectKey - project identity to include, or `null`.
   * @param limit - candidate ceiling.
   * @returns hits in rank order.
   */
  #searchFts(fragments: readonly QueryFragment[], projectKey: string | null, limit: number): Candidate[] {
    const all = buildAllQuery(fragments)
    if (all === undefined) return []
    const rows = this.#runFts(all.match, projectKey, limit)
    if (rows.length > 0) return rows
    const any = buildAnyQuery(fragments)
    return any === undefined ? [] : this.#runFts(any.match, projectKey, limit)
  }

  /**
   * Execute one FTS query.
   *
   * @param match - the argument built by `fts.ts`.
   * @param projectKey - project identity to include, or `null`.
   * @param limit - candidate ceiling.
   * @returns hits in rank order.
   */
  #runFts(match: string, projectKey: string | null, limit: number): Candidate[] {
    const rows = this.#ftsStatement.all(match, projectKey, limit) as { id: number, rank: number }[]
    return rows.map((row) => ({ id: row.id, rank: row.rank, matched: 0 }))
  }

  /**
   * Query with `LIKE`, for fragments below the trigram floor.
   *
   * `matched` counts how many fragments the row satisfied, because there is no rank to use and
   * a row matching three of four short terms is a better answer than one matching one. The
   * count reuses the match condition itself, so the escape rules live only in `like.ts`.
   *
   * @param fragments - fragments below the trigram floor.
   * @param projectKey - project identity to include, or `null`.
   * @param limit - candidate ceiling.
   * @returns hits, most fragments matched first.
   */
  #searchLike(fragments: readonly QueryFragment[], projectKey: string | null, limit: number): Candidate[] {
    const built = buildAllCondition(fragments)
    if (built === undefined) return []

    // One pattern pair per fragment for the score, which must be bound in the same order as
    // the score expression's placeholders. `escapeLike` is the single definition of what has
    // to be escaped, shared with the condition builder.
    const scoreParams = fragments.flatMap((fragment) => {
      const pattern = `%${escapeLike(fragment.text)}%`
      return [pattern, pattern]
    })

    // The score is built from `like.ts`'s own escaping rather than by splicing the condition
    // text in. Splicing looks tidier and is wrong: the condition's placeholders would then
    // appear twice in the statement while its values appeared once, and `node:sqlite` reports
    // that mismatch as "datatype mismatch" — a message that points at column types and cost
    // more time to find than this comment costs to read.
    const score = fragments
      .map(() => `CASE WHEN (text LIKE ? ESCAPE '${LIKE_ESCAPE}' OR title LIKE ? ESCAPE '${LIKE_ESCAPE}') THEN 1 ELSE 0 END`)
      .join(' + ')
    const sql = `SELECT id, (${score}) AS matched
                   FROM memories
                  WHERE status = 'active'
                    AND (scope NOT IN ('project', 'daily') OR project_key IS ?)
                    AND ${built.condition}
                  ORDER BY matched DESC, COALESCE(last_used_at, created_at) DESC, id ASC
                  LIMIT ?`

    const rows = runAll(this.#db, sql, [...scoreParams, projectKey, ...built.params, limit]) as
      { id: number, matched: number }[]
    return rows.map((row) => ({ id: row.id, rank: undefined, matched: row.matched }))
  }
}

/** Re-exported so a caller building an export pattern uses the same escaping as retrieval. */
export { escapeLike }

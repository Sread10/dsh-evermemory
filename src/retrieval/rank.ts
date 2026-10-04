/**
 * Ranking retrieved memories.
 *
 * Relevance alone is not the right order here. A memory store is consulted at least as often
 * to answer "what did we agree about this" as to answer "does this word appear anywhere", and
 * a project convention recorded yesterday matters more than an unrelated note that happens to
 * share a term. So the score is a weighted sum of three signals, each normalised to `[0, 1]`:
 *
 * - **relevance**, from the FTS rank or the number of short fragments matched;
 * - **recency**, from `last_used_at` falling back to `created_at`, on a half-life so the
 *   signal actually decays rather than becoming a second copy of "newest first";
 * - **importance**, the explicit signal a user or the distillation engine sets.
 *
 * The weights are exported so the settings panel can show what they are and a test can pin
 * them. Relevance dominates, because a recency-weighted search that returns the wrong memory
 * promptly is worse than one that returns the right memory without hurry.
 */
import type { MemoryRecord } from '../storage/repository.js'

/** Relative contribution of each signal. */
export interface RankWeights {
  readonly relevance: number
  readonly recency: number
  readonly importance: number
}

/** Defaults: relevance dominates, recency breaks ties, importance nudges. */
export const DEFAULT_WEIGHTS: RankWeights = { relevance: 0.6, recency: 0.25, importance: 0.15 }

/** Days after which the recency contribution halves. */
export const RECENCY_HALF_LIFE_DAYS = 14

/** Where a score came from, for the result's `why` field. */
export type MatchKind = 'fts' | 'like' | 'both'

/** A scored memory. */
export interface RankedMemory {
  readonly record: MemoryRecord
  /** Combined score, higher is better. */
  readonly score: number
  /** The relevance component alone, which is what a caller filtering on "is this relevant" wants. */
  readonly relevance: number
  readonly match: MatchKind
}

/**
 * Map a negative `bm25`-style rank onto `[0, 1]`, higher is better.
 *
 * FTS5's `rank` is negative and unbounded, with more negative meaning a better match. The
 * logistic here keeps the ordering exactly while making the value comparable to the other two
 * signals; an unbounded value added to two bounded ones would make the weights meaningless.
 *
 * @param rank - the value FTS5 returned, or `undefined` when the row did not match FTS.
 * @returns a score in `[0, 1]`.
 */
export function relevanceFromRank(rank: number | undefined): number {
  if (rank === undefined || !Number.isFinite(rank)) return 0
  return 1 / (1 + Math.exp(rank))
}

/**
 * Recency score for a timestamp, in `[0, 1]`.
 *
 * @param timestamp - `YYYY-MM-DD HH:MM:SS.SSS` in UTC, as the repository writes it.
 * @param now - reference time, injected so a test does not depend on the clock.
 * @returns `1` for the reference instant, halving every {@link RECENCY_HALF_LIFE_DAYS}.
 */
export function recencyScore(timestamp: string | null, now: Date): number {
  if (timestamp === null || timestamp.length === 0) return 0
  // SQLite writes UTC in a space-separated form; `Date.parse` needs the `T` and the `Z` to
  // read it as UTC rather than as local time, which would shift every score by the offset.
  const parsed = Date.parse(`${timestamp.replace(' ', 'T')}Z`)
  if (!Number.isFinite(parsed)) return 0
  const ageDays = Math.max(0, (now.getTime() - parsed) / 86_400_000)
  return 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS)
}

/**
 * Combine the three signals for one candidate.
 *
 * @param record - the candidate.
 * @param relevance - normalised relevance from the retriever.
 * @param match - where the relevance came from.
 * @param now - reference time for the recency term.
 * @param weights - overrides for {@link DEFAULT_WEIGHTS}.
 * @returns the scored memory.
 */
export function scoreMemory(
  record: MemoryRecord,
  relevance: number,
  match: MatchKind,
  now: Date,
  weights: RankWeights = DEFAULT_WEIGHTS,
): RankedMemory {
  const used = record.lastUsedAt ?? record.createdAt
  const recency = recencyScore(used, now)
  // `importance` is an open-ended integer; the schema default is 0 and the distillation
  // engine writes small values, so 10 is a full-marks memory rather than an arbitrary cap.
  const importance = Math.min(1, Math.max(0, record.importance) / 10)
  const score =
    weights.relevance * relevance +
    weights.recency * recency +
    weights.importance * importance
  return { record, score, relevance, match }
}

/**
 * Sort scored memories by score, then by recency, then by id.
 *
 * The trailing keys make the order total, so an identical store produces an identical list
 * and a test can assert it. Without them two equally scored rows come back in whatever order
 * SQLite happened to visit them, which is stable in practice and not guaranteed.
 *
 * Generic over the element so a caller's richer result type survives the sort, rather than
 * being flattened to the base shape and needing a cast back.
 *
 * @param memories - scored memories.
 * @returns a new array in descending rank order.
 */
export function sortRanked<T extends RankedMemory>(memories: readonly T[]): T[] {
  return [...memories].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftUsed = left.record.lastUsedAt ?? left.record.createdAt
    const rightUsed = right.record.lastUsedAt ?? right.record.createdAt
    if (rightUsed !== leftUsed) return rightUsed < leftUsed ? -1 : 1
    return left.record.id - right.record.id
  })
}

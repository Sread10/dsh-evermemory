/**
 * The four-state merge.
 *
 * NEW / MERGE / UPDATE / IGNORE, decided from the candidate text and the entries already in
 * the store, with no model in the loop. The whole difficulty is that "the same memory, said
 * again" and "a new memory about the same thing" look alike, and getting it wrong is
 * expensive in opposite directions: too eager and the store fills with restatements that
 * each cost prompt budget, too shy and the user's correction never lands.
 */
import type { MergeDecision, MemoryScope } from '../constants.js'
import type { MemoryRecord, MemoryRepository, NewMemory } from './repository.js'
import { contradict, containment, normalizeForCompare, similarity } from './similarity.js'

/**
 * Similarity at or above which a candidate is treated as restating an existing entry.
 *
 * Measured against the fixtures in `tests/merge.test.ts` rather than chosen from intuition:
 * a restatement with a word changed scores around 0.6–0.85, while two genuinely different
 * statements that merely share a topic score below 0.3.
 */
export const MERGE_SIMILARITY = 0.42

/**
 * Containment at or above which a SHORTER candidate counts as already present.
 *
 * Set high because containment is one-directional and therefore generous: it exists for
 * "the same fact, said more briefly", not for "a related fact".
 */
export const CONTAINMENT_THRESHOLD = 0.85

/** A candidate handed to the merge for classification. */
export interface MergeCandidate {
  readonly title?: string
  readonly text: string
  readonly scope: MemoryScope
  readonly projectKey?: string | null
  readonly tags?: readonly string[]
  readonly source?: NewMemory['source']
}

/** What the merge decided, and the evidence for it. */
export interface MergePlan {
  readonly decision: MergeDecision
  /** The entry the decision concerns, when it concerns one. */
  readonly target?: MemoryRecord
  /** Similarity score behind the decision, for the audit log and for tests. */
  readonly score: number
  /** Why, in a sentence a user can read. */
  readonly reason: string
  /**
   * An entry this candidate appears to contradict.
   *
   * Present means the caller must ASK. The merge never resolves a conflict on its own: it
   * cannot know which of the two the user currently believes, and guessing wrong makes the
   * agent confidently repeat a retired instruction.
   */
  readonly conflict?: MemoryRecord
}

/**
 * Find the closest existing entry to a candidate.
 *
 * Only `active` entries in the same scope compete. A `pending` import is not yet the user's
 * belief, an `archived` entry has been superseded, and an entry in another scope is a
 * different kind of statement about the same words.
 *
 * @param repository - open repository.
 * @param candidate - the text being considered.
 * @param pool - entries to compare against; fetched by the caller so one pass can be reused.
 * @returns the best match and its score, or `undefined` when the pool is empty.
 */
function bestMatch(
  candidate: MergeCandidate,
  pool: readonly MemoryRecord[],
): { record: MemoryRecord; score: number } | undefined {
  let best: { record: MemoryRecord; score: number } | undefined
  for (const record of pool) {
    if (record.scope !== candidate.scope) continue
    if (candidate.scope === 'project' && record.projectKey !== (candidate.projectKey ?? null)) continue
    // The title carries meaning too, so it is compared as part of the text rather than
    // ignored: "PNPM" as a title against a body about npm is a different memory.
    const score =
      candidate.title === undefined || candidate.title === ''
        ? similarity(candidate.text, record.text)
        : Math.max(similarity(candidate.text, record.text), similarity(`${candidate.title} ${candidate.text}`, `${record.title} ${record.text}`))
    if (best === undefined || score > best.score) best = { record, score }
  }
  return best
}

/**
 * Classify a candidate without writing anything.
 *
 * Separated from applying the plan so that the import preview can present exactly what would
 * happen — the same code path decides, so the preview cannot drift from the outcome.
 *
 * @param repository - open repository.
 * @param candidate - the text being considered.
 * @param options - `pool` reuses an already-fetched comparison set across a batch.
 * @returns the plan.
 */
export function planMerge(
  repository: MemoryRepository,
  candidate: MergeCandidate,
  options: { readonly pool?: readonly MemoryRecord[] } = {},
): MergePlan {
  const pool =
    options.pool ??
    repository.list({
      scope: candidate.scope,
      status: 'active',
      ...(candidate.scope === 'project' ? { projectKey: candidate.projectKey ?? null } : {}),
    })

  const normalized = normalizeForCompare(candidate.text)
  const exact = pool.find((record) => normalizeForCompare(record.text) === normalized)
  if (exact !== undefined) {
    return {
      decision: 'ignore',
      target: exact,
      score: 1,
      reason: `identical to memory #${exact.id}`,
    }
  }

  const match = bestMatch(candidate, pool)
  if (match === undefined) {
    return { decision: 'new', score: 0, reason: 'no comparable entry in this scope' }
  }

  // A contradiction is looked for FIRST, before the similarity thresholds, because the two
  // tests disagree in exactly the case that matters. A correction usually restates its
  // subject almost word for word — "这个项目用 pnpm" corrected to "这个项目不要用 pnpm" scores
  // 0.5 similarity — so a similarity-first rule classifies the correction as a restatement
  // and merges the new belief into the old one, leaving the superseded instruction in place
  // and phrased as though it still held.
  const conflict = pool.find((record) => contradict(candidate.text, record.text))

  if (conflict !== undefined) {
    return {
      decision: 'update',
      target: conflict,
      score: match.score,
      reason: `appears to revise memory #${conflict.id}`,
      conflict,
    }
  }

  if (match.score >= MERGE_SIMILARITY) {
    const relation = containment(candidate.text, match.record.text)
    return {
      decision: relation >= CONTAINMENT_THRESHOLD && candidate.text.length < match.record.text.length ? 'ignore' : 'merge',
      target: match.record,
      score: match.score,
      reason:
        relation >= CONTAINMENT_THRESHOLD && candidate.text.length < match.record.text.length
          ? `already covered by memory #${match.record.id}`
          : `restates memory #${match.record.id}`,
    }
  }

  return { decision: 'new', score: match.score, reason: 'no entry close enough to restate' }
}

/** Outcome of applying a plan. */
export interface ApplyResult {
  readonly decision: MergeDecision
  readonly record?: MemoryRecord
  /** Ids of entries the write demoted to `outdated`. */
  readonly superseded: readonly number[]
}

/**
 * Apply a plan, writing through the repository.
 *
 * MERGE appends the candidate's text to the existing entry rather than replacing it. That is
 * not politeness: the earlier statement is evidence, and a merged entry that silently drops
 * half of what the user said is indistinguishable from one that never stored it. UPDATE is
 * the different operation — it marks the old entry `outdated` and writes a new one, which is
 * what a correction needs so the previous belief stays auditable.
 *
 * @param repository - open repository.
 * @param candidate - the text being stored.
 * @param plan - the plan from {@link planMerge}.
 * @param base - fields carried onto a created or updated entry.
 * @returns what happened.
 */
export function applyMerge(
  repository: MemoryRepository,
  candidate: MergeCandidate,
  plan: MergePlan,
  base: Omit<NewMemory, 'text' | 'scope' | 'title'> = {},
): ApplyResult {
  switch (plan.decision) {
    case 'ignore':
      return { decision: 'ignore', ...(plan.target === undefined ? {} : { record: plan.target }), superseded: [] }

    case 'merge': {
      const target = plan.target
      if (target === undefined) return { decision: 'new', record: repository.insert(toNew(candidate, base)), superseded: [] }
      const mergedText = mergedBody(target.text, candidate.text)
      const tags = [...new Set([...target.tags, ...(candidate.tags ?? [])])]
      const record = repository.update(target.id, { text: mergedText, tags })
      return { decision: 'merge', ...(record === undefined ? {} : { record }), superseded: [] }
    }

    case 'update': {
      const target = plan.target
      if (target === undefined) return { decision: 'new', record: repository.insert(toNew(candidate, base)), superseded: [] }
      const superseded = [target.id]
      const record = repository.transact(() => {
        repository.update(target.id, { status: 'outdated' })
        return repository.insert(toNew(candidate, base))
      })
      return { decision: 'update', record, superseded }
    }

    case 'new':
      return { decision: 'new', record: repository.insert(toNew(candidate, base)), superseded: [] }
  }
}

/**
 * Combine an existing body with a restatement.
 *
 * When the candidate already contains the old text, it replaces it — otherwise a short
 * original followed by a longer, more precise version would store the vague one twice.
 *
 * @param existing - stored body.
 * @param incoming - candidate body.
 * @returns the body to store.
 */
function mergedBody(existing: string, incoming: string): string {
  const oldText = existing.trim()
  const newText = incoming.trim()
  if (oldText === '' || newText === oldText) return newText
  if (newText.includes(oldText)) return newText
  if (oldText.includes(newText)) return oldText
  return `${oldText}\n${newText}`
}

/**
 * Turn a candidate plus carried fields into an insertable row.
 *
 * @param candidate - the text and scope.
 * @param base - source, platform, importance and project carried from the caller.
 * @returns the row to insert.
 */
function toNew(candidate: MergeCandidate, base: Omit<NewMemory, 'text' | 'scope' | 'title'>): NewMemory {
  return {
    ...base,
    text: candidate.text,
    scope: candidate.scope,
    title: candidate.title ?? '',
    tags: candidate.tags ?? [],
    ...(candidate.source === undefined ? {} : { source: candidate.source }),
    ...(candidate.scope === 'project' ? { projectKey: candidate.projectKey ?? null } : {}),
  }
}

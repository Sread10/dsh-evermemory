/**
 * The distillation pipeline, assembled.
 *
 * extract → judge → scope → four-state merge → write. Each stage lives in its own module and
 * this file exists to sequence them and to keep the sequencing testable: the pipeline runs at
 * a session boundary, which is the worst possible place to discover that two stages disagreed.
 *
 * Constraint #8 is why there is no model call here. The pipeline's input is the session's own
 * event stream, which is deterministic, so a rule engine can be exactly as good as its rules
 * and no worse — and its failures are reproducible and fixable, which a model call's are not.
 */

import type { MemoryScope, SourcePlatform } from '../constants.js'
import type { MergePlan } from '../storage/merge.js'
import { applyMerge, planMerge, type ApplyResult, type MergeCandidate } from '../storage/merge.js'
import type { MemoryRecord, MemoryRepository, NewMemory } from '../storage/repository.js'
import { contradict } from '../storage/similarity.js'
import { extractFromMessages, type Candidate } from './extract.js'
import { judge, type RejectReason } from './judge.js'

/** One candidate's journey through the pipeline, kept for the distillation log. */
export interface DistillOutcome {
  readonly candidate: Candidate
  readonly scope: MemoryScope
  readonly importance: number
  readonly decision: 'new' | 'merge' | 'update' | 'ignore' | 'rejected'
  /** Present when the candidate was rejected by the quality gate. */
  readonly reason?: RejectReason
  /** Present when the candidate reached the merge. */
  readonly plan?: MergePlan
  /** Present when the candidate was written. */
  readonly applied?: ApplyResult
}

export interface DistillReport {
  readonly outcomes: readonly DistillOutcome[]
  readonly written: number
  readonly updated: number
  readonly merged: number
  readonly ignored: number
  readonly rejected: number
}

/**
 * Fields the caller adds to every candidate in this batch.
 *
 * The conversational tools use this: "remember this, pinned, for this project" is one candidate
 * whose route the caller already knows, and making the model's stated intent override the guessed
 * one is the whole difference between an explicit instruction and a guess. The automatic path sets
 * none of it.
 */
export interface DistillCarry {
  /**
   * Target layer chosen by the caller.
   *
   * Only these two: `identity` is a hand-edited file the plugin must not write, and `daily` has
   * its own append API (one row per day) that a direct write would corrupt.
   */
  readonly scope?: 'global' | 'project'
  readonly title?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly importance?: number
  readonly projectPath?: string | null
  readonly subId?: string | null
  readonly sourcePlatform?: SourcePlatform | null
}

/** Everything the pipeline needs about the session that produced the candidates. */
export interface DistillContext {
  readonly repository: MemoryRepository
  /** Project key, or `null` for a session with no resolvable project identity. */
  readonly projectKey: string | null
  /** Whether a trustworthy project identity exists at all — decides project-layer eligibility. */
  readonly hasProject: boolean
  readonly source?: NewMemory['source']
  /** Write nothing; classify only. Used by the settings panel's preview and by tests. */
  readonly dryRun?: boolean
  /**
   * Extra candidates the caller has already vouched for, e.g. an explicit `memory_remember`
   * tool call. These skip extraction but not the gate or the merge.
   */
  readonly seed?: readonly Candidate[]
  /** Fields the caller carries onto every write in this batch. See {@link DistillCarry}. */
  readonly carry?: DistillCarry
}

/**
 * Runs the pipeline over a batch of user messages.
 *
 * @param messages - the session's user messages, oldest first.
 * @param context - the repository, project identity and write mode.
 * @returns what happened, in enough detail for the log to explain every decision.
 */
export function distill(messages: readonly string[], context: DistillContext): DistillReport {
  return distillCandidates([...(context.seed ?? []), ...extractFromMessages(messages)], context)
}

/**
 * Runs the pipeline over already-extracted candidates.
 *
 * Separate from {@link distill} so the conversational tools can feed one candidate through the
 * same gate and merge as the automatic path. Two entry points that classified differently
 * would be a bug with no symptom until the two disagreed about the same sentence.
 */
export function distillCandidates(candidates: readonly Candidate[], context: DistillContext): DistillReport {
  const outcomes: DistillOutcome[] = []
  const pools = new Map<MemoryScope, MemoryRecord[]>()

  for (const candidate of candidates) {
    // `vouched` relaxes the judge's length window only: text a caller handed over whole (a tool
    // call, an imported note) is not a fragment a pattern fished out of a longer message.
    const verdict = judge(candidate, context.hasProject, candidate.vouched === true)

    if (!verdict.accepted) {
      outcomes.push({
        candidate,
        scope: verdict.scope,
        importance: 0,
        decision: 'rejected',
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      })
      continue
    }

    // The caller's stated layer wins over the guessed one, except that a project layer the
    // session cannot name is not a layer: writing a project row with a null key would file it
    // where no project query can reach it.
    const carry = context.carry
    const requested = carry?.scope
    const scope: MemoryScope =
      requested === 'project' && !context.hasProject ? 'global' : (requested ?? verdict.scope)

    const pool = poolFor(context, scope, pools)
    const mergeCandidate: MergeCandidate = {
      text: candidate.text,
      // Identity is the user's layer and the plugin does not write it; routing an identity cue
      // to `global` keeps the fact while leaving the hand-edited file alone.
      scope: scope === 'identity' ? 'global' : scope,
      ...(scope === 'project' ? { projectKey: context.projectKey } : {}),
      source: context.source ?? 'auto',
      ...(carry?.title === undefined ? {} : { title: carry.title }),
      ...(carry?.tags === undefined ? {} : { tags: carry.tags }),
    }

    let plan = planMerge(context.repository, mergeCandidate, { pool })

    // A correction whose subject the merge could not match still means an existing entry is
    // wrong. Scoring it as `new` would leave the superseded entry `active` beside its
    // replacement, which is the one outcome a correction exists to prevent — so the scan is
    // widened to the whole layer before the plan is accepted.
    if (plan.decision === 'new' && candidate.kind === 'correction') {
      const target = findContradiction(context.repository, mergeCandidate, pool)
      if (target !== undefined) {
        plan = {
          decision: 'update',
          target,
          score: plan.score,
          reason: `appears to revise memory #${target.id}`,
          conflict: target,
        }
      }
    }

    if (context.dryRun === true) {
      outcomes.push({
        candidate,
        scope: verdict.scope,
        importance: verdict.importance,
        decision: plan.decision,
        plan,
      })
      continue
    }

    const applied = applyMerge(context.repository, mergeCandidate, plan, {
      // The gate's importance is the default; a caller that named one meant it. The same goes for
      // the fields only a caller can know — that an entry is pinned, where the project lives, the
      // platform a statement was imported from.
      importance: carry?.importance ?? verdict.importance,
      ...(context.source === undefined ? {} : { source: context.source }),
      ...(carry?.pinned === undefined ? {} : { pinned: carry.pinned }),
      ...(carry?.projectPath === undefined ? {} : { projectPath: carry.projectPath }),
      ...(carry?.subId === undefined ? {} : { subId: carry.subId }),
      ...(carry?.sourcePlatform === undefined ? {} : { sourcePlatform: carry.sourcePlatform }),
    })
    outcomes.push({
      candidate,
      scope,
      importance: carry?.importance ?? verdict.importance,
      decision: applied.decision,
      plan,
      applied,
    })
  }

  return summarize(outcomes)
}

/**
 * The entries a candidate competes against, fetched once per layer.
 *
 * Caching matters because the automatic path can produce dozens of candidates at session end, and
 * re-reading the whole layer for each one turns a single write into a scan proportional to
 * (candidates × store size) — on a project with the 500-entry cap that is the difference between a
 * session boundary the user never notices and one they do.
 *
 * The cache is keyed by LAYER and the query is filtered to that layer. A pool without a scope
 * filter is not a cheaper version of the same thing: it lets a global statement merge into, or
 * mark `outdated`, a project-specific entry, which silently deletes one project's rule on the
 * strength of a remark made in another.
 */
function poolFor(
  context: DistillContext,
  scope: MemoryScope,
  pools: Map<MemoryScope, MemoryRecord[]>,
): MemoryRecord[] {
  // Identity candidates are routed to `global` below, so they compete against the global pool.
  const layer: MemoryScope = scope === 'identity' ? 'global' : scope
  const cached = pools.get(layer)
  if (cached !== undefined) return cached

  const pool = context.repository.list({
    scope: layer,
    status: ['active'],
    ...(layer === 'project' ? { projectKey: context.projectKey } : {}),
    limit: 1000,
  })
  pools.set(layer, pool)
  return pool
}

/**
 * Widens the contradiction scan beyond the nearest match.
 *
 * Used for corrections only. In the ordinary path a contradiction is found among the entries
 * close enough to compete, which keeps the cost proportional to relevance; a correction is
 * rare and its cost is bounded by the layer cap, so it can afford the full scan.
 */
function findContradiction(
  repository: MemoryRepository,
  candidate: MergeCandidate,
  pool: readonly MemoryRecord[],
): MemoryRecord | undefined {
  const near = pool.find((record) => contradict(candidate.text, record.text))
  if (near !== undefined) return near

  const projectScoped = candidate.scope === 'project' && candidate.projectKey != null
  const all = repository.list({
    status: ['active'],
    ...(projectScoped ? { projectKey: candidate.projectKey ?? null } : {}),
    limit: 1000,
  })
  return all.find((record) => contradict(candidate.text, record.text))
}

/** Counts the outcomes so callers can log one line instead of iterating the whole report. */
function summarize(outcomes: readonly DistillOutcome[]): DistillReport {
  let written = 0
  let updated = 0
  let merged = 0
  let ignored = 0
  let rejected = 0

  for (const outcome of outcomes) {
    switch (outcome.decision) {
      case 'new': written += 1; break
      case 'update': updated += 1; break
      case 'merge': merged += 1; break
      case 'ignore': ignored += 1; break
      case 'rejected': rejected += 1; break
    }
  }

  return { outcomes, written, updated, merged, ignored, rejected }
}

/**
 * A one-line summary for the log.
 *
 * Distillation is invisible by design — it happens after the user has stopped watching — so
 * the log line is the only evidence they get that it ran, and it has to name the outcome that
 * needs attention (a superseded entry) rather than only the total.
 */
export function describeReport(report: DistillReport): string {
  const parts = [`${report.written} new`, `${report.merged} merged`, `${report.updated} updated`]
  if (report.ignored > 0) parts.push(`${report.ignored} already known`)
  if (report.rejected > 0) parts.push(`${report.rejected} skipped`)
  return parts.join(', ')
}

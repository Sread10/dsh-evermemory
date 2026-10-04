/**
 * The memory policy layer: what a session may remember, forget, search and log.
 *
 * The conversational tools and (from step 8) the settings-panel route both go through here, so
 * the rules live in one place instead of being re-derived per caller: which layers a session can
 * write, which rows it can see, and what "remember this" means when the store already holds
 * something similar. The similarity decision is not re-implemented — an explicit remember is fed
 * through `distillCandidates`, the same gate and merge the automatic path uses, because two entry
 * points that classified independently would disagree about the same sentence with no symptom
 * until they did.
 *
 * The gate is not skipped for explicit calls. A `rejected` verdict is returned as a reason the
 * model can act on, which is the honest outcome: "too long to be a memory" is a real answer, and
 * silently storing a 5000-character document because the model asked nicely is how a store fills
 * with text nobody can retrieve.
 *
 * Language: results here are English, matching the engine's `reason` strings, which the tools
 * surface verbatim to the model. The rendered injection channels and the settings panel are
 * Chinese; the split is deliberate — model-facing text and user-facing text have different
 * audiences.
 */

import type { MemoryScope, MemoryStatus } from '../constants.js'
import { appendDaily, dayKey, readDaily } from '../distill/daily.js'
import type { DailyEntry, DailyLog } from '../distill/daily.js'
import { classifyCandidate } from '../distill/extract.js'
import { distillCandidates } from '../distill/engine.js'
import type { DistillContext, DistillOutcome } from '../distill/engine.js'
import { resolveIdentity } from '../identity/resolve.js'
import type { ProjectIdentity } from '../identity/resolve.js'
import { Retriever } from '../retrieval/retriever.js'
import type { SqliteDatabase } from '../storage/db.js'
import type { MemoryQuery, MemoryRecord, MemoryRepository } from '../storage/repository.js'

/**
 * What a session knows about itself.
 *
 * `projectKey` is the only field isolation depends on, and it is `null` — never a placeholder —
 * when no trustworthy identity could be resolved. A session with no project sees the global layer
 * and writes to it, which is constraint #4's fallback: session-scoped only, never the project
 * layer of a project it cannot name.
 */
export interface MemorySession {
  readonly cwd: string
  readonly identity: ProjectIdentity
  readonly projectKey: string | null
  readonly projectPath: string | null
  readonly subId: string | null
  readonly projectName: string
}

/** Resolve a session's identity from a working directory. */
export function createSession(cwd: string | undefined): MemorySession {
  const identity = resolveIdentity(cwd === undefined ? {} : { cwd })
  const trustworthy = identity.trustworthy && identity.key !== ''
  return {
    cwd: cwd ?? process.cwd(),
    identity,
    projectKey: trustworthy ? identity.key : null,
    projectPath: trustworthy ? identity.root : null,
    subId: identity.subId ?? null,
    projectName: identity.name,
  }
}

/**
 * The rows a session is allowed to read: the global layer, plus its own project and daily rows.
 *
 * One definition, two callers — the injection engine's index/card reader and the search tool.
 * They must agree: a memory the model can find with a tool but that is never injected, or worse
 * the reverse, is a store whose contents depend on how you ask.
 */
export function listVisible(repository: MemoryRepository, projectKey: string | null, query: MemoryQuery): MemoryRecord[] {
  const global = repository.list({ ...query, scope: ['global'], projectKey: null, limit: READ_LIMIT })
  if (projectKey === null) return global
  const project = repository.list({ ...query, scope: ['project', 'daily'], projectKey, limit: READ_LIMIT })
  return [...global, ...project]
}

/**
 * Read ceiling for one layer.
 *
 * The budget, not this number, decides what reaches the prompt; this only bounds how many rows a
 * single read materialises. It is deliberately far above any budget so that the ORDER BY — not
 * the LIMIT — chooses what survives truncation.
 */
export const READ_LIMIT = 600

/** A remember request as the tool received it. */
export interface RememberRequest {
  readonly text: string
  /** The layer the caller named. Omitted means "decide from the text". */
  readonly scope?: 'global' | 'project'
  readonly title?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly importance?: number
}

/** What happened to a remember request. */
export interface RememberResult {
  readonly decision: DistillOutcome['decision']
  /** The row written or updated, or — for `ignore` — the row the request matched. */
  readonly id: number | null
  readonly scope: MemoryScope
  readonly text: string
  /** Model-readable explanation. For merges this is the merge's own reason, verbatim. */
  readonly reason: string
  /** Rows marked `outdated` because this write contradicted them. */
  readonly superseded: readonly number[]
}

export interface ForgetRequest {
  readonly id: number
}

export interface ForgetResult {
  readonly ok: boolean
  readonly id: number
  /** The entry's text, so the caller can confirm what it forgot without another read. */
  readonly text: string
  readonly status: MemoryStatus | 'unknown'
  readonly reason: string
}

export interface SearchRequest {
  readonly query?: string
  readonly scope?: readonly MemoryScope[]
  readonly limit?: number
}

export interface SearchHit {
  readonly id: number
  readonly title: string
  readonly text: string
  readonly scope: MemoryScope
  readonly status: MemoryStatus
  readonly pinned: boolean
  readonly importance: number
  readonly tags: readonly string[]
  readonly updatedAt: string
}

export interface LogRequest {
  readonly entries: readonly DailyEntry[]
  /** Day to file under, `YYYY-MM-DD`. Defaults to today, locally. */
  readonly date?: string
}

export interface LogResult {
  readonly date: string
  readonly written: number
  readonly id: number | null
  readonly reason: string
}

/**
 * The service.
 *
 * Synchronous throughout, like the rest of the storage stack: `node:sqlite` is synchronous and a
 * tool call runs on the loop already. Only the caller decides what to do about failures.
 */
export class MemoryService {
  readonly #repository: MemoryRepository
  readonly #retriever: Retriever

  constructor(repository: MemoryRepository, db: SqliteDatabase) {
    this.#repository = repository
    this.#retriever = new Retriever(db, repository)
  }

  /** The raw repository, for the panel and the importer, which are not policy decisions. */
  get repository(): MemoryRepository {
    return this.#repository
  }

  /**
   * Store one statement the caller asked for by name.
   *
   * The text is stored whole: `classifyCandidate` reads only the cue KIND from it. Splitting an
   * explicit request on punctuation would store the fragments the patterns recognised and drop
   * the rest, and the user's sentence would come back as something they did not say.
   */
  remember(session: MemorySession, request: RememberRequest): RememberResult {
    const candidate = classifyCandidate(request.text)
    const context: DistillContext = {
      repository: this.#repository,
      projectKey: session.projectKey,
      hasProject: session.projectKey !== null,
      source: 'dialogue',
      carry: {
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
        ...(request.importance === undefined ? {} : { importance: request.importance }),
        // Only a session that knows its project records where a memory was stated. A global row
        // written from a project session is still a true statement about where it came from.
        ...(session.projectPath === null ? {} : { projectPath: session.projectPath }),
        ...(session.subId === null ? {} : { subId: session.subId }),
      },
    }

    const report = distillCandidates([candidate], context)
    const outcome = report.outcomes[0]
    if (outcome === undefined) {
      return { decision: 'rejected', id: null, scope: 'global', text: candidate.text, reason: 'the request produced no candidate', superseded: [] }
    }

    return {
      decision: outcome.decision,
      id: outcome.applied?.record?.id ?? outcome.plan?.target?.id ?? null,
      scope: outcome.scope,
      text: outcome.applied?.record?.text ?? candidate.text,
      reason: describeOutcome(outcome),
      superseded: outcome.applied?.superseded ?? [],
    }
  }

  /**
   * Forget one entry, by archiving it.
   *
   * Nothing is deleted: every read filters on `status = 'active'`, so an archived entry stops
   * being injected, searched and counted while remaining recoverable — the same trade the daily
   * layer's retention makes. Rows belonging to another project are refused rather than hidden:
   * a session cannot see them, so a request naming one is a mistake, and honouring it would let
   * any project delete any other project's memory by guessing an id.
   */
  forget(session: MemorySession, request: ForgetRequest): ForgetResult {
    const record = this.#repository.get(request.id)
    if (record === undefined) {
      return { ok: false, id: request.id, text: '', status: 'unknown', reason: `no memory #${request.id}` }
    }

    if (record.scope === 'identity') {
      return {
        ok: false,
        id: record.id,
        text: record.text,
        status: record.status,
        reason: 'the identity layer is a hand-edited file; edit it instead of forgetting it',
      }
    }

    if (record.scope === 'project' || record.scope === 'daily') {
      if (session.projectKey === null || record.projectKey !== session.projectKey) {
        return {
          ok: false,
          id: record.id,
          text: record.text,
          status: record.status,
          reason: `memory #${record.id} belongs to another project`,
        }
      }
    }

    if (record.status === 'archived') {
      return { ok: true, id: record.id, text: record.text, status: 'archived', reason: 'already archived' }
    }

    const updated = this.#repository.update(record.id, { status: 'archived' })
    return {
      ok: updated !== undefined,
      id: record.id,
      text: record.text,
      status: updated?.status ?? record.status,
      reason: updated === undefined ? `memory #${record.id} could not be updated` : 'archived',
    }
  }

  /**
   * Find entries.
   *
   * With a query, retrieval ranking decides the order and the relevance floor decides the cut.
   * Without one, this lists what the session can see, most recently touched first — a model that
   * has just been told "you already know this" needs a way to look without guessing a keyword.
   */
  search(session: MemorySession, request: SearchRequest): SearchHit[] {
    const limit = Math.max(1, request.limit ?? 10)
    const query = request.query?.trim() ?? ''
    const scopes = request.scope ?? []

    if (query === '') {
      // An explicit layer wins over the default pair. Without this, asking to list the identity
      // layer listed the global layers instead and then filtered every row out — the caller got
      // "nothing is known about the user" while the rows were sitting there.
      const records =
        scopes.length === 0
          ? listVisible(this.#repository, session.projectKey, { status: 'active', orderBy: 'used', limit: READ_LIMIT })
          : this.#listScopes(session, scopes)
      return this.#filter(records, request, session.projectKey).map((record) => toHit(record)).slice(0, limit)
    }

    // Over-fetch before filtering: a layer filter applied after a top-N cut would return fewer
    // than N rows even when the store holds enough of them.
    const hits = this.#retriever.retrieve({ query, projectKey: session.projectKey, limit: Math.max(limit, limit * 2) })
    return this.#filter(hits.map((hit) => hit.memory), request, session.projectKey)
      .slice(0, limit)
      .map((record) => toHit(record))
  }

  /**
   * The bodies worth pushing into this step, without the caller asking.
   *
   * The per-turn card channel's producer. It runs the SAME retriever `search` does, so a memory
   * that ranks first for a question is the one that ranks first whether the model asked or the
   * injection did — the alternative, a second ranking rule for cards, would make what the model
   * sees before asking differ from what it is told when it does.
   *
   * No relevance floor beyond the ranking: the injection budget is what decides how much survives,
   * and a floor here would silently drop the one entry a short question legitimately matches.
   * `listVisible`'s layer rule applies because the retriever binds the project key itself.
   */
  recall(session: MemorySession, query: string, limit: number): MemoryRecord[] {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const ranked = this.#retriever.retrieve({
      query: trimmed,
      projectKey: session.projectKey,
      limit: Math.max(1, Math.trunc(limit)),
    })
    return ranked.map((hit) => hit.memory)
  }

  /**
   * List named layers, newest use first.
   *
   * The project key is bound only for the layers that are keyed by it: global and identity rows
   * are shared and are read with a null key. A project-layer request from a session with no
   * identity lists nothing, which is the same answer the injection path gives it.
   */
  #listScopes(session: MemorySession, scopes: readonly MemoryScope[]): MemoryRecord[] {
    const needsProject = scopes.some((scope) => scope === 'project' || scope === 'daily')
    if (needsProject && session.projectKey === null) return []
    return this.#repository.list({
      status: 'active',
      orderBy: 'used',
      scope: scopes,
      projectKey: needsProject ? session.projectKey : null,
      limit: READ_LIMIT,
    })
  }

  /** Read one day's log. The date defaults to today, in the session's own local calendar. */
  daily(session: MemorySession, date?: string): DailyLog | undefined {
    return readDaily(this.#repository, date ?? dayKey(), session.projectKey)
  }

  /**
   * Append to today's log.
   *
   * The write is delegated to `appendDaily`, which owns the one-row-per-day upsert and never
   * throws. A log entry that cannot be written is reported, not raised: this runs while the user
   * is waiting for an answer, and a failed journal must not fail their turn.
   */
  log(session: MemorySession, request: LogRequest): LogResult {
    const entries = request.entries.filter((entry) => entry.text.trim() !== '')
    if (entries.length === 0) {
      return { date: request.date ?? dayKey(), written: 0, id: null, reason: 'no log entries to write' }
    }

    const record = appendDaily(this.#repository, entries, {
      ...(request.date === undefined ? {} : { date: request.date }),
      projectKey: session.projectKey,
      ...(session.projectPath === null ? {} : { projectPath: session.projectPath }),
      ...(session.subId === null ? {} : { subId: session.subId }),
    })

    if (record === undefined) {
      return { date: request.date ?? dayKey(), written: 0, id: null, reason: 'the daily log could not be written' }
    }
    return { date: record.title, written: entries.length, id: record.id, reason: 'appended' }
  }

  /**
   * Apply a layer filter, and re-check project reachability.
   *
   * The check is redundant with the SQL on purpose: retrieval and listing are two different
   * statements, and a filter that is one edit away from leaking another project's rows is worth
   * enforcing twice. It compares KEYS rather than testing for null — an earlier version let any
   * keyed row through, which would have been right only by accident, since the SQL above it was
   * what actually kept other projects' rows out.
   */
  #filter(records: readonly MemoryRecord[], request: SearchRequest, projectKey: string | null): MemoryRecord[] {
    const scopes = request.scope
    return records.filter((record) => {
      if (scopes !== undefined && scopes.length > 0 && !scopes.includes(record.scope)) return false
      if (record.scope !== 'project' && record.scope !== 'daily') return true
      return projectKey !== null && record.projectKey === projectKey
    })
  }
}

/** Flatten a record for a tool result. */
function toHit(record: MemoryRecord): SearchHit {
  return {
    id: record.id,
    title: record.title,
    text: record.text,
    scope: record.scope,
    status: record.status,
    pinned: record.pinned,
    importance: record.importance,
    tags: record.tags,
    updatedAt: record.updatedAt,
  }
}

/**
 * Why an outcome turned out the way it did, in one line.
 *
 * Reuses the merge's own `reason` where there is one — `appears to revise memory #7` says more
 * than `update`, and the model can act on it (it knows which entry it just changed).
 */
function describeOutcome(outcome: DistillOutcome): string {
  if (outcome.decision === 'rejected') return `rejected: ${outcome.reason ?? 'unknown'}`
  const record = outcome.applied?.record
  if (record !== undefined) {
    return outcome.plan === undefined || outcome.plan.reason === ''
      ? `stored as #${record.id}`
      : `${outcome.plan.reason} (now #${record.id})`
  }
  if (outcome.plan !== undefined && outcome.plan.reason !== '') return outcome.plan.reason
  return outcome.decision
}

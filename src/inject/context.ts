/**
 * Module 2: the memory channels, and the per-turn accounting that keeps them bounded.
 *
 * Three channels, all of them runtime CONTEXT rather than prompt sections, ordered by how badly
 * the model needs them:
 *
 *   1. `constraints` — standing rules the user pinned. Read before the model decides anything,
 *      so they are first and they are never abbreviated.
 *   2. `index` — what the store knows, as one line per entry. This is the map: it is what lets
 *      the model ask for a body instead of assuming that a memory does not exist.
 *   3. `cards` — the bodies retrieved for this turn. Dropped first when the budget runs out,
 *      because a dropped card costs one extra retrieval while a dropped constraint costs the
 *      behaviour the user asked for.
 *
 * The channel choice is not cosmetic. A prompt section would rewrite the system prompt's head on
 * every change, and prefix reuse would be lost from the first changed token — which for a
 * per-turn card means every turn. A runtime context is text-deduplicated by the host and appended
 * after the cached prefix, so an unchanged turn appends nothing at all.
 *
 * Two separate queries feed each channel, one for the global layer and one for the current
 * project, merged here rather than in SQL. That is not a style preference: a single query would
 * have to cap its result, and a project with 500 entries would push the global constraints — the
 * ones that apply everywhere — past the cap and out of the prompt.
 */

import type { MemoryQuery, MemoryRecord, MemoryRepository } from '../storage/repository.js'
import type { MemoryScope } from '../constants.js'
import type { ResolvedConfig } from '../config.js'
import { applyBudget, charCount } from './budget.js'
import type { BudgetResult, EmptyBudgetResult } from './budget.js'
import { listVisible } from '../memory/service.js'
import { SessionCards } from './dedup.js'
import type { IndexEntry } from './render.js'
import {
  clampCardBody,
  renderCards,
  renderConstraints,
  renderIndex,
  toCardEntry,
  toIndexEntry,
} from './render.js'

export type { CardEntry, IndexEntry } from './render.js'
/** Scopes the index reads. `identity` is a hand-edited file and is not indexed from the store. */
export const INDEX_SCOPES: readonly MemoryScope[] = ['global', 'project', 'daily']

/** The runtime-context section name, so a snapshot is recognisable in the transcript. */
export const CONTEXT_NAME = 'evermemory-memory'

/** Separate section names, so the panel and the transcript can tell the channels apart. */
export const SECTION_CONSTRAINTS = 'evermemory-constraints'
export const SECTION_INDEX = 'evermemory-index'
export const SECTION_CARDS = 'evermemory-cards'

/**
 * Rows read per channel query.
 *
 * Not a budget — the budget is applied to the rendered text. This is an upper bound on how much
 * the database is asked to hand over, and it is above the enforced entry caps (`GLOBAL_ENTRY_CAP`
 * 200, `PROJECT_ENTRY_CAP` 500) so a store at its cap is still fully represented.
 */
export { READ_LIMIT } from '../memory/service.js'

/** Everything the injection needs, passed in so no module reaches for a global. */
export interface InjectionDeps {
  readonly repository: MemoryRepository
  readonly config: ResolvedConfig
  /** Today's project key, or `null` when the identity is not trustworthy. */
  readonly projectKey: string | null
  /**
   * The bodies retrieved for this step.
   *
   * A callback rather than an array so a step that injects nothing — the common case once the
   * card has been sent — never pays for the retrieval query.
   */
  readonly cards?: (() => readonly MemoryRecord[]) | undefined
}

/** One channel's contribution before budgeting. */
interface SectionInput {
  readonly name: string
  readonly text: string
  readonly partial: boolean
}

/**
 * A channel's rendered sections plus the ids its text refers to.
 *
 * Only the constraints channel needs the `ids`: it quotes a rule without citing it, so the
 * reference cannot be read back out of the text the way an index line or a card heading can.
 */
interface ChannelBlock {
  readonly sections: readonly SectionInput[]
  readonly ids: readonly number[]
}

const EMPTY_CHANNEL: ChannelBlock = { sections: [], ids: [] }

/**
 * Per-agent injection state.
 *
 * One instance per agent. Sharing it would leak one session's context into another, which is the
 * single most damaging thing a memory plugin can do: the user would see one project's conventions
 * applied in another and have no way to tell where it came from.
 */
export class InjectionState {
  /** Cards offered so far, across the whole session and every step within it. */
  readonly cards = new SessionCards()

  /** Ids whose bodies were actually injected, so the index can omit them. */
  #bodyIds: readonly number[] = []

  /** Ids whose bodies were injected in the LAST step, for the panel and for tests. */
  #stepCardIds: readonly number[] = []

  #indexIds: readonly number[] = []
  #text = ''
  #report: BudgetResult | EmptyBudgetResult | undefined

  /** The text the runtime context should carry. Empty means "inject nothing". */
  get text(): string {
    return this.#text
  }

  /** Ids of the cards injected in the last step, in order. */
  get cardIds(): readonly number[] {
    return this.#stepCardIds
  }

  /** Ids shown in the last index block, in order. */
  get indexIds(): readonly number[] {
    return this.#indexIds
  }

  /** Ids whose bodies are in the transcript, across the session. */
  get bodyIds(): readonly number[] {
    return this.#bodyIds
  }

  /** Budget accounting for the last assembly. */
  get report(): BudgetResult | EmptyBudgetResult | undefined {
    return this.#report
  }

  /**
   * Rebuild the context text for this step.
   *
   * Called from `agent/pre-step`. Returns the text; the caller does not have to splice anything,
   * because the host appends a snapshot only when the rendered text changed.
   */
  rebuild(deps: InjectionDeps): string {
    const memoryOn = deps.config.memoryEnabled
    const constraintBudget = memoryOn ? deps.config.constraintBudgetChars : 0
    const indexBudget = memoryOn && deps.config.indexInjectionEnabled ? deps.config.indexBudgetChars : 0
    const cardBudget = memoryOn && deps.config.cardInjectionEnabled ? deps.config.cardBudgetChars : 0

    const constraints = constraintBudget > 0 ? this.#constraints(deps) : EMPTY_CHANNEL
    const index = indexBudget > 0 ? this.#index(deps, indexBudget) : []
    const cards = cardBudget > 0 ? this.#cards(deps) : []
    this.#stepCardIds = []

    const result = applyBudget(
      [...constraints.sections, ...index, ...cards],
      deps.config.turnBudgetChars,
    )
    this.#report = result
    this.#text = result.text

    // What was delivered is read from the outcome's kept text, never from the sections that were
    // offered. A card cut off before its own `— #id` marker was never delivered, and recording it
    // anyway would hide that memory from the index on the strength of an injection that did not
    // happen — leaving it in neither channel, with no way for the model to learn it exists.
    const keptText = (name: string): string | undefined =>
      result.outcomes.find((outcome) => outcome.name === name && outcome.keptChars > 0)?.keptText

    const cardText = keptText(SECTION_CARDS)
    this.#stepCardIds = cardText === undefined ? [] : idsInCardText(cardText)
    if (this.#stepCardIds.length > 0) {
      // Recorded only now, after the budget has decided: this is the step at which these bodies
      // enter the transcript, and the ledger is a record of the transcript, not of the retrieval.
      this.cards.record(this.#stepCardIds)
      this.#bodyIds = [...new Set([...this.#bodyIds, ...this.#stepCardIds])]
    }

    // Constraints render no ids on purpose (an id costs budget and a constraint is quoted, not
    // cited), so their ids cannot be parsed back out and come from the entries instead.
    // `partial: false` is what makes that exact: the section is either in the transcript whole or
    // not in it at all, so "some kept text" and "every id delivered" are the same statement.
    if (keptText(SECTION_CONSTRAINTS) !== undefined) {
      this.#bodyIds = [...new Set([...this.#bodyIds, ...constraints.ids])]
    }

    const indexText = keptText(SECTION_INDEX)
    this.#indexIds = indexText === undefined ? [] : idsInIndexText(indexText)

    return result.text
  }

  /**
   * Forget which cards have been sent, so the next step re-sends them.
   *
   * Called after a conversational write. A memory the user just corrected is exactly the one that
   * must be re-sent even though its id has been seen — that is the whole point of correcting it.
   */
  invalidateCards(): void {
    this.cards.refresh()
  }

  #constraints(deps: InjectionDeps): ChannelBlock {
    // Pinned entries are the ones the user escalated to a rule. They are rendered whole
    // (`partial: false`), because half a rule is a different rule.
    const entries = readBoth(deps, { status: 'active', pinned: true, orderBy: 'importance' }).map(toCardEntry)
    const text = renderConstraints(entries)
    if (text === '') return EMPTY_CHANNEL
    return {
      sections: [{ name: SECTION_CONSTRAINTS, text, partial: false }],
      ids: entries.map((entry) => entry.id),
    }
  }

  #index(deps: InjectionDeps, budget: number): readonly SectionInput[] {
    const records = readBoth(deps, { status: 'active', orderBy: 'created' })
    // A memory whose body is already in the transcript does not also need a line in the index:
    // the body carries the title, so the line is duplication paid for twice.
    //
    // This lags by one step on purpose. `#bodyIds` is extended only after the budget has run, so
    // on the step that first offers a card, that memory is still listed in the index as well —
    // roughly a dozen wasted characters. Exclusion recorded BEFORE the budget would be worse: a
    // card the budget dropped would then be hidden from the index too, and since the card is only
    // re-offered when `cards` returns it again, the memory would be in neither channel and the
    // model would have no way to learn it exists.
    //
    // `#bodyIds` alone, not `this.cards.offeredIds`: that ledger now holds only delivered bodies,
    // and this set already contains them, so adding it back would be a second source of truth for
    // the same fact — the kind that drifts.
    const exclude = new Set<number>(this.#bodyIds)

    const entries: IndexEntry[] = records.map(toIndexEntry)
    const shown = entries.filter((entry) => !exclude.has(entry.id))
    const text = renderIndex(shown, { excludeIds: exclude })
    if (text === '') return []
    const fitted = fitIndex(text, budget)
    if (fitted === '') return []
    this.#indexIds = idsInIndexText(fitted)
    // `partial: false` even though an index is a list: it has its own line-aware trim in
    // `fitIndex`, so the generic truncator can only make it worse. What it produced was a header
    // reading `[记忆索引 · 1 条] …[已截断]` with no entries under it — a claim that one memory
    // exists, no way to tell which, and the count wrong. Dropping it whole is the honest outcome,
    // and the cards still carry whatever was retrieved.
    return [{ name: SECTION_INDEX, text: fitted, partial: false }]
  }

  #cards(deps: InjectionDeps): readonly SectionInput[] {
    const source = deps.cards
    if (source === undefined) return []
    const fresh = this.cards.filter(source())
    if (fresh.length === 0) return []
    const entries = fresh.map((record) => clampCardBody(toCardEntry(record), deps.config.maxMemoryChars))
    return [{ name: SECTION_CARDS, text: renderCards(entries), partial: true }]
  }
}

/**
 * Read the global layer and the current project's layer, and concatenate them.
 *
 * Global first: a global preference is the one the user stated about themselves, and when a
 * project entry repeats it the project entry is the narrower statement. Both are kept — this is
 * not a merge, because the model can read two similar lines and the alternative is deciding in
 * advance which one the user meant.
 *
 * The rule itself lives in `memory/service.ts`, because the search tool applies the same one: an
 * entry the model can find by asking but that is never injected — or the reverse — would make the
 * store's contents depend on how you ask.
 */
export function readBoth(deps: InjectionDeps, query: MemoryQuery): MemoryRecord[] {
  return listVisible(deps.repository, deps.projectKey, query)
}

/**
 * Ids appearing in a rendered index block, matched against the whole line shape the renderer
 * emits rather than the bare `· #` pair — an index TITLE is arbitrary text the user wrote, and a
 * title containing `· #7` must not be read as a reference to memory 7.
 */
function idsInIndexText(text: string): number[] {
  const ids = new Array<number>()
  for (const match of text.matchAll(INDEX_ID_LINE)) ids.push(Number(match[1]))
  return ids
}

const INDEX_ID_LINE = /^-\s.*·\s#(\d+)\s*$/gmu

/** Ids appearing in a rendered card block. Anchored for the same reason as the index pattern. */
function idsInCardText(text: string): number[] {
  const ids = new Array<number>()
  for (const match of text.matchAll(CARD_ID_LINE)) ids.push(Number(match[1]))
  return ids
}

const CARD_ID_LINE = /^###\s.*—\s#(\d+)\s*$/gmu

/**
 * Trim an index block to its lane budget on a line boundary.
 *
 * The caller normally passes an index that already fits, because the index is built from lines
 * and the entry cap keeps it small. This exists so the lane budget is enforced even when a store
 * ignores its cap, and it trims on a line boundary rather than mid-line: half an index line reads
 * as a memory whose title was written strangely, and the count in the header would then be wrong.
 * The header count is rewritten to the number of lines actually kept.
 */
export function fitIndex(text: string, budget: number): string {
  if (charCount(text) <= budget) return text
  const lines = text.split('\n')
  const header = lines[0] ?? ''
  const kept = new Array<string>()
  let used = charCount(header)
  for (const line of lines.slice(1)) {
    const cost = charCount(line) + 1
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  if (kept.length === 0) return ''
  return [withCount(header, kept.length), ...kept].join('\n')
}

/** Rewrite the count in an index header to match the lines actually kept. */
function withCount(header: string, count: number): string {
  const match = /^(.*·\s*)(\d+)(\s*条\]$)/u.exec(header)
  if (match === null) return header
  return `${match[1]}${String(count)}${match[3]}`
}

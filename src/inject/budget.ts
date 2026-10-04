/**
 * Hard character budgets for everything this plugin injects.
 *
 * The number that matters is the summed one. Per-turn overhead must stay bounded and must not
 * grow with the size of the memory store — a store of ten thousand entries may be *searched*
 * every turn, but only a fixed number of characters may be *spent* on it. A cap per channel
 * alone does not give that: three channels each under their own limit still add up, so
 * `clampToTurnBudget` is applied last, over the assembled result, and a section that does not
 * fit is dropped rather than truncated into a misleading fragment.
 *
 * Characters, not tokens. A real tokenizer is not available on the injected channel and
 * shipping one would cost more than it measures; the configured caps are deliberately chosen
 * so that the character count is a conservative upper bound on the token count for the mixed
 * Chinese/Latin text this plugin stores, since one CJK character is at most one token.
 */

/** One rendered block competing for a budget. */
export interface BudgetSection {
  /** Stable identity, used in the report and as the snapshot section name. */
  readonly name: string
  readonly text: string
  /**
   * Whether a truncated fragment of this section is still useful.
   *
   * A list can be cut mid-way and remain honest. A single rule cannot: half a rule is a
   * different rule, and injecting it may be worse than injecting nothing.
   */
  readonly partial: boolean
}

/** What happened to one section. */
export interface BudgetOutcome {
  readonly name: string
  readonly keptChars: number
  /**
   * The section text as it was actually kept, or `''` when nothing survived.
   *
   * Callers need this to decide what the model can really read. A truncated section is not a
   * delivered section: recomputing "what was kept" from the pre-budget text — or parsing the
   * assembled result back apart — gets the answer wrong exactly when the budget was tight, which
   * is the only time the answer matters.
   */
  readonly keptText: string
  readonly dropped: boolean
  readonly truncated: boolean
}

/** The assembled result plus the accounting behind it. */
export interface BudgetResult {
  readonly text: string
  readonly usedChars: number
  readonly outcomes: readonly BudgetOutcome[]
}

/** Nothing survived; the caller should not inject at all rather than send an empty frame. */
export interface EmptyBudgetResult {
  readonly text: ''
  readonly usedChars: 0
  readonly outcomes: readonly BudgetOutcome[]
}

/**
 * Truncation marker.
 *
 * Deliberately not an ellipsis character. This string is read by a model deciding what the
 * user's project conventions are, and "there was more" is the load-bearing information; a
 * typographic `…` can also be confused with text the user actually wrote.
 */
export const TRUNCATION_MARKER = ' …[已截断]'

const LINE_SEPARATOR = '\n'

/** How sections are joined. Counted against the budget, because the budget bounds the result. */
const SEPARATOR = '\n\n'

/** Characters in `text`, counted by Unicode code point rather than UTF-16 unit. */
export function charCount(text: string): number {
  return [...text].length
}

/** Drop everything after `limit` code points, appending no marker. */
export function truncateChars(text: string, limit: number): string {
  if (limit <= 0) return ''
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/**
 * Truncate to `limit` code points including the marker, cutting on a line boundary when one
 * is available so the result does not end mid-word.
 */
export function clampChars(text: string, limit: number, marker = TRUNCATION_MARKER): string {
  if (limit <= 0) return ''
  const chars = [...text]
  if (chars.length <= limit) return text
  const room = limit - charCount(marker)
  if (room <= 0) return truncateChars(marker, limit)
  const head = chars.slice(0, room).join('')
  const lastBreak = head.lastIndexOf(LINE_SEPARATOR)
  // A line boundary is only worth taking if it does not throw most of the allowance away.
  const cut = lastBreak > room / 2 ? head.slice(0, lastBreak) : head
  return `${cut.trimEnd()}${marker}`
}

/** Join non-empty sections, separated by one blank line. */
export function joinSections(sections: readonly string[]): string {
  return sections
    .map((section) => section.trim())
    .filter((section) => section !== '')
    .join(SEPARATOR)
}

/** One-blank-line join, then a hard cut. Used for the single-block channels. */
export function joinWithinBudget(sections: readonly string[], budget: number): string {
  const clamped = new Array<string>()
  let remaining = budget
  for (const section of sections) {
    const text = section.trim()
    if (text === '' || remaining <= 0) continue
    const kept = charCount(text) <= remaining ? text : clampChars(text, remaining)
    if (kept === '') continue
    clamped.push(kept)
    remaining -= charCount(kept)
  }
  return clampChars(joinSections(clamped), budget)
}

/**
 * Assemble `sections` into at most `budget` characters, honouring each section's `partial`
 * flag, and report what was kept, cut and dropped.
 *
 * Order is precedence: the first section has the strongest claim on the budget. That is why an
 * over-budget tail section is dropped whole instead of sharing the loss.
 *
 * The separators count. Sections are joined with a blank line, so the assembled text is longer
 * than the sum of its parts — ignoring that here made the total exceed the budget by two
 * characters per join, which is small enough to pass a casual look and large enough to break the
 * one invariant the plugin promises.
 */
export function applyBudget(
  sections: readonly BudgetSection[],
  budget: number,
): BudgetResult | EmptyBudgetResult {
  const outcomes = new Array<BudgetOutcome>()
  const kept = new Array<string>()
  let remaining = budget

  for (const section of sections) {
    const text = section.text.trim()
    if (text === '') {
      outcomes.push({ name: section.name, keptChars: 0, keptText: '', dropped: false, truncated: false })
      continue
    }

    // A separator is only paid when something was already kept, so an empty leading section does
    // not spend two characters on nothing.
    const gap = kept.length > 0 ? SEPARATOR.length : 0
    const size = charCount(text)
    if (size + gap <= remaining) {
      kept.push(text)
      remaining -= size + gap
      outcomes.push({ name: section.name, keptChars: size, keptText: text, dropped: false, truncated: false })
      continue
    }

    if (section.partial && remaining - gap > 0) {
      const trimmed = clampChars(text, remaining - gap)
      // A fragment with no complete line in it is not a shorter section, it is a marker with a
      // fragment of a heading attached — `[相关记忆 · 1 条 · 按相关度] …[已截断]` under no entries.
      // It spends budget to tell the model that something exists which it cannot read.
      if (trimmed !== '' && trimmed.includes(LINE_SEPARATOR)) {
        kept.push(trimmed)
        remaining -= charCount(trimmed) + gap
        outcomes.push({
          name: section.name,
          keptChars: charCount(trimmed),
          keptText: trimmed,
          dropped: false,
          truncated: true,
        })
        continue
      }
    }

    outcomes.push({ name: section.name, keptChars: 0, keptText: '', dropped: true, truncated: false })
  }

  const text = joinSections(kept)
  if (text === '') return { text: '', usedChars: 0, outcomes }
  return { text, usedChars: charCount(text), outcomes }
}

/**
 * Clamp an already-assembled block to the shared per-turn budget.
 *
 * This is the second half of the invariant. `applyBudget` bounds each channel; this bounds the
 * total, so the steady-state cost is a property of the configuration rather than of how many
 * channels happen to be enabled.
 */
export function clampToTurnBudget(text: string, turnBudget: number): string {
  return clampChars(text, turnBudget)
}

/** One-line accounting for the settings panel and the tests. */
export function describeBudget(result: BudgetResult | EmptyBudgetResult): string {
  const parts = result.outcomes
    .filter((outcome) => outcome.keptChars > 0 || outcome.dropped)
    .map((outcome) => {
      if (outcome.dropped) return `${outcome.name}: dropped`
      return outcome.truncated
        ? `${outcome.name}: ${outcome.keptChars} chars (truncated)`
        : `${outcome.name}: ${outcome.keptChars} chars`
    })
  return parts.length === 0 ? 'nothing injected' : parts.join(', ')
}

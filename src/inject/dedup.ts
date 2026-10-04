/**
 * Cross-turn deduplication of the retrieval card.
 *
 * `agent/pre-step` fires **once per step**, not once per turn, and a turn with tool calls has
 * many steps. Injecting "the top 5 relevant memories" on each of them re-sends the same five
 * bodies until the context is mostly memory. The budget cap does not fix that on its own: the
 * cap bounds one injection, while the repetition is the injection happening again.
 *
 * So the unit of dedup is the whole session, keyed on memory id. Once a body has been offered it
 * is not offered again — unless the caller explicitly asks for a refresh, which the
 * conversational tools do after a write, since a memory the user just corrected is exactly the
 * one that must be re-sent even though its id was seen before.
 *
 * The index uses the same set in the opposite direction: a body that is already in context does
 * not also need its title in the index. See `renderIndex`'s `excludeIds`.
 */

/** One retrievable thing, identified by the memory id it came from. */
export interface Identified {
  readonly id: number
}

/**
 * How many ids one session tracks before it stops recording.
 *
 * The cap exists because a session has no natural end in a long-running editor: without it the
 * set grows for as long as the window is open. Passing the cap does NOT start recycling ids —
 * that would re-inject bodies the model still has — it stops recording new ones, which degrades
 * to "recent memories may repeat" rather than "old memories reappear".
 */
export const DEFAULT_MAX_TRACKED = 500

/** Per-session ledger of what has already been injected. */
export class SessionCards {
  readonly #offered = new Set<number>()
  readonly #maxTracked: number
  #saturated = false

  constructor(maxTracked: number = DEFAULT_MAX_TRACKED) {
    this.#maxTracked = Math.max(1, maxTracked)
  }

  /**
   * Drop everything already delivered. Pure: it records nothing.
   *
   * Recording is deliberately NOT done here, because at this point the card has only been
   * *offered*. Whether it is delivered is decided later, by the budget — and a card the budget
   * dropped must be offered again on the next step rather than counted as seen. A filter that
   * recorded would mark a memory as "in the transcript" when the transcript never received it,
   * and the index (which excludes `offeredIds`) would then hide it as well: the memory would be
   * in neither channel, with no way for the model to learn it exists.
   */
  filter<T extends Identified>(items: readonly T[]): T[] {
    const fresh = new Array<T>()
    for (const item of items) {
      if (this.#offered.has(item.id)) continue
      fresh.push(item)
    }
    return fresh
  }

  /**
   * Record ids as delivered.
   *
   * Stops at the cap rather than recycling: re-offering a body the model already has is exactly
   * the repetition this class exists to prevent, so saturation degrades to "a recent memory may
   * be repeated" and never to "an old memory reappears".
   */
  record(ids: readonly number[]): void {
    for (const id of ids) {
      if (this.#offered.size >= this.#maxTracked) {
        this.#saturated = true
        return
      }
      this.#offered.add(id)
    }
  }

  /** Forget the offer history, so the next retrieval re-sends everything. */
  refresh(): void {
    this.#offered.clear()
    this.#saturated = false
  }

  /** Ids already delivered, for the index's exclusion set. */
  get offeredIds(): ReadonlySet<number> {
    return this.#offered
  }

  has(id: number): boolean {
    return this.#offered.has(id)
  }

  get size(): number {
    return this.#offered.size
  }

  /** True once the tracker stopped recording; the caller can surface this in diagnostics. */
  get saturated(): boolean {
    return this.#saturated
  }
}

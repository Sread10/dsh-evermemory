/**
 * The one-line memory check appended at the end of the system prompt.
 *
 * Why a tail reminder at all, when the index and the cards are already in context: those live in
 * the transcript, and a model that has just read a long tool result does not reliably act on
 * something it read eight thousand tokens ago. The last line of the system prompt is the one
 * position that is read immediately before the model decides what to do.
 *
 * Why it is optional and off by default. It sits at `ORDER_MEMORY_TAIL_REMINDER` (9999), which is
 * inside the prompt HEAD — so a change to it invalidates the prefix cache. It does not change in
 * practice between sessions, and never within one, because the text is a constant. What it does
 * cost is its own length on every assembly, and a user who finds it noisy should be able to turn
 * it off without losing memory. That is what `tailReminderEnabled` is for.
 *
 * The text names the CONDITIONS for using memory rather than the tools, because a tool catalogue
 * is already injected by the host elsewhere and duplicating it would spend these characters on
 * information the model already has. What the model lacks is not the tool list — it is the
 * knowledge that its own recollection is a claim it should verify.
 */

import { ORDER_MEMORY_TAIL_REMINDER } from '../constants.js'
import type { ResolvedConfig } from '../config.js'
import { charCount } from './budget.js'
import { systemPromptOf } from './prompt.js'

/** Section name. Distinct from the rules section so the two can be toggled apart. */
export const TAIL_SECTION_NAME = 'evermemory-reminder'

/**
 * The reminder.
 *
 * Three instructions, in the order the failure modes matter:
 *   1. Verify before claiming — an invented recollection is indistinguishable from a real one
 *      once it is in the transcript, and the user has no way to check it.
 *   2. Store corrections immediately — this is the only moment the user's wording is available;
 *      a distilled guess made later is worse than the sentence they actually said.
 *   3. Disagree rather than overwrite — a memory store that silently absorbs a contradiction is
 *      worse than one with no entry at all, because the stale entry keeps being applied.
 */
export const TAIL_REMINDER =
  '记忆：不确定就先查，不要凭印象断言；用户纠正或要求记住时，立刻写入；与已有记忆冲突时先说明，不要直接覆盖。'

/** Characters the reminder costs. Asserted in tests so the budget cannot drift unnoticed. */
export const TAIL_REMINDER_CHARS = charCount(TAIL_REMINDER)

/** Whether the tail reminder should be registered at all. */
export function tailReminderEnabled(config: ResolvedConfig): boolean {
  return config.memoryEnabled && config.tailReminderEnabled
}

/**
 * Register the tail section, if it is wanted and the memory store has anything in it.
 *
 * An empty store gets no reminder: telling the model to consult a memory it does not have is an
 * instruction that can only produce a hallucinated retrieval.
 */
export function mountTailReminder(ctx: unknown, config: ResolvedConfig, hasEntries: () => boolean): boolean {
  if (!tailReminderEnabled(config)) return false
  const prompt = systemPromptOf(ctx)
  if (prompt === undefined) return false
  prompt.section({
    name: TAIL_SECTION_NAME,
    order: ORDER_MEMORY_TAIL_REMINDER,
    // Evaluated at assembly time, so it reads the current state rather than capturing a decision
    // made at mount. An empty string is dropped by the assembly, leaving no gap.
    text: () => (hasEntries() ? TAIL_REMINDER : ''),
    // The text is a constant, but a stored memory could contain `{{`. Interpolation is off so a
    // memory can never turn into a prompt variable, and so an unknown variable cannot throw
    // during assembly.
    interpolate: false,
  })
  return true
}

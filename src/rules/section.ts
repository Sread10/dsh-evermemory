/**
 * Module 1: the behavioural-rules section.
 *
 * This is the one thing in the plugin that belongs in the system prompt's head. The rules change
 * only when a human edits a file, so the rendered text is stable within a session, which means
 * the prefix cache pays for it once and every later turn reuses it. Anything that varies per turn
 * must NOT go here: a section that changes rewrites the prompt head, and reuse is lost from the
 * first changed token onward.
 *
 * The section text is refreshed on `agent/pre-step` rather than inside the section callback. The
 * callback runs during prompt assembly, where a filesystem read would be paid on every assembly,
 * and where a slow or unreachable path would stall the step. Reading at the step boundary instead
 * puts the cost where it is visible and bounded, and lets the refresh set a flag when the text
 * actually changed.
 *
 * Content is taken from `refresh.text` at render time, so the callback is synchronous and cheap:
 * it returns a string the state already holds.
 */

import { resolveDshHome } from '../storage/paths.js'
import { loadRules } from '../rules/loader.js'
import { clampToTurnBudget } from '../inject/budget.js'
import { systemPromptOf } from '../inject/prompt.js'

/** Mutable state behind the section. Replaced wholesale on refresh; the section reads it. */
export interface RulesState {
  text: string
  fileCount: number
  degraded: boolean
  /** DSH home the current text was read against, or `undefined` before the first refresh. */
  home: string | undefined
}

/** Knobs the section needs, all optional so tests can drive it without a host. */
export interface RulesSectionOptions {
  /** Extra rule directories from the config, highest priority last. */
  readonly extraDirs?: readonly string[] | undefined
  /** Hard cap on the rendered text, from `turnBudgetChars`. */
  readonly maxChars: number
  /** Include `$DSH_HOME/rules`. */
  readonly includeGlobal?: boolean | undefined
}

/** A tick that could not be spent on reading rule files. */
export interface RuleTick {
  /** `false` when the TTL has not expired since the last read. */
  readonly read: boolean
  /** `true` when the rendered text differs from what the section currently holds. */
  readonly changed: boolean
}

/**
 * Applies `TURN_BUDGET_CHARS` as an upper bound rather than a lane budget.
 *
 * The rules amount to text the user wrote and asked to be obeyed, so quietly dropping half of it
 * would be worse than spending the characters. The turn budget still applies, because the
 * invariant is about the total per-turn cost and a rules file is not exempt from it just for
 * being user-authored.
 */
export function clampRules(text: string, maxChars: number): string {
  return text === '' ? '' : clampToTurnBudget(text, maxChars)
}

/** Create the empty state a session starts from. */
export function createRulesState(): RulesState {
  return { text: '', fileCount: 0, degraded: false, home: undefined }
}

/** Inputs to one refresh attempt. */
export interface RefreshContext {
  readonly cwd?: string | undefined
  /** Injected clock; tests pin it. */
  readonly now?: number
  readonly ttlMs?: number
  /** Ignore the TTL and read. */
  readonly force?: boolean
  /** Per-agent bookkeeping. Created when omitted, which is only useful for one-off calls. */
  readonly tick?: RuleTickState
}

/** Per-session bookkeeping that must not be shared between agents. */
export interface RuleTickState {
  lastReadAt: number
}

/** A fresh tick state. One per agent. */
export function newRuleTickState(): RuleTickState {
  return { lastReadAt: 0 }
}

/**
 * Re-read the rule files if the TTL allows, and report whether the section's text changed.
 *
 * `changed` is the honest signal for the panel and for tests; the host already deduplicates by
 * rendered text, so the section would cost the same either way.
 */
export function refreshRules(
  state: RulesState,
  options: RulesSectionOptions,
  context: RefreshContext = {},
): RuleTick {
  const tick = context.tick ?? newRuleTickState()
  const ttl = context.ttlMs ?? RULES_TTL_MS
  const now = context.now ?? Date.now()
  if (context.force !== true && tick.lastReadAt !== 0 && now - tick.lastReadAt < ttl) {
    return { read: false, changed: false }
  }
  tick.lastReadAt = now

  const home = resolveDshHome()
  const loaded = loadRules({
    dshHome: home,
    ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    ...(options.extraDirs === undefined ? {} : { extraDirs: options.extraDirs }),
    ...(options.includeGlobal === undefined ? {} : { includeGlobal: options.includeGlobal }),
  })
  const text = clampRules(loaded.text, options.maxChars)

  const changed = text !== state.text || state.home !== home
  state.text = text
  state.fileCount = loaded.files.length
  state.degraded = loaded.degraded
  state.home = home
  return { read: true, changed }
}

/**
 * How long a rendered rule set is trusted.
 *
 * A refresh costs one `statSync` per rule file, so this is not about avoiding a catastrophic
 * read — it is about not paying a syscall per step in a session that may run for hours. Long
 * enough to be free, short enough that saving a rules file takes effect without restarting DSH.
 */
export const RULES_TTL_MS = 5_000

/** Section name. Exported so the wiring test can name the section it expects, rather than pinning
 * a string that a rename would silently change on both sides at once. */
export const RULES_SECTION_NAME = 'evermemory-rules'

/**
 * Register the section on a context.
 *
 * Called with the plugin context for the global case and with an agent-scoped context when one
 * is available, where the same section name shadows the global registration for that agent only.
 * The options and tick state are not parameters: the section reads `state.text` and nothing else,
 * so the only thing this function needs to know is where to register.
 */
export function mountRulesSection(
  ctx: unknown,
  state: RulesState,
  order: number,
): boolean {
  const prompt = systemPromptOf(ctx)
  if (prompt === undefined) return false
  prompt.section({
    name: RULES_SECTION_NAME,
    order,
    // Evaluated during assembly, so it must not read anything. The refresh that fills `state`
    // has already run by the time the prompt is assembled for the step.
    text: () => state.text,
  })
  return true
}

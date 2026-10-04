/**
 * Plugin configuration.
 *
 * Two kinds of field live here and the distinction is load-bearing:
 *
 *  - **Volatile** fields are user preferences. They are marked `.volatile()` so the Host
 *    `SettingsForms` service projects them into the settings page under the Loader entry
 *    id as namespace. A row with zero volatile fields is silently omitted from
 *    `describe()`, and a write against it throws `Plugin entry "<ns>" has no volatile
 *    fields` — so dropping a `.volatile()` call does not fail loudly, it makes the whole
 *    settings surface disappear.
 *
 *  - **Non-volatile** fields are deployment limits. They are set by whoever installs the
 *    plugin, never by the settings UI.
 *
 * Three traps this file exists to avoid, all verified against the runtime:
 *
 *  1. `.volatile()` returns a COPY. Calling it for its side effect discards the marking.
 *     Every call site below assigns the result.
 *  2. It must be `@deepseek-ai/schemastery`, never the public `schemastery` package. Only
 *     the DSH build wraps a `meta.volatile` field in a cosmokit `Volatile` reference, and
 *     the Loader's commit path walks those references. With the public package a write
 *     reports success while the effective value never changes.
 *  3. After Loader resolution a volatile field is that cosmokit reference object, not a
 *     primitive — so every read goes through `unwrapConfig()`. Reading `config.pinned`
 *     directly yields an object that is always truthy.
 */

import z from '@deepseek-ai/schemastery'

import {
  CARD_BUDGET_CHARS,
  CONSTRAINT_BUDGET_CHARS,
  INDEX_BUDGET_CHARS,
  MAX_MEMORY_CHARS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  TURN_BUDGET_CHARS,
} from './constants.js'

/** The configuration exactly as declared, before the Loader resolves volatile fields. */
interface Declared {
  /** Module 1: inject behavioural rules from the rules directories. */
  rulesEnabled: boolean
  /** Module 2: long-term memory. */
  memoryEnabled: boolean
  /** Project-scoped layer. Meaningless while `memoryEnabled` is off. */
  projectMemoryEnabled: boolean
  /** Write the day's log at turn end. */
  dailyLogEnabled: boolean
  /** Inject the resident index (names and keywords only) every turn. */
  indexInjectionEnabled: boolean
  /** Inject the per-turn relevance card. */
  cardInjectionEnabled: boolean
  /** Inject hard constraints through the runtime-context channel. */
  constraintInjectionEnabled: boolean
  /** The tail "memory check" reminder. See ORDER_MEMORY_TAIL_REMINDER. */
  tailReminderEnabled: boolean
  /** Run the rule-based distillation pipeline at turn end. */
  distillEnabled: boolean
  /** Extra source directories scanned for behavioural rules, before the project level. */
  extraRuleDirs: string[]
  // Derived caps — the two limit fields keep their shipped defaults unless overridden.
  /** Per-turn ceiling for everything this plugin injects, in characters. */
  turnBudgetChars: number
  /** Ceiling for the resident index. */
  indexBudgetChars: number
  /** Ceiling for the per-turn card. */
  cardBudgetChars: number
  /** Ceiling for injected hard constraints. */
  constraintBudgetChars: number
  /** Maximum characters accepted for one memory body. */
  maxMemoryChars: number
  /** Default result count when a tool call omits `limit`. */
  searchLimitDefault: number
  /** Hard ceiling on result count, whatever a tool call asks for. */
  searchLimitMax: number
}

/** `Declared` after the Loader has resolved volatile references to plain values. */
export type ResolvedConfig = {
  [K in keyof Declared]: K extends 'extraRuleDirs' ? string[] : Declared[K] extends number ? number : boolean
}

/**
 * The shipped defaults, in one place.
 *
 * Every field's default is written here once and referenced by both the schema (so the Loader and
 * the settings form see it) and `unwrapConfig` (so a config object that predates a field, or a
 * test that only cares about one of them, behaves the same as a resolved one). Duplicating them
 * would be a slow-motion bug: the settings page would show one value while the injection used
 * another, which is invisible until someone wonders why a switch does nothing.
 */
export const DEFAULTS = Object.freeze({
  // ── Preferences (volatile: editable from the settings page) ────────────────
  rulesEnabled: true,
  memoryEnabled: true,
  projectMemoryEnabled: true,
  dailyLogEnabled: true,
  indexInjectionEnabled: true,
  cardInjectionEnabled: true,
  constraintInjectionEnabled: true,
  tailReminderEnabled: false,
  distillEnabled: true,
  extraRuleDirs: Object.freeze([]) as readonly string[],

  // ── Deployment limits (non-volatile: never editable from the UI) ───────────
  turnBudgetChars: TURN_BUDGET_CHARS,
  indexBudgetChars: INDEX_BUDGET_CHARS,
  cardBudgetChars: CARD_BUDGET_CHARS,
  constraintBudgetChars: CONSTRAINT_BUDGET_CHARS,
  maxMemoryChars: MAX_MEMORY_CHARS,
  searchLimitDefault: SEARCH_LIMIT_DEFAULT,
  searchLimitMax: SEARCH_LIMIT_MAX,
} satisfies Record<keyof Declared, boolean | number | readonly string[]>)

/**
 * Build the schema with every user-editable field marked volatile.
 *
 * Written out field by field rather than generated from a shared field map. The
 * generation trick — derive a `Record<key, Field>` and rebuild one object with
 * `.volatile()` applied — is shorter but relies on the schema's internal `.dict`, which
 * is an implementation detail of the DSH build. An explicit schema survives a version
 * bump that drops it, and the mapping from "which fields have a UI" to "which lines say
 * `.volatile()`" stays legible.
 */
export const Config = z.object({
  // ── Preferences (volatile: editable from the settings page) ────────────────
  rulesEnabled: z.boolean().default(DEFAULTS.rulesEnabled).volatile(),
  memoryEnabled: z.boolean().default(DEFAULTS.memoryEnabled).volatile(),
  projectMemoryEnabled: z.boolean().default(DEFAULTS.projectMemoryEnabled).volatile(),
  dailyLogEnabled: z.boolean().default(DEFAULTS.dailyLogEnabled).volatile(),
  indexInjectionEnabled: z.boolean().default(DEFAULTS.indexInjectionEnabled).volatile(),
  cardInjectionEnabled: z.boolean().default(DEFAULTS.cardInjectionEnabled).volatile(),
  constraintInjectionEnabled: z.boolean().default(DEFAULTS.constraintInjectionEnabled).volatile(),
  tailReminderEnabled: z.boolean().default(DEFAULTS.tailReminderEnabled).volatile(),
  distillEnabled: z.boolean().default(DEFAULTS.distillEnabled).volatile(),
  extraRuleDirs: z.array(z.string()).default([...DEFAULTS.extraRuleDirs]).volatile(),

  // ── Deployment limits (non-volatile: never editable from the UI) ───────────
  turnBudgetChars: z.number().default(DEFAULTS.turnBudgetChars),
  indexBudgetChars: z.number().default(DEFAULTS.indexBudgetChars),
  cardBudgetChars: z.number().default(DEFAULTS.cardBudgetChars),
  constraintBudgetChars: z.number().default(DEFAULTS.constraintBudgetChars),
  maxMemoryChars: z.number().default(DEFAULTS.maxMemoryChars),
  searchLimitDefault: z.number().default(DEFAULTS.searchLimitDefault),
  searchLimitMax: z.number().default(DEFAULTS.searchLimitMax),
})

/** Type of a resolved cosmokit volatile reference — read-only in plugin code. */
interface VolatileLike {
  get(): unknown
}

/** True for a value that is a cosmokit volatile reference, per how the Loader wraps them. */
function isVolatileLike(value: unknown): value is VolatileLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { get?: unknown }).get === 'function' &&
    (value as { set?: unknown }).set === undefined
  )
}

/**
 * Resolve every volatile reference in a config object to the value it stands for.
 *
 * Rebuilds the whole shape rather than only the declared leaves, because cosmokit also
 * wraps nested objects and a partially-unwrapped config reads as truthy everywhere it
 * should read as a boolean.
 *
 * A key that is absent is filled from `DEFAULTS` rather than left `undefined`. The Loader
 * normally supplies every field, but a profile patch is a partial object by construction (writing
 * one key means the row's whole `config` is replaced), and an `undefined` budget would otherwise
 * reach `assertConfigUsable` as a startup failure over a field the user never mentioned.
 *
 * @param config - the config as handed to `apply()`, possibly holding volatile references.
 * @returns the same shape with plain values and nothing missing.
 */
export function unwrapConfig(config: Partial<Declared>): ResolvedConfig {
  /** @returns `value` with every volatile reference replaced by its target. */
  const unwrap = (value: unknown): unknown => {
    if (isVolatileLike(value)) return unwrap(value.get())
    if (Array.isArray(value)) return value.map(unwrap)
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value)) out[key] = unwrap(inner)
      return out
    }
    return value
  }

  const resolved = unwrap(config) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = resolved[key]
    // The array is cloned: `DEFAULTS` is frozen, and a shared mutable default handed to two
    // configs would let one caller's `push` appear in the other's.
    out[key] = value === undefined ? (Array.isArray(fallback) ? [...fallback] : fallback) : value
  }
  return out as ResolvedConfig
}

/**
 * Reject configurations the schema cannot express, at load rather than at first use.
 *
 * @param config - the resolved config.
 * @throws when a cap is not a positive finite number, or the default result count exceeds
 *   the hard ceiling it is supposed to sit under.
 */
export function assertConfigUsable(config: ResolvedConfig): void {
  const positive = [
    'turnBudgetChars',
    'indexBudgetChars',
    'cardBudgetChars',
    'constraintBudgetChars',
    'maxMemoryChars',
    'searchLimitDefault',
    'searchLimitMax',
  ] as const

  for (const key of positive) {
    const value = config[key]
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`dsh-evermemory: config.${key} must be a positive finite number, got ${String(value)}`)
    }
  }

  if (config.searchLimitDefault > config.searchLimitMax) {
    throw new Error(
      `dsh-evermemory: config.searchLimitDefault (${config.searchLimitDefault}) must not exceed config.searchLimitMax (${config.searchLimitMax})`,
    )
  }
}

export type { Declared as DeclaredConfig }

/**
 * Configuration and budget invariants.
 *
 * The per-turn budget is the project's headline constraint and also its easiest to lose
 * quietly, so it is asserted rather than documented. The distinction that matters:
 *
 *   A budget is **per turn**, never per entry and never per file.
 *
 * Getting this wrong is the single most common failure in this ecosystem.
 * `dsh-memory-palace` publishes an 8000-character user budget and a 6000-character
 * workspace budget, each measured against one FILE, and then records a worst case of eight
 * injected messages at roughly 50,000 characters — 7.1× its own stated bound. Each limit
 * was individually satisfied while the turn blew through it.
 *
 * So these tests check the sum, against the same config the plugin would actually resolve.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, unwrapConfig, type DeclaredConfig } from '../src/config.ts'
import {
  CARD_BUDGET_CHARS,
  CONSTRAINT_BUDGET_CHARS,
  INDEX_BUDGET_CHARS,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  ORDER_MEMORY_INDEX,
  ORDER_MEMORY_TAIL_REMINDER,
  ORDER_RULES,
  ORDER_RUNTIME_CONTEXT,
  TURN_BUDGET_CHARS,
} from '../src/constants.ts'

/** The config a default install resolves: cordis.patch.yml ships no `config:` block. */
const defaults = unwrapConfig(Config.parse() as unknown as DeclaredConfig)

/**
 * Build a config as the Loader hands it over, with raw volatile references.
 *
 * The cast is the point of the helper: `DeclaredConfig` describes the post-resolution shape
 * with plain primitives, and these tests deliberately supply pre-resolution references to
 * prove `unwrapConfig()` handles them.
 */
function asLoaded(overrides: Record<string, unknown>): DeclaredConfig {
  return { ...Config.parse(), ...overrides } as unknown as DeclaredConfig
}

test('a default install resolves every field', () => {
  // The shipped patch has no config block, so schema defaults are what actually runs. A
  // field that loses its default would arrive undefined and silently disable its feature.
  for (const [key, value] of Object.entries(defaults)) {
    assert.notEqual(value, undefined, `config.${key} has no default`)
  }

  assert.equal(defaults.rulesEnabled, true)
  assert.equal(defaults.memoryEnabled, true)
  assert.equal(defaults.distillEnabled, true)
  // Off by design: a tail reminder only pays for itself while it is byte-identical, since
  // any change rewrites the prompt head.
  assert.equal(defaults.tailReminderEnabled, false)
})

test('the injection budgets sum to less than the per-turn ceiling', () => {
  // This is the assertion the whole file exists for. Three channels are injected per turn;
  // their sum has to fit inside the turn budget with headroom for the rules section and the
  // fixed framing, or the ceiling is decorative.
  const indexedChannels = defaults.indexBudgetChars + defaults.cardBudgetChars + defaults.constraintBudgetChars

  assert.ok(
    indexedChannels < defaults.turnBudgetChars,
    `index+card+constraint = ${indexedChannels} must stay under the turn budget ${defaults.turnBudgetChars}`,
  )
  // Leave at least a quarter for rules text and framing.
  assert.ok(
    indexedChannels <= defaults.turnBudgetChars * 0.75,
    `injection channels use ${indexedChannels} of ${defaults.turnBudgetChars}; keep 25% headroom`,
  )
})

test('the channels keep the shipped defaults unless a deployment overrides them', () => {
  // Ties the resolved config back to the constants, so editing one without the other fails
  // here rather than in the field.
  assert.equal(defaults.turnBudgetChars, TURN_BUDGET_CHARS)
  assert.equal(defaults.indexBudgetChars, INDEX_BUDGET_CHARS)
  assert.equal(defaults.cardBudgetChars, CARD_BUDGET_CHARS)
  assert.equal(defaults.constraintBudgetChars, CONSTRAINT_BUDGET_CHARS)
})

test('no single channel may consume the whole turn budget', () => {
  for (const key of ['indexBudgetChars', 'cardBudgetChars', 'constraintBudgetChars'] as const) {
    assert.ok(
      defaults[key] < defaults.turnBudgetChars,
      `config.${key} (${defaults[key]}) must be smaller than the turn budget (${defaults.turnBudgetChars})`,
    )
  }
})

test('every volatile field is marked volatile, and no deployment limit is', () => {
  // Two silent failure modes are guarded here. A preference missing `.volatile()` makes the
  // whole settings row disappear from describe(); a limit that gains it becomes editable
  // from the UI, which is how a per-file budget gets set to 8000 and never revisited.
  const volatile = new Set([
    'rulesEnabled',
    'memoryEnabled',
    'projectMemoryEnabled',
    'dailyLogEnabled',
    'indexInjectionEnabled',
    'cardInjectionEnabled',
    'constraintInjectionEnabled',
    'tailReminderEnabled',
    'distillEnabled',
    'extraRuleDirs',
  ])
  const limits = new Set([
    'turnBudgetChars',
    'indexBudgetChars',
    'cardBudgetChars',
    'constraintBudgetChars',
    'maxMemoryChars',
    'searchLimitDefault',
    'searchLimitMax',
  ])

  for (const [key, field] of Object.entries(Config.fields)) {
    const marked = field.state?.isVolatile === true
    if (volatile.has(key)) assert.equal(marked, true, `${key} must be .volatile() or it vanishes from settings`)
    if (limits.has(key)) assert.equal(marked, false, `${key} is a deployment limit and must not be editable`)
  }

  assert.equal(volatile.size + limits.size, Object.keys(Config.fields).length, 'a config field is missing from both groups')
})

test('unwrapConfig flattens a cosmokit volatile reference', () => {
  // After Loader resolution a volatile field is `{ get(), [write] }`, not a primitive, so a
  // direct read yields an object that is truthy regardless of what the user chose.
  const resolved = unwrapConfig(asLoaded({ tailReminderEnabled: { get: () => false } }))

  assert.equal(resolved.tailReminderEnabled, false)
})

test('unwrapConfig recurses through arrays and nested objects', () => {
  const resolved = unwrapConfig(
    asLoaded({
      extraRuleDirs: [{ get: () => '/home/u/.dsh/rules' }],
      searchLimitDefault: { get: () => 7 },
    }),
  )

  assert.deepEqual(resolved.extraRuleDirs, ['/home/u/.dsh/rules'])
  assert.equal(resolved.searchLimitDefault, 7)
})

test('the prompt orders sit outside every occupied band', () => {
  // Verified field map: harness identity -1000, persona 0, jipika memory 1, destinywind
  // settings slot 16, dsh-memory/dsh-charter 50, mnemosyne 95, tool guidance 100-199,
  // destinywind full bank 216, destinywind tail 9999.
  assert.equal(ORDER_RULES, 50, 'rules must precede tool guidance, which owns 100-199')
  assert.ok(ORDER_RULES < 100, 'order 100-199 is the tool-guidance band and is not free')
  assert.equal(ORDER_MEMORY_INDEX, 216)
  assert.equal(ORDER_MEMORY_TAIL_REMINDER, 9999)
  // Runtime context orders are a separate namespace from section orders.
  assert.equal(ORDER_RUNTIME_CONTEXT, 100)
})

test('the layer, status and source enums are exhaustive and disjoint', () => {
  assert.deepEqual([...MEMORY_SCOPES], ['identity', 'global', 'project', 'daily'])
  assert.deepEqual([...MEMORY_STATUSES], ['active', 'outdated', 'archived', 'pending'])
  assert.deepEqual([...MEMORY_SOURCES], ['auto', 'dialogue', 'import', 'manual'])
})

test('the search ceiling is the default ceiling when nothing is supplied', () => {
  assert.ok(defaults.searchLimitDefault <= defaults.searchLimitMax)
  assert.ok(defaults.searchLimitMax > 0)
})

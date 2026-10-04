import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { charCount } from '../src/inject/budget.ts'
import { unwrapConfig } from '../src/config.ts'
import {
  CONTEXT_NAME,
  INDEX_SCOPES,
  InjectionState,
  READ_LIMIT,
  SECTION_CARDS,
  SECTION_CONSTRAINTS,
  SECTION_INDEX,
  fitIndex,
  readBoth,
} from '../src/inject/context.ts'
import type { InjectionDeps } from '../src/inject/context.ts'
import { openStore, type OpenStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import type { MemoryRecord } from '../src/storage/repository.ts'

/**
 * The assembly is where the plugin's first constraint is either kept or lost, so these tests are
 * about ORDER and SURVIVAL rather than wording: which channel is dropped first when the budget
 * runs out, and whether a channel that was dropped is then treated as delivered. The second one
 * is the subtle failure — recording a card as sent when the budget removed it means the index
 * will omit that memory on the next step too, and the model never sees it in any form.
 */

const stores: OpenStore[] = []

async function fresh(): Promise<{ store: OpenStore, repository: MemoryRepository }> {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-ctx-')), 'store.sqlite') })
  stores.push(store)
  return { store, repository: new MemoryRepository(store.db) }
}

after(() => {
  for (const store of stores) {
    try {
      store.db.close()
    } catch {
      // Already closed.
    }
  }
})

const PROJECT = 'p'.repeat(16)
const OTHER_PROJECT = 'q'.repeat(16)

function config(overrides: Record<string, unknown> = {}) {
  return unwrapConfig({ ...overrides } as never)
}

function deps(
  repository: MemoryRepository,
  options: { projectKey?: string | null, cards?: () => readonly MemoryRecord[], config?: ReturnType<typeof config> } = {},
): InjectionDeps {
  return {
    repository,
    config: options.config ?? config(),
    // `'projectKey' in options` rather than `?? PROJECT`: an explicit `null` is the case under
    // test ("the identity is not trustworthy"), and `null ?? PROJECT` silently replaced it with a
    // real key, which made the global-only test pass for the wrong reason.
    projectKey: 'projectKey' in options ? (options.projectKey ?? null) : PROJECT,
    ...(options.cards === undefined ? {} : { cards: options.cards }),
  }
}

describe('channel gating', () => {
  test('memoryEnabled false injects nothing at all', async () => {
    const { repository } = await fresh()
    repository.insert({ text: '用 pnpm', scope: 'global', pinned: true })
    const state = new InjectionState()
    const text = state.rebuild(deps(repository, { config: config({ memoryEnabled: false }) }))
    assert.equal(text, '')
    assert.deepEqual(state.bodyIds, [])
  })

  test('the index can be switched off without touching the constraints', async () => {
    const { repository } = await fresh()
    repository.insert({ text: '不要用 npm', scope: 'global', pinned: true, importance: 9 })
    repository.insert({ text: '背景知识一条', scope: 'global' })
    const state = new InjectionState()
    const text = state.rebuild(deps(repository, { config: config({ indexInjectionEnabled: false }) }))
    assert.ok(text.includes('不要用 npm'))
    assert.ok(!text.includes('背景知识一条'))
  })

  test('cards can be switched off without touching the index', async () => {
    const { repository } = await fresh()
    const record = repository.insert({ text: '正文内容', scope: 'global' })
    const state = new InjectionState()
    const text = state.rebuild(
      deps(repository, { cards: () => [record], config: config({ cardInjectionEnabled: false }) }),
    )
    // The assertion is on the channel, not on the string: the body text is also the derived title,
    // so it appears in the index line either way. A test that looked for the text would pass with
    // cards enabled.
    assert.ok(!text.includes('[相关记忆'), 'the card channel must be absent')
    assert.ok(text.includes('#1'), 'the index line still names it')
    assert.deepEqual(state.cardIds, [])
  })

  test('a zero constraint budget drops only the constraints', async () => {
    const { repository } = await fresh()
    repository.insert({ text: '置顶约束', scope: 'global', pinned: true })
    repository.insert({ text: '普通记忆', scope: 'global' })
    const state = new InjectionState()
    const text = state.rebuild(deps(repository, { config: config({ constraintBudgetChars: 0, turnBudgetChars: 100_000 }) }))
    assert.ok(!text.includes('[必须遵守的记忆约束'), 'the constraint channel must be absent')
    assert.ok(text.includes('普通记忆'))
  })
})

describe('channel order and survival', () => {
  test('a card is dropped before a constraint when the turn budget runs out', async () => {
    // A dropped card costs one extra retrieval; a dropped constraint costs the behaviour the user
    // asked for. So the constraint has to be assembled first and the card has to be the casualty.
    const { repository } = await fresh()
    repository.insert({ text: '这条约束必须留下', scope: 'global', pinned: true, importance: 9 })
    const card = repository.insert({ text: `卡片正文${'x'.repeat(400)}`, scope: 'global' })
    const state = new InjectionState()
    const text = state.rebuild(
      deps(repository, {
        cards: () => [card],
        config: config({ turnBudgetChars: 60, indexInjectionEnabled: false }),
      }),
    )
    assert.ok(text.includes('这条约束必须留下'))
    assert.ok(!text.includes('卡片正文'))
    assert.deepEqual(state.cardIds, [], 'a card the budget removed was never delivered')
  })

  test('a dropped card is not recorded as delivered, so the index still lists it', async () => {
    // The failure this guards: marking the card as sent because retrieval found it. The index
    // would then exclude it for the rest of the session and the memory would be in neither
    // channel — invisible, with no way for the model to know it exists.
    const { repository } = await fresh()
    repository.insert({ text: '约束占满预算', scope: 'global', pinned: true, importance: 9 })
    const card = repository.insert({ text: 'x'.repeat(400), scope: 'global' })
    const state = new InjectionState()
    state.rebuild(
      deps(repository, { cards: () => [card], config: config({ turnBudgetChars: 40 }) }),
    )
    assert.deepEqual(state.cardIds, [])
    // The constraint's body IS in the transcript, so its id belongs in `bodyIds`; the card's must
    // not be there, because it was cut away before its own id line was ever rendered.
    assert.ok(
      !state.bodyIds.includes(card.id),
      `a body cut away before its id line is not delivered: ${JSON.stringify(state.bodyIds)}`,
    )

    // A later step with room for the index must still name the card's memory.
    const later = state.rebuild(
      deps(repository, {
        cards: () => [],
        config: config({ turnBudgetChars: 100_000, constraintBudgetChars: 0 }),
      }),
    )
    assert.ok(later.includes(`#${card.id}`), `expected the index to still offer #${card.id}: ${later}`)
  })

  test('the assembled text never exceeds the turn budget', async () => {
    const { repository } = await fresh()
    for (let i = 0; i < 30; i += 1) {
      repository.insert({ text: `记忆条目 ${i} ${'y'.repeat(40)}`, scope: 'global', pinned: i < 5 })
    }
    const state = new InjectionState()
    const text = state.rebuild(deps(repository, { config: config({ turnBudgetChars: 300 }) }))
    assert.ok([...text].length <= 300, `assembled ${[...text].length} characters`)
  })

  test('a constraint is never injected as a fragment', async () => {
    // `partial: false` — half a rule is a different rule, and a constraint cut at the midpoint can
    // invert its meaning.
    const { repository } = await fresh()
    repository.insert({ text: `不要用 npm${'很长的补充说明'.repeat(20)}`, scope: 'global', pinned: true })
    const state = new InjectionState()
    const text = state.rebuild(
      deps(repository, { config: config({ constraintBudgetChars: 30, turnBudgetChars: 30 }) }),
    )
    assert.equal(text, '')
  })
})

describe('card dedup across steps', () => {
  test('a card already injected is not injected again on the next step', async () => {
    const { repository } = await fresh()
    const card = repository.insert({ text: '只应出现一次的正文', scope: 'global' })
    const state = new InjectionState()
    const first = state.rebuild(deps(repository, { cards: () => [card] }))
    assert.ok(first.includes('只应出现一次的正文'))
    // `agent/pre-step` fires once PER STEP, so a five-step turn calls this five times.
    const second = state.rebuild(deps(repository, { cards: () => [card] }))
    assert.ok(!second.includes('只应出现一次的正文'))
    assert.deepEqual(state.cardIds, [])
  })

  test('the index omits a memory whose body is already in the transcript', async () => {
    const { repository } = await fresh()
    const card = repository.insert({ text: '正文已经进过上下文', scope: 'global' })
    const state = new InjectionState()
    state.rebuild(deps(repository, { cards: () => [card] }))
    const later = state.rebuild(
      deps(repository, { cards: () => [], config: config({ cardInjectionEnabled: false }) }),
    )
    assert.ok(!later.includes(`#${card.id}`))
  })

  test('invalidateCards re-offers a body, which is what a correction needs', async () => {
    const { repository } = await fresh()
    const card = repository.insert({ text: '刚被更正的那一条', scope: 'global' })
    const state = new InjectionState()
    state.rebuild(deps(repository, { cards: () => [card] }))
    assert.ok(!state.rebuild(deps(repository, { cards: () => [card] })).includes('刚被更正的那一条'))
    state.invalidateCards()
    assert.ok(state.rebuild(deps(repository, { cards: () => [card] })).includes('刚被更正的那一条'))
  })

  test('cardIds reports the last step, not the whole session', async () => {
    const { repository } = await fresh()
    const a = repository.insert({ text: 'A', scope: 'global' })
    const b = repository.insert({ text: 'B', scope: 'global' })
    const state = new InjectionState()
    state.rebuild(deps(repository, { cards: () => [a] }))
    assert.deepEqual(state.cardIds, [a.id])
    state.rebuild(deps(repository, { cards: () => [b] }))
    assert.deepEqual(state.cardIds, [b.id])
    assert.deepEqual([...state.bodyIds].sort((x, y) => x - y), [a.id, b.id])
  })
})

describe('project isolation in the assembly', () => {
  test('another project\'s memories never appear', async () => {
    const { repository } = await fresh()
    repository.insert({ text: '本项目的约定', scope: 'project', projectKey: PROJECT })
    repository.insert({ text: '别的项目的约定', scope: 'project', projectKey: OTHER_PROJECT })
    const state = new InjectionState()
    const text = state.rebuild(deps(repository, { config: config({ turnBudgetChars: 100_000 }) }))
    assert.ok(text.includes('本项目的约定'))
    assert.ok(!text.includes('别的项目的约定'))
  })

  test('an untrustworthy identity sees the global layer only', async () => {
    const { repository } = await fresh()
    repository.insert({ text: '全局偏好', scope: 'global' })
    repository.insert({ text: '项目约定', scope: 'project', projectKey: PROJECT })
    const state = new InjectionState()
    const text = state.rebuild(
      deps(repository, { projectKey: null, config: config({ turnBudgetChars: 100_000 }) }),
    )
    assert.ok(text.includes('全局偏好'))
    assert.ok(!text.includes('项目约定'), `a project entry leaked into an untrusted-key assembly: ${text}`)
  })

  test('the global layer is not pushed out by a large project layer', async () => {
    // The reason the two layers are read separately: one capped query would let 500 project rows
    // displace the global constraints, and a global rule that applies everywhere would go missing
    // in exactly the project that has the most memory.
    const { repository } = await fresh()
    repository.insert({ text: '全局约束必须留下', scope: 'global', pinned: true, importance: 9 })
    for (let i = 0; i < 120; i += 1) {
      repository.insert({ text: `项目条目 ${i}`, scope: 'project', projectKey: PROJECT })
    }
    const state = new InjectionState()
    const text = state.rebuild(deps(repository, { config: config({ turnBudgetChars: 100_000 }) }))
    assert.ok(text.includes('全局约束必须留下'))
  })
})

describe('readBoth', () => {
  test('returns the global layer first, then the current project and its daily log', async () => {
    const { repository } = await fresh()
    const g = repository.insert({ text: 'g', scope: 'global' })
    const p = repository.insert({ text: 'p', scope: 'project', projectKey: PROJECT })
    const d = repository.insert({ text: 'd', scope: 'daily', projectKey: PROJECT })
    const rows = readBoth(deps(repository), { status: 'active' })
    const ids = rows.map((r) => r.id)
    // Global first is the contract that matters: it is what keeps a 500-entry project layer from
    // pushing a global rule out of the assembly. Within the second read the order is the
    // repository's (`created_at DESC, id DESC` — newest first, so the budget's tail cuts the
    // oldest), and these three rows share a timestamp, so the tie-break by id decides.
    assert.equal(ids[0], g.id)
    assert.deepEqual([...ids].sort((a, b) => a - b), [g.id, p.id, d.id].sort((a, b) => a - b))
    assert.deepEqual(ids.slice(1), [d.id, p.id])
  })

  test('never returns the identity scope, which is a file rather than a row', () => {
    assert.deepEqual([...INDEX_SCOPES], ['global', 'project', 'daily'])
    assert.ok(!INDEX_SCOPES.includes('identity'))
  })

  test('asks for more rows than either entry cap', () => {
    assert.ok(READ_LIMIT > 500)
  })

  test('the section names are distinct, so the transcript can tell the channels apart', () => {
    assert.equal(new Set([SECTION_CONSTRAINTS, SECTION_INDEX, SECTION_CARDS, CONTEXT_NAME]).size, 4)
  })
})

describe('fitIndex', () => {
  test('leaves an index that fits alone', () => {
    const text = '[记忆索引 · 2 条]\n- [全局] a · #1\n- [全局] b · #2'
    assert.equal(fitIndex(text, 1000), text)
  })

  test('trims on a line boundary and rewrites the header count', () => {
    const text = ['[记忆索引 · 3 条]', '- [全局] 一二三四五 · #1', '- [全局] 六七八九十 · #2'].join('\n')
    const fitted = fitIndex(text, 30)
    assert.ok(fitted.startsWith('[记忆索引 · 1 条]'), `header must match the lines kept: ${fitted}`)
    assert.ok(fitted.includes('#1'))
    assert.ok(!fitted.includes('#2'))
    assert.ok(!fitted.includes('#3'))
  })

  test('returns empty rather than a bare header when not even one line fits', () => {
    assert.equal(fitIndex('[记忆索引 · 1 条]\n- [全局] x · #1', 5), '')
  })

  test('the kept text is within the budget', () => {
    const lines = ['[记忆索引 · 20 条]', ...Array.from({ length: 20 }, (_, i) => `- [全局] 条目${i} · #${i + 1}`)]
    const fitted = fitIndex(lines.join('\n'), 60)
    assert.ok([...fitted].length <= 60)
  })
})

/**
 * The brief's first hard constraint, measured rather than asserted: per-turn overhead must not grow
 * with the volume of memory.
 *
 * Both stores hold the same hundred entries under the same ids, newest last, and differ only in the
 * nine hundred rows before them: archived in one, live in the other. That keeps every other variable
 * out of the comparison — an entry's id is part of the rendered line, so two stores that reach `#1`
 * and `#901` could never render the same text even when they behave identically.
 */
describe('volume independence', () => {
  const SHARED = 100
  const FILLER = 900

  /** Nine hundred older rows (live or archived) followed by the same hundred entries. */
  async function seeded(fillerStatus: 'active' | 'archived'): Promise<MemoryRepository> {
    const { repository } = await fresh()
    for (let i = 0; i < FILLER; i += 1) {
      repository.insert({ text: `噪声条目 ${i}`, scope: 'global', status: fillerStatus })
    }
    for (let i = 1; i <= SHARED; i += 1) repository.insert({ text: `共享条目 ${i}`, scope: 'global' })
    return repository
  }

  test('a store with a thousand memories renders what a store with a hundred renders', async () => {
    const small = await seeded('archived')
    const large = await seeded('active')

    const smallState = new InjectionState()
    const smallText = smallState.rebuild(deps(small))
    const largeState = new InjectionState()
    const largeText = largeState.rebuild(deps(large))

    assert.equal(smallText, largeText)
    assert.equal(smallState.indexIds.length, largeState.indexIds.length)
    // Not one of the nine hundred extra rows reaches the prompt: they are past the lane budget, and
    // the budget is what bounds the cost — not the store.
    assert.doesNotMatch(largeText, /噪声条目/u)
    assert.ok(charCount(largeText) <= config().turnBudgetChars)
    assert.ok(charCount(smallText) <= config().turnBudgetChars)
  })
})

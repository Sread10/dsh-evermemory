import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  TRUNCATION_MARKER,
  applyBudget,
  charCount,
  clampChars,
  clampToTurnBudget,
  describeBudget,
  joinWithinBudget,
  truncateChars,
} from '../src/inject/budget.ts'
import { DEFAULT_MAX_TRACKED, SessionCards } from '../src/inject/dedup.ts'

/**
 * The budget is the constraint the whole plugin is judged on, so these tests concentrate on the
 * two ways a budget stops being one: a section that is quietly re-added after the cap, and a
 * clamp that counts UTF-16 units instead of characters (which would halve every Chinese budget).
 */

describe('character counting', () => {
  test('counts code points, not UTF-16 units', () => {
    // A Chinese character is one code point and three UTF-16 units. `String.length` would report
    // 3, and every budget in the plugin would then be three times larger than configured for
    // exactly the text this plugin is built for.
    assert.equal(charCount('记忆'), 2)
    assert.equal('记忆'.length, 2)
    assert.equal(charCount('a'), 1)
    assert.equal(charCount(''), 0)
    assert.equal(charCount('🧠'), 1)
  })

  test('truncates by code point without splitting a surrogate pair', () => {
    assert.equal(truncateChars('🧠🧠', 1), '🧠')
    assert.equal(truncateChars('abc', 0), '')
    assert.equal(truncateChars('abc', 99), 'abc')
  })
})

describe('clamping', () => {
  test('leaves text that fits alone', () => {
    assert.equal(clampChars('short', 10), 'short')
  })

  test('counts the marker against the budget', () => {
    const text = 'a'.repeat(100)
    const clamped = clampChars(text, 20)
    assert.equal(charCount(clamped), 20)
    assert.ok(clamped.endsWith(TRUNCATION_MARKER))
  })

  test('cuts on a line boundary when one is near the end', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}`
    const clamped = clampChars(text, 40)
    assert.ok(clamped.startsWith('a'.repeat(30)))
    assert.ok(!clamped.includes('b'))
    assert.ok(clamped.endsWith(TRUNCATION_MARKER))
  })

  test('does not cut on a boundary that throws the allowance away', () => {
    // The break is early in the allowance, so honouring it would leave most of the budget unused.
    const text = `a\n${'b'.repeat(80)}`
    const clamped = clampChars(text, 40)
    assert.ok(clamped.startsWith('a\nbbb'))
  })

  test('a budget smaller than the marker still yields the marker, bounded', () => {
    const clamped = clampChars('whatever', 2)
    assert.equal(charCount(clamped), 2)
  })
})

describe('budget application', () => {
  test('keeps sections in order until the budget runs out', () => {
    const result = applyBudget(
      [
        { name: 'a', text: 'x'.repeat(10), partial: false },
        { name: 'b', text: 'y'.repeat(10), partial: false },
        { name: 'c', text: 'z'.repeat(10), partial: false },
      ],
      25,
    )
    assert.equal(result.usedChars, 22)
    assert.ok(result.text.includes('x'))
    assert.ok(result.text.includes('y'))
    assert.ok(!result.text.includes('z'))
    assert.deepEqual(
      result.outcomes.map((o) => [o.name, o.dropped]),
      [['a', false], ['b', false], ['c', true]],
    )
  })

  test('drops a non-partial section whole rather than injecting half a rule', () => {
    // Half a rule is a DIFFERENT rule. A constraint cut at the midpoint may invert its meaning,
    // and the model has no way to tell that it is reading a fragment.
    const result = applyBudget([{ name: 'rule', text: 'x'.repeat(50), partial: false }], 10)
    assert.equal(result.text, '')
    assert.equal(result.outcomes[0]?.dropped, true)
  })

  test('truncates a partial section instead of dropping it', () => {
    const text = ['[索引 · 2 条]', `- ${'x'.repeat(40)}`, `- ${'y'.repeat(40)}`].join('\n')
    const result = applyBudget([{ name: 'list', text, partial: true }], 30)
    assert.equal(result.usedChars, 30)
    assert.equal(result.outcomes[0]?.truncated, true)
    assert.equal(result.outcomes[0]?.dropped, false)
    assert.ok(result.text.includes('已截断'), 'the marker is what tells the model it is reading a cut block')
  })

  test('a partial section cut down to less than one line is dropped, not truncated', () => {
    // A section with no complete line left in it is not a shorter section. What it produces is a
    // marker with a fragment of a heading attached — `[相关记忆 · 1 条 · 按相关度] …[已截断]` under
    // no entries — which spends budget announcing something the model cannot read.
    const result = applyBudget([{ name: 'card', text: '### [全局] 一条很长的标题 — #3\n正文', partial: true }], 8)
    assert.equal(result.text, '')
    assert.equal(result.outcomes[0]?.dropped, true)
    assert.equal(result.outcomes[0]?.keptChars, 0)
  })

  test('an empty section is reported as kept-empty, not dropped', () => {
    const result = applyBudget([{ name: 'empty', text: '   ', partial: false }], 10)
    assert.equal(result.text, '')
    assert.equal(result.outcomes[0]?.dropped, false)
    assert.equal(result.outcomes[0]?.keptChars, 0)
  })

  test('a zero budget injects nothing at all', () => {
    const result = applyBudget([{ name: 'a', text: 'x', partial: true }], 0)
    assert.equal(result.text, '')
    assert.equal(result.usedChars, 0)
  })

  test('the reported character count matches the text it reports on', () => {
    const result = applyBudget(
      [
        { name: 'a', text: '记忆索引', partial: false },
        { name: 'b', text: '卡片', partial: false },
      ],
      100,
    )
    assert.equal(result.usedChars, charCount(result.text))
  })
})

describe('the turn budget is a total, not a per-section cap', () => {
  test('clamps the assembled block', () => {
    const clamped = clampToTurnBudget('x'.repeat(100), 30)
    assert.equal(charCount(clamped), 30)
  })

  test('three sections each under their own cap can still exceed the turn budget', () => {
    // This is the invariant that a per-channel cap alone cannot give: 3 x 900 is over the turn
    // budget, and the sum is what the user pays.
    const sections = [0, 1, 2].map((n) => ({ name: `s${n}`, text: 'x'.repeat(900), partial: false }))
    const result = applyBudget(sections, 1000)
    assert.ok(result.usedChars <= 1000)
    assert.equal(result.outcomes.filter((o) => o.keptChars > 0).length, 1)
  })
})

describe('joinWithinBudget', () => {
  test('joins with a blank line and stops at the budget', () => {
    const joined = joinWithinBudget(['one', 'two', 'three'], 7)
    assert.ok(charCount(joined) <= 7)
  })

  test('skips empty sections rather than emitting blank lines', () => {
    assert.equal(joinWithinBudget(['', 'a', '   '], 100), 'a')
  })
})

describe('describeBudget', () => {
  test('names truncation and dropping', () => {
    const result = applyBudget(
      [
        { name: 'kept', text: 'abc', partial: false },
        { name: 'cut', text: ['[记忆索引 · 2 条]', `- ${'x'.repeat(40)}`, `- ${'y'.repeat(40)}`].join('\n'), partial: true },
        { name: 'gone', text: 'z'.repeat(50), partial: false },
      ],
      40,
    )
    const line = describeBudget(result)
    assert.ok(line.includes('kept: 3 chars'))
    assert.ok(line.includes('(truncated)'))
    assert.ok(line.includes('gone: dropped'))
  })

  test('says so when nothing was injected', () => {
    assert.equal(describeBudget(applyBudget([], 100)), 'nothing injected')
  })
})

describe('session card dedup', () => {
  test('filtering does not record on its own, because an offer is not a delivery', () => {
    // The budget decides later whether the card reaches the transcript. Recording at filter time
    // marked a memory as "already in context" when it never was, and the index — which excludes
    // delivered ids — then hid it too, leaving it in neither channel.
    const cards = new SessionCards()
    assert.deepEqual(cards.filter([{ id: 1 }, { id: 2 }]).map((c) => c.id), [1, 2])
    assert.equal(cards.size, 0)
    assert.deepEqual(cards.filter([{ id: 1 }, { id: 2 }]).map((c) => c.id), [1, 2])
  })

  test('a delivered card is not delivered again', () => {
    // `agent/pre-step` fires once PER STEP, so a five-step turn would otherwise inject the same
    // bodies five times.
    const cards = new SessionCards()
    const first = cards.filter([{ id: 1 }, { id: 2 }])
    cards.record(first.map((card) => card.id))
    assert.deepEqual(cards.filter([{ id: 1 }, { id: 3 }]).map((c) => c.id), [3])
  })

  test('recording makes an id visible to the ledger', () => {
    const cards = new SessionCards()
    cards.record([7])
    assert.equal(cards.has(7), true)
    assert.equal(cards.size, 1)
  })

  test('refresh forgets, which is what a correction needs', () => {
    const cards = new SessionCards()
    cards.record([1])
    cards.refresh()
    assert.deepEqual(cards.filter([{ id: 1 }]).map((c) => c.id), [1])
    assert.equal(cards.saturated, false)
  })

  test('offeredIds is the exclusion set the index uses', () => {
    const cards = new SessionCards()
    cards.record([4, 5])
    assert.deepEqual([...cards.offeredIds].sort((a, b) => a - b), [4, 5])
  })

  test('saturates instead of recycling ids', () => {
    // Re-offering a body the model already has is the repetition this class exists to prevent,
    // so hitting the cap must degrade to "a recent memory may repeat", never to "an old memory
    // reappears" — which recycling the set would cause.
    const cards = new SessionCards(2)
    cards.record([1, 2])
    assert.deepEqual(cards.filter([{ id: 3 }]).map((c) => c.id), [3])
    cards.record([3])
    assert.equal(cards.saturated, true)
    assert.equal(cards.size, 2)
    assert.deepEqual(cards.filter([{ id: 1 }]).map((c) => c.id), [])
  })

  test('the default cap is positive and finite', () => {
    assert.ok(Number.isInteger(DEFAULT_MAX_TRACKED) && DEFAULT_MAX_TRACKED > 0)
  })
})

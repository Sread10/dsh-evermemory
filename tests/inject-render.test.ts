import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CONSTRAINT_PREFIX,
  TITLE_MAX_CHARS,
  cardHeader,
  clampCardBody,
  constraintHeader,
  deriveTitle,
  indexHeader,
  renderCardLine,
  renderCards,
  renderConstraints,
  renderIndex,
  renderIndexLine,
  shortTitle,
  titleOf,
  toCardEntry,
  toIndexEntry,
} from '../src/inject/render.ts'
import type { MemoryRecord } from '../src/storage/repository.ts'

/**
 * Rendering is where the token budget is actually spent, so the assertions here are mostly about
 * SIZE rather than wording: a title that runs long is not a cosmetic problem, it is a budget
 * problem multiplied by the number of entries in the index.
 *
 * Rows are plain literals rather than database rows on purpose — the renderer takes a
 * `MemoryRecord` shape, and going through SQLite would test the repository instead of the
 * renderer. The one thing that must stay faithful to the real shape is `pinned`, which is a
 * BOOLEAN here, because the bug that reached production was a `pinned !== 0` test against a
 * boolean, which is true for every row.
 */
/**
 * A memory row, with only the fields a renderer test cares about spelled out.
 *
 * A helper rather than a cast: the renderer's contract is the `MemoryRecord` shape, and a test
 * that casts an object missing half of it stops noticing when the shape changes.
 */
function row(fields: Partial<MemoryRecord> & { id: number }): MemoryRecord {
  return {
    title: '',
    text: '',
    scope: 'global',
    projectKey: null,
    projectPath: null,
    subId: null,
    tags: [],
    source: 'manual',
    sourcePlatform: null,
    pinned: false,
    importance: 0,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    ...fields,
  }
}
describe('titles', () => {
  test('derives a title from the first line', () => {
    assert.equal(deriveTitle('第一行\n第二行'), '第一行')
  })

  test('strips list markers and heading marks', () => {
    assert.equal(deriveTitle('- 用 pnpm 管理依赖'), '用 pnpm 管理依赖')
    assert.equal(deriveTitle('## 项目约定'), '项目约定')
  })

  test('bounds the title by code points', () => {
    const title = shortTitle('记'.repeat(200))
    assert.ok([...title].length <= TITLE_MAX_CHARS + 1)
    assert.ok(title.endsWith('…'))
  })

  test('titleOf prefers the stored title and falls back to the body', () => {
    assert.equal(titleOf({ title: '显式标题', text: '正文第一行' }), '显式标题')
    assert.equal(titleOf({ title: '', text: '正文第一行' }), '正文第一行')
  })
})

describe('index lines', () => {
  test('an index line carries the id and the scope, and no body', () => {
    const entry = toIndexEntry(row({
      id: 42,
      scope: 'project',
      title: '用 pnpm',
      text: '这个项目用 pnpm 管理依赖，不要用 npm。',
      tags: ['tooling'],
      pinned: false,
    }))
    const line = renderIndexLine(entry)
    assert.ok(line.includes('#42'))
    assert.ok(line.includes('项目'))
    assert.ok(line.includes('用 pnpm'))
    assert.ok(!line.includes('不要用 npm'), 'the body must not be in the index')
  })

  test('a pinned entry is marked', () => {
    const line = renderIndexLine(
      toIndexEntry(row({ id: 1, scope: 'global', title: 't', text: 'x', tags: [], pinned: true })),
    )
    assert.ok(line.startsWith('- '))
    assert.ok(line.includes('★'))
  })

  test('an index of many memories stays proportional to titles, not bodies', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      toIndexEntry(row({
        id: i + 1,
        scope: 'global',
        title: `约定 ${i + 1}`,
        text: '正文'.repeat(500),
        tags: [],
        pinned: false,
      })),
    )
    const text = renderIndex(entries)
    assert.ok(text.length < 50 * 60, `index of 50 titles should stay small, got ${text.length}`)
  })

  test('excluded ids are absent, which is how a card suppresses its index line', () => {
    const entries = [1, 2, 3].map((id) =>
      toIndexEntry(row({ id, scope: 'global', title: `t${id}`, text: 'x', tags: [], pinned: false })),
    )
    const text = renderIndex(entries, { excludeIds: new Set([2]) })
    assert.ok(text.includes('#1'))
    assert.ok(!text.includes('#2'))
    assert.ok(text.includes('#3'))
  })

  test('the header states the count it actually rendered', () => {
    const entries = [1, 2].map((id) =>
      toIndexEntry(row({ id, scope: 'global', title: `t${id}`, text: 'x', tags: [], pinned: false })),
    )
    assert.ok(renderIndex(entries).startsWith('[记忆索引 · 2 条]'))
    assert.equal(indexHeader(7).includes('7'), true)
  })
})

describe('cards', () => {
  test('a card carries the body the index withheld', () => {
    const card = toCardEntry(row({
      id: 9,
      scope: 'project',
      title: '用 pnpm',
      text: '这个项目用 pnpm 管理依赖，不要用 npm。',
      tags: ['tooling'],
      pinned: false,
    }))
    const line = renderCardLine(card)
    assert.ok(line.includes('不要用 npm'))
    assert.ok(line.includes('#9'))
  })

  test('a card body is bounded and says it was cut', () => {
    const card = toCardEntry(row({ id: 1, scope: 'global', title: 't', text: 'x'.repeat(400), tags: [], pinned: false }))
    const clamped = clampCardBody(card, 100)
    assert.ok(clamped.text.length <= 100)
    assert.ok(clamped.text.includes('截断'))
  })

  test('a card body under the cap is untouched', () => {
    const card = toCardEntry(row({ id: 1, scope: 'global', title: 't', text: 'short', tags: [], pinned: false }))
    assert.equal(clampCardBody(card, 100).text, 'short')
  })

  test('cards render in the order given, because the order is the ranking', () => {
    const cards = [3, 1, 2].map((id) =>
      toCardEntry(row({ id, scope: 'global', title: `t${id}`, text: `body${id}`, tags: [], pinned: false })),
    )
    const text = renderCards(cards)
    assert.ok(text.indexOf('body3') < text.indexOf('body1'))
    assert.ok(text.indexOf('body1') < text.indexOf('body2'))
    assert.ok(text.startsWith('[相关记忆 · 3 条'))
  })
})

describe('constraints', () => {
  test('a constraint is the body with its prefix and nothing else', () => {
    const text = renderConstraints([
      toCardEntry(row({ id: 5, scope: 'project', title: 't', text: '不要用 npm', tags: ['a'], pinned: true })),
    ])
    assert.ok(text.includes(`${CONSTRAINT_PREFIX}不要用 npm`))
    assert.ok(!text.includes('#5'), 'a constraint is quoted, not cited — the id costs budget')
    assert.ok(!text.includes('[a]'))
  })

  test('the constraints header is its own channel, not the card header', () => {
    assert.notEqual(constraintHeader(1), cardHeader(1))
  })
})

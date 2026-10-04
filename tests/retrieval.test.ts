/**
 * Retrieval tests.
 *
 * These pin the behaviours that were MEASURED against SQLite rather than reasoned about, so
 * that a future "simplification" cannot quietly restore a bug that the measurements ruled out:
 *
 * - `trigram` returns nothing below three characters, silently, for CJK and Latin alike;
 * - raw user text passed to `MATCH` throws rather than degrading;
 * - the FTS index follows updates and deletes only because of the triggers;
 * - a project-scoped row must not be visible through another project's key.
 *
 * Real SQLite file per test, because every one of those lives inside SQLite.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { openStore, type OpenStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import { buildAllQuery, buildAnyQuery, quoteFtsFragment } from '../src/retrieval/fts.ts'
import { buildAllCondition, escapeLike } from '../src/retrieval/like.ts'
import { recencyScore, relevanceFromRank } from '../src/retrieval/rank.ts'
import { Retriever } from '../src/retrieval/retriever.ts'
import { MAX_FRAGMENTS, TRIGRAM_MIN_CHARS, tokenize } from '../src/retrieval/tokenize.ts'

/** Directories created by this file, removed on the way out. */
const roots: string[] = []

/** Fixed reference time, so ranking never reads the clock and the recency term is reproducible. */
const NOW = new Date('2026-06-15T12:00:00Z')

/**
 * Open a fresh store in its own temporary directory.
 *
 * @returns the open store.
 */
async function freshStore(): Promise<OpenStore> {
  const root = mkdtempSync(join(tmpdir(), 'evermemory-retrieval-'))
  roots.push(root)
  return openStore({ dshHome: root })
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('tokenize', () => {
  test('fuses adjacent CJK runs so they clear the trigram floor', () => {
    // '项目 约定' is two two-character fragments and would miss entirely; '项目约定' is four
    // characters and matches. A space between CJK words is typing noise, not a delimiter.
    assert.deepEqual(tokenize('项目 约定').map((fragment) => fragment.text), ['项目约定'])
    assert.deepEqual(tokenize('项目约定').map((fragment) => fragment.text), ['项目约定'])
    assert.equal(tokenize('项目约定')[0]?.kind, 'fts')
  })

  test('keeps Latin words apart, because fusing them would AND nothing', () => {
    // 'pnpm cache' fused would be one unmatchable phrase; kept apart they are two terms.
    assert.deepEqual(tokenize('pnpm cache').map((fragment) => fragment.text), ['pnpm', 'cache'])
  })

  test('routes by character count, not by whether the text is CJK', () => {
    // The two-character Latin case is the one a script-based router gets wrong.
    assert.equal(tokenize('缓存')[0]?.kind, 'like')
    assert.equal(tokenize('ab')[0]?.kind, 'like')
    assert.equal(tokenize('abc')[0]?.kind, 'fts')
    assert.equal(tokenize('缓存策略')[0]?.kind, 'fts')
    assert.equal(TRIGRAM_MIN_CHARS, 3)
  })

  test('splits on punctuation and records quotes', () => {
    const fragments = tokenize('"cache policy", pnpm')
    assert.deepEqual(fragments.map((fragment) => fragment.text), ['cache', 'policy', 'pnpm'])
    assert.deepEqual(fragments.map((fragment) => fragment.quoted), [true, true, false])
  })

  test('deduplicates and bounds the fragment count', () => {
    assert.deepEqual(tokenize('cache cache cache').map((f) => f.text), ['cache'])
    assert.equal(tokenize(Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')).length, 8)
  })

  test('cuts a Chinese sentence into windows, because a phrase query cannot match one', () => {
    // Measured against a store holding '构建缓存\n缓存放在 .cache 目录，CI 上要清空': searched as
    // one phrase this matched NOTHING, because a fragment is matched verbatim and Chinese arrives
    // without spaces. Every query in the sentence case grew a Latin term to match instead.
    assert.deepEqual(
      tokenize('构建缓存应该怎么处理').map((f) => f.text),
      ['构建缓', '建缓存', '缓存应', '存应该', '应该怎', '该怎么', '怎么处', '么处理'],
    )
    // A run that is already term-length stays whole, which is what keeps the fusion promise above.
    assert.deepEqual(tokenize('项目约定').map((f) => f.text), ['项目约定'])
    // And the sentence is still one AND query over the windows, so an exact store still answers
    // exactly — the windows exist for the store that knows only part of the question. FTS5 spells
    // an implicit AND as a space between phrases, which is why this counts spaces, not ' AND '.
    assert.equal(buildAllQuery(tokenize('构建缓存应该怎么处理'))?.match.split(' ').length, 8)
  })

  test('never cuts a quoted run or a Latin word', () => {
    // A quote is the user asking for that exact phrase, so cutting it would answer a question
    // nobody asked; a Latin word is already a term.
    const quoted = tokenize('"构建缓存应该怎么处理"')
    assert.deepEqual(quoted.map((f) => f.text), ['构建缓存应该怎么处理'])
    assert.equal(quoted[0]?.quoted, true)
    assert.deepEqual(tokenize('cache policy').map((f) => f.text), ['cache', 'policy'])
  })

  test('a sentence is still bounded by the fragment cap', () => {
    // Two characters per window of overlap means a sentence can produce many windows; the cap is
    // the same one every other fragment list obeys, so a long paste cannot become a long query.
    assert.equal(tokenize('这是一段足够长的中文句子用来测试片段上限').length, MAX_FRAGMENTS)
  })

  test('an empty or punctuation-only query yields nothing', () => {
    assert.deepEqual(tokenize(''), [])
    assert.deepEqual(tokenize('   ,,,  '), [])
  })
})

describe('query construction', () => {
  test('raw user text cannot reach MATCH unquoted', () => {
    // Each of these THROWS when passed straight to MATCH, measured: 'fts5: syntax error near
    // "OR"', 'unknown special query:', 'fts5: syntax error near "\'"'. Quoting makes each a
    // literal phrase instead, which is the entire reason this builder exists.
    assert.equal(quoteFtsFragment('OR'), '"OR"')
    assert.equal(quoteFtsFragment('*'), '"*"')
    assert.equal(quoteFtsFragment(`'`), `"'"`)
    assert.equal(quoteFtsFragment('NEAR('), '"NEAR("')
    // An internal quote is doubled, which FTS5 reads as an escaped quote inside the phrase.
    assert.equal(quoteFtsFragment('say "hi"'), '"say ""hi"""')
  })

  test('several fragments AND by default and can be relaxed to OR', () => {
    const fragments = tokenize('cache policy')
    assert.equal(buildAllQuery(fragments)?.match, '"cache" "policy"')
    assert.equal(buildAnyQuery(fragments)?.match, '"cache" OR "policy"')
  })

  test('a query with no fragment above the floor has no FTS query', () => {
    assert.equal(buildAllQuery(tokenize('ab')), undefined)
    assert.equal(buildAnyQuery(tokenize(' ab ')), undefined)
  })

  test('LIKE patterns escape the wildcards the user typed', () => {
    assert.equal(escapeLike('100%'), '100!%')
    assert.equal(escapeLike('a_b'), 'a!_b')
    assert.equal(escapeLike('!'), '!!')
    // Built from fragments directly rather than from `tokenize`, because tokenization strips
    // leading and trailing punctuation — `a_` trims to `a`, and `50%` to `50` — so an
    // underscore only ever reaches a pattern from inside a fragment.
    const built = buildAllCondition([
      { text: 'a_b', kind: 'like', quoted: false },
      { text: '50%', kind: 'like', quoted: false },
    ])
    assert.ok(built)
    assert.deepEqual(built.params, ['%a!_b%', '%a!_b%', '%50!%%', '%50!%%'])
    assert.equal(built.condition.split(' AND ').length, 2, 'one group per fragment')
  })

  test('tokenization strips the punctuation the escape rules exist for', () => {
    // Worth pinning because it is the reason an underscore survives into a pattern while a
    // trailing percent does not: trimming happens first, so `escapeLike` only ever sees
    // punctuation that was interior to a fragment.
    assert.deepEqual(tokenize('50%').map((fragment) => fragment.text), ['50'])
    assert.deepEqual(tokenize('a_b').map((fragment) => fragment.text), ['a_b'])
  })
})

describe('scoring', () => {
  test('a better FTS rank maps to a higher relevance', () => {
    // FTS5 ranks are negative and lower is better; the mapping must preserve that order.
    assert.ok(relevanceFromRank(-3) > relevanceFromRank(-0.5))
    assert.ok(relevanceFromRank(-0.5) > relevanceFromRank(0))
    assert.equal(relevanceFromRank(undefined), 0)
    assert.ok(relevanceFromRank(-3) >= 0 && relevanceFromRank(3) <= 1)
  })

  test('recency halves on the stated half-life and tolerates a missing timestamp', () => {
    assert.equal(recencyScore(null, NOW), 0)
    assert.equal(recencyScore('', NOW), 0)
    assert.equal(recencyScore('not a date', NOW), 0)
    assert.equal(recencyScore('2026-06-15 12:00:00.000', NOW), 1)
    // 14 days later, half. The space-separated UTC form is what the repository writes.
    assert.ok(Math.abs(recencyScore('2026-06-01 12:00:00.000', NOW) - 0.5) < 1e-9)
    // A future timestamp must not score above 1, which would let a clock skew outrank truth.
    assert.ok(recencyScore('2027-01-01 00:00:00.000', NOW) <= 1)
  })
})

describe('retriever', () => {
  test('finds a Chinese memory by a two-character query', async () => {
    // This is the case the whole retrieval design exists for: '缓存' is below the trigram
    // floor, so FTS returns zero rows for it with no error at all.
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const cached = repository.insert({ text: '这个项目约定使用前缀缓存，命中率要稳定', scope: 'global' })
      repository.insert({ text: '完全无关的一句话', scope: 'global' })

      const hits = new Retriever(store.db, repository).retrieve({ query: '缓存', now: NOW })
      assert.deepEqual(hits.map((hit) => hit.memory.id), [cached.id])
      assert.equal(hits[0]?.match, 'like')
    } finally {
      store.db.close()
    }
  })

  test('finds a Chinese memory by a four-character query through FTS', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const hit = repository.insert({ text: '索引优化减少Token消耗的句子', scope: 'global' })
      repository.insert({ text: '完全无关的一句话', scope: 'global' })

      const hits = new Retriever(store.db, repository).retrieve({ query: '索引优化', now: NOW })
      assert.deepEqual(hits.map((result) => result.memory.id), [hit.id])
      assert.equal(hits[0]?.match, 'fts')
    } finally {
      store.db.close()
    }
  })

  test('finds mixed-script content, which unicode61 could not do at all', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const hit = repository.insert({ text: '索引优化减少Token消耗的句子', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      assert.deepEqual(retriever.retrieve({ query: 'Token消耗', now: NOW }).map((r) => r.memory.id), [hit.id])
      assert.deepEqual(retriever.retrieve({ query: 'Token', now: NOW }).map((r) => r.memory.id), [hit.id])
    } finally {
      store.db.close()
    }
  })

  test('hostile query text returns results instead of throwing', async () => {
    // Each of these throws when interpolated into MATCH. A memory tool that dies on the word
    // "OR" is worse than one that finds nothing, because it takes the turn down with it.
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: '用 OR 连接条件，通配符是 * 号', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      for (const query of ['OR', '*', `'`, 'NEAR(', 'a AND b', 'project OR']) {
        assert.doesNotThrow(() => retriever.retrieve({ query, now: NOW }), `query ${JSON.stringify(query)}`)
      }
      // A quoted operator is searched for as text, which is what a user typing it means.
      assert.deepEqual(
        retriever.retrieve({ query: '通配符', now: NOW }).map((r) => r.memory.id),
        [repository.list({ scope: 'global' })[0]?.id],
      )
    } finally {
      store.db.close()
    }
  })

  test('finds a memory from the user\'s own sentence, which is how the card channel asks', async () => {
    // The card channel's query is the user's message, not keywords, and every one of these
    // sentences matched nothing until a long CJK run was cut into windows. The store is what
    // makes the second one a near miss rather than a match: it answers with the part it knows.
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const cache = repository.insert({
        text: '构建缓存\n缓存放在 .cache 目录，CI 上要清空',
        scope: 'global',
      })
      const tests = repository.insert({
        text: '测试要求\n提交前必须跑 npm test，不要跳过',
        scope: 'global',
      })
      repository.insert({ text: '完全无关的一句话', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      assert.deepEqual(
        retriever.retrieve({ query: '构建缓存应该怎么处理', now: NOW }).map((hit) => hit.memory.id),
        [cache.id],
      )
      // '提交前要不要跑测试' shares '提交前' with the memory and nothing longer, so the AND query
      // over the windows finds nothing and the OR retry is what answers. Reporting no knowledge
      // here would be the lie the retry exists to avoid.
      assert.deepEqual(
        retriever.retrieve({ query: '提交前要不要跑测试', now: NOW }).map((hit) => hit.memory.id),
        [tests.id],
      )
      // A sentence about a subject the store does not hold still matches nothing: the windows are
      // three characters, and '缓存' alone shares no window with anything here.
      assert.deepEqual(retriever.retrieve({ query: '这个项目的缓存策略是什么', now: NOW }), [])
    } finally {
      store.db.close()
    }
  })

  test('relaxes an over-strict AND to OR rather than reporting no knowledge', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const onlyCache = repository.insert({ text: '缓存策略要稳定', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      // Both fragments clear the floor, but no single row contains both, so the implicit AND
      // finds nothing. Reporting "no memory" here would be a lie about the store.
      const hits = retriever.retrieve({ query: '缓存策略 pnpm', now: NOW })
      assert.deepEqual(hits.map((hit) => hit.memory.id), [onlyCache.id])
    } finally {
      store.db.close()
    }
  })

  test('sees a memory edited in place and stops seeing a deleted one', async () => {
    // Only true because the update and delete triggers exist. Without them the index keeps
    // the old text forever and retrieval answers from a document that no longer exists.
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const edited = repository.insert({ text: '今天天气不错', scope: 'global' })
      const removed = repository.insert({ text: '这条记忆会被删除，关键词是独一无二的', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      repository.update(edited.id, { text: '今天天气很好，适合出门' })
      repository.remove(removed.id)

      assert.deepEqual(retriever.retrieve({ query: '适合出门', now: NOW }).map((r) => r.memory.id), [edited.id])
      assert.deepEqual(retriever.retrieve({ query: '不错', now: NOW }), [])
      assert.deepEqual(retriever.retrieve({ query: '独一无二的', now: NOW }), [])
    } finally {
      store.db.close()
    }
  })

  test('never returns another project\'s memory, in either match path', async () => {
    // A cross-project leak is the failure the ecosystem shipped twice, once in the read path
    // and again in the write path. Both match paths are checked because they are separate SQL.
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const mine = repository.insert({ text: '本项目的缓存约定', scope: 'project', projectKey: 'key-a' })
      const theirs = repository.insert({ text: '别的项目的缓存约定', scope: 'project', projectKey: 'key-b' })
      const shared = repository.insert({ text: '全局的缓存约定', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      for (const query of ['缓存约定', '缓存']) {
        const ids = retriever.retrieve({ query, projectKey: 'key-a', now: NOW }).map((r) => r.memory.id)
        assert.ok(ids.includes(mine.id), `${query}: own project row must be visible`)
        assert.ok(ids.includes(shared.id), `${query}: global row must be visible`)
        assert.ok(!ids.includes(theirs.id), `${query}: another project's row must not be visible`)
      }

      // With no project key, only the project-free layers are reachable.
      const global = retriever.retrieve({ query: '缓存约定', projectKey: null, now: NOW }).map((r) => r.memory.id)
      assert.deepEqual(global, [shared.id])
    } finally {
      store.db.close()
    }
  })

  test('ignores entries that are not active', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: '缓存约定已归档', scope: 'global', status: 'archived' })
      repository.insert({ text: '缓存约定待确认', scope: 'global', status: 'pending' })
      repository.insert({ text: '缓存约定已过时', scope: 'global', status: 'outdated' })
      repository.insert({ text: '缓存约定仍然有效', scope: 'global' })

      const hits = new Retriever(store.db, repository).retrieve({ query: '缓存约定', now: NOW })
      assert.deepEqual(hits.map((hit) => hit.memory.text), ['缓存约定仍然有效'])
    } finally {
      store.db.close()
    }
  })

  test('respects the limit and announces the match kind', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      for (let index = 0; index < 12; index += 1) {
        repository.insert({ text: `第 ${index} 条缓存约定`, scope: 'global' })
      }
      const retriever = new Retriever(store.db, repository)

      assert.equal(retriever.retrieve({ query: '缓存约定', now: NOW }).length, 10)
      assert.equal(retriever.retrieve({ query: '缓存约定', limit: 3, now: NOW }).length, 3)
      // Order must be total and reproducible, or the budget cap would drop a different row
      // on each call and the same question would get different answers.
      const first = retriever.retrieve({ query: '缓存约定', limit: 5, now: NOW }).map((r) => r.memory.id)
      const second = retriever.retrieve({ query: '缓存约定', limit: 5, now: NOW }).map((r) => r.memory.id)
      assert.deepEqual(first, second)
    } finally {
      store.db.close()
    }
  })

  test('prefers the row both paths agree on', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const both = repository.insert({ text: 'pnpm 缓存', scope: 'global' })
      const one = repository.insert({ text: '缓存', scope: 'global' })
      const retriever = new Retriever(store.db, repository)

      // 'pnpm' is 4 characters (FTS) and '缓存' is 2 (LIKE), so the row containing both is
      // found twice and must outrank the row found once.
      const hits = retriever.retrieve({ query: 'pnpm 缓存', now: NOW })
      assert.equal(hits[0]?.memory.id, both.id)
      assert.equal(hits[0]?.match, 'both')
      assert.ok(hits.some((hit) => hit.memory.id === one.id))
    } finally {
      store.db.close()
    }
  })

  test('an empty query is answered without touching the database', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: '缓存约定', scope: 'global' })
      const retriever = new Retriever(store.db, repository)
      assert.deepEqual(retriever.retrieve({ query: '', now: NOW }), [])
      assert.deepEqual(retriever.retrieve({ query: '   ', now: NOW }), [])
    } finally {
      store.db.close()
    }
  })
})

/**
 * Storage layer tests.
 *
 * These run against a REAL SQLite file, not a mock and not an in-memory handle. Three of the
 * behaviours under test — the FTS5 trigram tokenizer, `ON DELETE CASCADE`, and the
 * `user_version` migration counter — live inside SQLite and are invisible to any double. A
 * fake would agree with whatever this file assumed and prove nothing.
 *
 * Each test gets its own directory so that a failure cannot be explained by state left by an
 * earlier one, and so that the tests can run concurrently.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { MAX_MEMORY_CHARS } from '../src/constants.ts'
import { openStore, runAll, transaction, type OpenStore } from '../src/storage/db.ts'
import { applyMerge, planMerge } from '../src/storage/merge.ts'
import { displayPath, databasePath, storageDir } from '../src/storage/paths.ts'
import { MemoryRepository, normalizeTags, validateText } from '../src/storage/repository.ts'
import { SCHEMA_VERSION } from '../src/storage/schema.ts'
import { contradict, containment, similarity } from '../src/storage/similarity.ts'

/** Directories created by this file, removed on the way out. */
const roots: string[] = []

/**
 * Open a fresh store in its own temporary directory.
 *
 * @returns the open store.
 */
async function freshStore(): Promise<OpenStore> {
  const root = mkdtempSync(join(tmpdir(), 'evermemory-test-'))
  roots.push(root)
  return openStore({ path: join(root, 'test.sqlite') })
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('paths', () => {
  test('DSH_HOME relocates the whole store', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = 'C:\\custom-home'
    try {
      assert.equal(storageDir(), join('C:\\custom-home', 'evermemory'))
      assert.equal(databasePath(), join('C:\\custom-home', 'evermemory', 'evermemory.sqlite'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  test('an explicit dshHome beats the environment', () => {
    assert.equal(databasePath('D:\\explicit'), join('D:\\explicit', 'evermemory', 'evermemory.sqlite'))
  })

  test('displayPath abbreviates only the real home directory', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (home === '') return
    assert.ok(displayPath(join(home, 'a', 'b')).startsWith('~'))
    // A path that merely shares a prefix with home must not be abbreviated, or /home/user2
    // would display as ~2.
    assert.equal(displayPath('D:\\elsewhere\\file.txt'), 'D:\\elsewhere\\file.txt')
  })
})

describe('schema and migrations', () => {
  test('a fresh database is created at the current version', async () => {
    const store = await freshStore()
    try {
      assert.equal(store.version, SCHEMA_VERSION)
      assert.deepEqual(store.migrated, [1])
    } finally {
      store.db.close()
    }
  })

  test('reopening an existing database applies nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evermemory-test-'))
    roots.push(root)
    const path = join(root, 'reopen.sqlite')

    const first = await openStore({ path })
    first.db.close()

    const second = await openStore({ path })
    try {
      assert.deepEqual(second.migrated, [], 'an up-to-date database must not be migrated again')
      assert.equal(second.version, SCHEMA_VERSION)
    } finally {
      second.db.close()
    }
  })

  test('the FTS index is built by the trigram tokenizer', async () => {
    const store = await freshStore()
    try {
      // If the tokenizer were unicode61 this document would index as a single token and
      // neither query below would match.
      store.db
        .prepare('INSERT INTO memories (title, text, scope) VALUES (?, ?, ?)')
        .run('', '索引优化减少Token消耗的句子', 'global')

      const cjk = store.db
        .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH '\"索引优化\"'")
        .get() as { n: number }
      const latin = store.db
        .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH '\"Token消耗\"'")
        .get() as { n: number }
      assert.equal(cjk.n, 1, 'a partial CJK phrase must match')
      assert.equal(latin.n, 1, 'a mixed CJK/Latin phrase must match')
    } finally {
      store.db.close()
    }
  })

  test('a query below the trigram floor returns nothing rather than throwing', async () => {
    const store = await freshStore()
    try {
      store.db.prepare('INSERT INTO memories (title, text, scope) VALUES (?, ?, ?)').run('', '项目约定', 'global')
      // Two characters is below trigram's floor of three. The result is a silent zero, which
      // is exactly why the retriever must route by length rather than by script.
      const short = store.db
        .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH '\"项目\"'")
        .get() as { n: number }
      assert.equal(short.n, 0)
    } finally {
      store.db.close()
    }
  })

  test('deleting a memory cascades to its tags', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const record = repository.insert({ text: 'cascade check', scope: 'global', tags: ['a', 'b'] })
      assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n, 2)
      repository.remove(record.id)
      assert.equal(
        (store.db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n,
        0,
        'foreign keys must be enforced on the connection, not left to a PRAGMA nobody runs',
      )
    } finally {
      store.db.close()
    }
  })

  test('a nested transaction rolls back only its own work', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)

      // Composition has to work: every repository write is transactional already, so a
      // caller wrapping two of them — the merge demoting an entry, then inserting its
      // replacement — is the normal case, not a mistake. An inner savepoint keeps the
      // inner rollback from discarding the outer caller's work.
      transaction(store.db, () => {
        repository.insert({ text: 'outer survives', scope: 'global' })
        assert.throws(() =>
          transaction(store.db, () => {
            repository.insert({ text: 'inner is discarded', scope: 'global' })
            throw new Error('inner failure')
          }),
        )
      })

      assert.equal(repository.count(), 1)
      assert.equal(repository.list()[0]?.text, 'outer survives')
    } finally {
      store.db.close()
    }
  })

  test('a failed transaction rolls back', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      assert.throws(() =>
        transaction(store.db, () => {
          repository.insert({ text: 'will be rolled back', scope: 'global' })
          throw new Error('boom')
        }),
      )
      assert.equal(repository.count(), 0)
    } finally {
      store.db.close()
    }
  })
})

describe('repository', () => {
  test('insert returns the stored record including its tags', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const record = repository.insert({
        title: '包管理器',
        text: '这个项目用 pnpm，不要用 npm。',
        scope: 'project',
        projectKey: 'abc',
        projectPath: 'D:\\work\\demo',
        tags: ['工具链', '约定'],
        pinned: true,
        importance: 3,
      })
      assert.equal(record.title, '包管理器')
      assert.deepEqual(record.tags, ['工具链', '约定'])
      assert.equal(record.pinned, true)
      assert.equal(record.scope, 'project')
      assert.equal(record.status, 'active')
      assert.ok(record.createdAt.length > 0)
    } finally {
      store.db.close()
    }
  })

  test('getMany preserves the caller order and skips missing ids', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const a = repository.insert({ text: 'first', scope: 'global' })
      const b = repository.insert({ text: 'second', scope: 'global' })
      const found = repository.getMany([b.id, 9999, a.id])
      assert.deepEqual(
        found.map((record) => record.text),
        ['second', 'first'],
      )
    } finally {
      store.db.close()
    }
  })

  test('update writes only the fields it is given', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const record = repository.insert({ title: 'keep me', text: 'original', scope: 'global', pinned: true })
      const updated = repository.update(record.id, { text: 'changed' })
      assert.equal(updated?.title, 'keep me', 'an absent field must not be blanked')
      assert.equal(updated?.pinned, true)
      assert.equal(updated?.text, 'changed')
    } finally {
      store.db.close()
    }
  })

  test('a filtered list combines scope, project and tag', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: 'global one', scope: 'global', tags: ['x'] })
      repository.insert({ text: 'project one', scope: 'project', projectKey: 'p1', tags: ['x'] })
      repository.insert({ text: 'project two', scope: 'project', projectKey: 'p2', tags: ['x'] })
      repository.insert({ text: 'other project', scope: 'project', projectKey: 'p1', tags: ['y'] })

      assert.equal(repository.list({ scope: 'project', projectKey: 'p1' }).length, 2)
      assert.equal(repository.list({ scope: 'project', projectKey: 'p1', tag: 'x' }).length, 1)
      assert.equal(repository.count({ scope: 'project' }), 3)
      assert.equal(repository.list({ anyProject: true }).length, 3)
    } finally {
      store.db.close()
    }
  })

  test('a tag containing SQL is treated as data', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const nasty = "x'); DROP TABLE memories; --"
      repository.insert({ text: 'injection attempt', scope: 'global', tags: [nasty] })
      const rows = repository.list({ tag: nasty })
      assert.equal(rows.length, 1)
      // The proof that nothing was dropped is that the table is still there and queryable.
      assert.equal(repository.count(), 1)
    } finally {
      store.db.close()
    }
  })

  test('tags are normalised on the way in', () => {
    assert.deepEqual(normalizeTags(['  a  ', 'a', '', 'b']), ['a', 'b'])
    assert.deepEqual(normalizeTags(undefined), [])
    assert.equal(normalizeTags(Array.from({ length: 20 }, (_, index) => `t${index}`)).length, 12)
  })

  test('a body is validated before it reaches SQLite', () => {
    assert.equal(validateText('  keeps inner spacing  '), 'keeps inner spacing')
    assert.throws(() => validateText('   '), /non-empty body/)
    assert.throws(() => validateText('x'.repeat(MAX_MEMORY_CHARS + 1)), /limited to/)
  })

  test('eviction excludes pinned entries and orders the rest by last use', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const pinned = repository.insert({ text: 'pinned', scope: 'global', pinned: true })
      const stale = repository.insert({ text: 'stale', scope: 'global' })
      const used = repository.insert({ text: 'used', scope: 'global' })
      // A row whose own timestamp is decisive: `used` was read later than `fresh` was
      // created, so keeping one row must keep `used`, not `fresh`.
      const fresh = repository.insert({ text: 'fresh', scope: 'global' })

      // Explicit `at` values rather than touches and a hope. These inserts land inside one
      // millisecond of each other, so anything the clock decides here is luck and a test
      // built on it fails intermittently for a reason the reader cannot see. The two rows
      // are separated by a full day so no ordering question can rest on tie-breaking.
      const day = fresh.createdAt.slice(0, 10)
      repository.touch([used.id], `${day} 23:59:59.999`)
      repository.touch([stale.id], '2000-01-01 00:00:00.000')

      // Rank order: `used` (read today), then `fresh` (never read, created today), then
      // `stale` (read in 2000). `pinned` is not a candidate at any rank — asserting the
      // whole rank order rather than `!includes(pinned.id)` is what makes this true
      // incidentally and permanently, instead of only when the clause is remembered.
      assert.deepEqual(repository.evictionCandidates('global', null, 0), [used.id, fresh.id, stale.id])
      assert.deepEqual(repository.evictionCandidates('global', null, 1), [fresh.id, stale.id])
      assert.deepEqual(repository.evictionCandidates('global', null, 2), [stale.id])
      assert.deepEqual(repository.evictionCandidates('global', null, 3), [])

      // Pinning is checked directly as well, because the rank assertions above would pass
      // for the wrong reason if a pinned row happened to sort last.
      assert.equal(repository.evictionCandidates('global', null, 99).includes(pinned.id), false)

      // Every candidate set must be a subset of the one before it, or a wider keep could
      // evict something a narrower one would have spared.
      const sets = [0, 1, 2, 3].map((keep) => repository.evictionCandidates('global', null, keep))
      for (let index = 1; index < sets.length; index += 1) {
        for (const id of sets[index] ?? []) {
          assert.ok(sets[index - 1]?.includes(id), `keep=${index} must be a subset of keep=${index - 1}`)
        }
      }
    } finally {
      store.db.close()
    }
  })

  test('timestamps carry milliseconds so they can be compared', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const record = repository.insert({ text: 'timing', scope: 'global' })
      // `datetime('now')` produces `2026-10-03 13:41:25` — one-second resolution, and a
      // DIFFERENT string shape from a millisecond timestamp, so the two do not compare
      // correctly together. The format is asserted rather than an ordering, because ordering
      // by the clock is not something a test can depend on.
      assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)

      // An explicit `at` is honoured, which is what lets an import carry the source's own
      // usage times instead of claiming every imported entry was read just now.
      const anchored = `${record.createdAt.slice(0, -3)}999`
      repository.touch([record.id], anchored)
      assert.equal(repository.get(record.id)?.lastUsedAt, anchored)
    } finally {
      store.db.close()
    }
  })

  test('projects groups by key and reports entry counts', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: 'a', scope: 'project', projectKey: 'p1', projectPath: 'D:\\one' })
      repository.insert({ text: 'b', scope: 'project', projectKey: 'p1', projectPath: 'D:\\one' })
      repository.insert({ text: 'c', scope: 'project', projectKey: 'p2', projectPath: 'D:\\two' })
      const projects = repository.projects()
      assert.equal(projects.length, 2)
      assert.equal(projects[0]?.projectKey, 'p1')
      assert.equal(projects[0]?.count, 2)
    } finally {
      store.db.close()
    }
  })

  test('the import ledger records and recognises hashes', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const record = repository.insert({ text: 'imported', scope: 'global', source: 'import' })
      repository.recordImport('hash-a', record.id)
      assert.deepEqual([...repository.knownHashes(['hash-a', 'hash-b'])], ['hash-a'])

      // Re-recording the same hash updates the mapping rather than failing on the primary key,
      // which is what keeps a repeated import idempotent.
      repository.recordImport('hash-a', record.id)
      assert.equal(repository.knownHashes(['hash-a']).has('hash-a'), true)

      // A hash with no row behind it is NOT known. `memory_id` is ON DELETE SET NULL, so once the
      // entry is deleted — the user emptying their store — the material can be imported again,
      // which is what they expect. An ARCHIVED entry still counts, and that is the point of the
      // ledger: re-running an import must not resurrect something they deliberately put away.
      repository.recordImport('hash-b', null)
      assert.equal(repository.knownHashes(['hash-b']).has('hash-b'), false)

      repository.remove(record.id)
      assert.equal(repository.knownHashes(['hash-a']).has('hash-a'), false)
    } finally {
      store.db.close()
    }
  })
})

describe('similarity', () => {
  test('folds case, width and punctuation', () => {
    assert.equal(similarity('Use PNPM!', 'use pnpm'), 1)
    assert.equal(similarity('项目用 pnpm。', '项目用 pnpm'), 1)
  })

  test('a restatement scores high and a different topic scores low', () => {
    const restated = similarity('这个项目使用 pnpm，不要用 npm。', '这个项目用 pnpm，不要用 npm')
    const unrelated = similarity('这个项目使用 pnpm。', '部署到 staging 需要先跑迁移')
    assert.ok(restated > 0.5, `expected a high score, got ${restated}`)
    assert.ok(unrelated < 0.3, `expected a low score, got ${unrelated}`)
  })

  test('containment catches a shorter restatement that Jaccard would punish', () => {
    const long = '这个项目使用 pnpm 作为包管理器，不要用 npm 或 yarn'
    const short = '这个项目使用 pnpm'
    assert.ok(containment(short, long) > 0.85, 'a subset must be recognised as covered')
    assert.ok(similarity(short, long) < 0.5, 'while Jaccard alone would not see it')
  })

  test('contradiction needs opposite polarity AND a shared subject', () => {
    assert.equal(contradict('这个项目用 pnpm', '这个项目不要用 pnpm'), true)
    assert.equal(contradict('这个项目用 pnpm', '这个项目用 pnpm'), false)
    assert.equal(contradict('这个项目用 pnpm', '不要用 tab 缩进'), false, 'different subjects cannot conflict')
  })
})

describe('runAll parameter checking', () => {
  test('names a placeholder/argument mismatch instead of reporting a datatype error', async () => {
    // `node:sqlite` raises ERR_SQLITE_ERROR / "datatype mismatch" for a parameter COUNT
    // mismatch — the same code and message it uses for a type mismatch. That ambiguity sent
    // the retriever's first debugging session after column types for several rounds, so the
    // guard is pinned here rather than left to be rediscovered.
    const store = await freshStore()
    try {
      assert.throws(
        () => runAll(store.db, 'SELECT ? AS a, ? AS b', ['only one']),
        /SQL parameter count mismatch: 2 placeholder\(s\) for 1 value\(s\)/,
      )
      // A question mark inside a string literal is not a placeholder.
      assert.doesNotThrow(() => runAll(store.db, "SELECT '?' AS literal, ? AS real", ['one']))
      // Doubled quotes inside a literal are an escaped quote, not the end of the literal.
      assert.doesNotThrow(() => runAll(store.db, "SELECT 'it''s ?' AS literal, ? AS real", ['one']))
      // Row objects from `node:sqlite` have a null prototype, so a structural deepEqual
      // against an object literal fails on the prototype; read the field instead.
      const rows = runAll(store.db, 'SELECT ? AS a', ['ok'])
      assert.equal(rows.length, 1)
      assert.equal((rows[0] as { a: string }).a, 'ok')
    } finally {
      store.db.close()
    }
  })
})

describe('four-state merge', () => {
  test('an identical body is ignored, not duplicated', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: '用户偏好简洁回答', scope: 'global' })
      const plan = planMerge(repository, { text: '用户偏好简洁回答', scope: 'global' })
      assert.equal(plan.decision, 'ignore')
      assert.equal(repository.count(), 1)
    } finally {
      store.db.close()
    }
  })

  test('a restatement merges into the existing entry and is not stored twice', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const original = repository.insert({ text: '这个项目使用 pnpm', scope: 'project', projectKey: 'p' })
      const candidate = { text: '这个项目使用 pnpm 作为包管理器', scope: 'project' as const, projectKey: 'p' }
      const plan = planMerge(repository, candidate)
      assert.equal(plan.decision, 'merge')
      const result = applyMerge(repository, candidate, plan)
      assert.equal(repository.count(), 1, 'a merge must not create a second row')
      assert.ok((result.record?.text ?? '').includes('pnpm 作为包管理器'))
      assert.equal(result.record?.id, original.id)
    } finally {
      store.db.close()
    }
  })

  test('a correction retires the old entry rather than merging with it', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      const old = repository.insert({ text: '这个项目用 pnpm', scope: 'project', projectKey: 'p' })
      const candidate = { text: '这个项目不要用 pnpm，改用 npm', scope: 'project' as const, projectKey: 'p' }
      const plan = planMerge(repository, candidate)
      assert.equal(plan.decision, 'update')
      assert.equal(plan.conflict?.id, old.id)

      const result = applyMerge(repository, candidate, plan)
      assert.deepEqual(result.superseded, [old.id])
      assert.equal(repository.get(old.id)?.status, 'outdated', 'the previous belief must remain auditable')
      assert.equal(repository.count({ scope: 'project', projectKey: 'p', status: 'active' }), 1)
    } finally {
      store.db.close()
    }
  })

  test('an unrelated statement is new', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: '这个项目使用 pnpm', scope: 'global' })
      const plan = planMerge(repository, { text: '部署前需要先运行数据库迁移', scope: 'global' })
      assert.equal(plan.decision, 'new')
    } finally {
      store.db.close()
    }
  })

  test('entries in another project never compete', async () => {
    const store = await freshStore()
    try {
      const repository = new MemoryRepository(store.db)
      repository.insert({ text: '使用 pnpm', scope: 'project', projectKey: 'other' })
      const plan = planMerge(repository, { text: '使用 pnpm', scope: 'project', projectKey: 'mine' })
      assert.equal(plan.decision, 'new', 'project isolation must hold inside the merge too')
    } finally {
      store.db.close()
    }
  })
})

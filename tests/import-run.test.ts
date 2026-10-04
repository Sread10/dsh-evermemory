import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { readDaily } from '../src/distill/daily.ts'
import { applyScan, type ImportRequest } from '../src/importers/run.ts'
import { emptyScan, type ImportItem, type ScanResult } from '../src/importers/types.ts'
import { openStore, type OpenStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'

/**
 * The import runner, driven with literal items.
 *
 * `applyScan` is exported separately from `runImport` precisely so these tests can exercise the
 * half that decides things — which layer, which decision, what the ledger remembers — without a
 * filesystem in the way. A failure here is a policy failure; a failure in the parser tests is a
 * format failure, and keeping the two apart is what makes either one diagnosable.
 */

const stores: OpenStore[] = []

after(() => {
  for (const store of stores) {
    try {
      store.db.close()
    } catch {
      // Already closed.
    }
  }
})

/** A repository on a real database file: the ledger and the merge gate are SQL, not mocks. */
async function repository(): Promise<MemoryRepository> {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-import-')), 'store.sqlite') })
  stores.push(store)
  return new MemoryRepository(store.db)
}

/** A scan of document entries, the common shape. */
function documents(items: readonly ImportItem[], source: ScanResult['source'] = 'claude'): ScanResult {
  return { source, label: 'Claude memories', items, files: 1, skipped: 0, errors: [], truncated: false }
}

/** A request with the boring parts filled in. */
function request(overrides: Partial<ImportRequest> = {}): ImportRequest {
  return { path: '/tmp/export.json', maxChars: 8000, ...overrides }
}

describe('import runner: documents', () => {
  test('takes a document entry whole and records where it came from', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'This project builds with pnpm, never npm.', uri: 'file|a.md|0', title: 'Build tool', tags: ['file'] }])

    const outcome = applyScan(repo, '/tmp/a.md', scan, request({ tags: ['claude'] }), 100)

    assert.equal(outcome.written, 1)
    assert.equal(outcome.considered, 1)
    const rows = repo.list({ scope: ['global'] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.source, 'import')
    assert.equal(rows[0]?.sourcePlatform, 'claude')
    assert.deepEqual([...(rows[0]?.tags ?? [])].sort(), ['claude', 'file'])
    assert.equal(rows[0]?.title, 'Build tool')
    assert.match(rows[0]?.text ?? '', /never npm/u)
  })

  test('never writes the identity layer, which is a file the user edits by hand', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'The user writes in Chinese and prefers terse answers.', uri: 'file|a.md|0', scope: 'identity' }])

    const outcome = applyScan(repo, '/tmp/a.md', scan, request({ scope: 'project', projectKey: 'abc' }), 100)

    assert.equal(outcome.written, 1)
    const rows = repo.list({ scope: ['project'], projectKey: 'abc' })
    assert.equal(rows.length, 1)
    assert.equal(repo.count({ scope: ['identity'] }), 0)
  })

  test('a project item with no project key lands in global rather than nowhere', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'Only true of this checkout: the port is 4100.', uri: 'file|a.md|0', scope: 'project' }])

    const outcome = applyScan(repo, '/tmp/a.md', scan, request({ projectKey: null }), 100)

    assert.equal(outcome.written, 1)
    assert.equal(repo.count({ scope: ['global'] }), 1)
    assert.equal(repo.count({ scope: ['project'] }), 0)
  })

  test('refuses an item longer than the entry ceiling and says so', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'x'.repeat(60), uri: 'file|a.md|0' }])

    const outcome = applyScan(repo, '/tmp/a.md', scan, request({ maxChars: 30 }), 100)

    assert.equal(outcome.oversized, 1)
    assert.equal(outcome.written, 0)
    assert.equal(repo.count(), 0)
    assert.match(outcome.samples[0]?.reason ?? '', /longer than 30/u)
  })

  test('a dry run decides without writing and says it was a dry run', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'Deploys go out on Thursday afternoons.', uri: 'file|a.md|0' }])

    const outcome = applyScan(repo, '/tmp/a.md', scan, request({ dryRun: true }), 100)

    assert.equal(outcome.dryRun, true)
    assert.equal(outcome.written, 1)
    assert.equal(repo.count(), 0)
  })

  test('reports an empty scan instead of claiming success', async () => {
    const repo = await repository()
    const outcome = applyScan(repo, '/nowhere', emptyScan(null, 'unknown'), request(), 100)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.errors.length, 1)
    assert.match(outcome.errors[0] ?? '', /nothing importable at \/nowhere/u)
  })
})

describe('import runner: the ledger', () => {
  test('re-running an import does no work a second time', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'The staging database is rebuilt every Sunday.', uri: 'file|a.md|0' }])

    const first = applyScan(repo, '/tmp/a.md', scan, request(), 100)
    const second = applyScan(repo, '/tmp/a.md', scan, request(), 100)

    assert.equal(first.written, 1)
    assert.equal(second.written, 0)
    assert.equal(second.known, 1)
    assert.equal(repo.count(), 1)
  })

  test('an entry the user deleted can be imported again, an archived one cannot', async () => {
    const repo = await repository()
    const scan = documents([{ text: 'The nightly job runs at 03:20 local time.', uri: 'file|a.md|0' }])

    applyScan(repo, '/tmp/a.md', scan, request(), 100)
    const written = repo.list({ scope: ['global'] })[0]
    assert.ok(written !== undefined)

    // Archiving keeps the ledger honest: the user put it away on purpose, so an import must not
    // bring it back.
    repo.update(written.id, { status: 'archived' })
    assert.equal(applyScan(repo, '/tmp/a.md', scan, request(), 100).known, 1)

    // Deleting is different — the row is gone, so the material is new again.
    assert.equal(repo.remove(written.id), true)
    assert.equal(applyScan(repo, '/tmp/a.md', scan, request(), 100).written, 1)
  })
})

describe('import runner: transcripts and logs', () => {
  test('mines a transcript turn for what was said, rather than storing the whole turn', async () => {
    const repo = await repository()
    const turn = '好的我明白了，那我们就这样做吧，另外以后都用 pnpm，不要用 npm，这一点请记牢。'
    const scan = documents([{ text: turn, uri: 'jsonl|session|0', kind: 'utterance' }])

    const outcome = applyScan(repo, '/tmp/session.jsonl', scan, request(), 100)

    assert.ok(outcome.written >= 1, 'a turn carrying a standing instruction must produce an entry')
    const rows = repo.list({ scope: ['global'] })
    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.ok(row.text.length < turn.length, 'the stored text is a sentence from the turn, not the turn')
      assert.match(row.text, /npm/u)
    }
  })

  test('a daily entry is appended to its own day, keyed by the source title', async () => {
    const repo = await repository()
    const scan = documents([
      { text: 'spent the morning on the import runner', uri: 'evermemory|daily|0', scope: 'daily', title: '2026-03-04' },
    ])

    const outcome = applyScan(repo, '/tmp/export.jsonl', scan, request(), 100)

    assert.equal(outcome.logged, 1)
    assert.equal(outcome.written, 0)
    const log = readDaily(repo, '2026-03-04')
    assert.ok(log !== undefined)
    assert.match(log.text, /import runner/u)
    assert.equal(repo.count({ scope: ['daily'] }), 1)
  })

  test('the same thread arrives twice from two products and is merged, not duplicated', async () => {
    const repo = await repository()
    const first = applyScan(repo, '/a.json', documents([{ text: 'We ship on Fridays.', uri: 'chatgpt|1|0' }], 'chatgpt'), request(), 100)
    const second = applyScan(repo, '/b.json', documents([{ text: 'We ship on Fridays.', uri: 'claude|9|0' }], 'claude'), request(), 100)

    assert.equal(first.written, 1)
    // The ledger is per source, so the second product's copy is considered; the merge gate is what
    // decides the two statements are one memory.
    assert.equal(second.considered, 1)
    assert.equal(second.written + second.merged + second.updated + second.ignored, 1)
    assert.equal(repo.count({ scope: ['global'] }), 1)
  })
})

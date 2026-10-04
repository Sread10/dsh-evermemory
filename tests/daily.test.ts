import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  appendDaily,
  dateOf,
  dayKey,
  isDayKey,
  listDaily,
  parseEntries,
  purgeDaily,
  readDaily,
  renderEntry,
  toMarkdown,
} from '../src/distill/daily.ts'
import { openStore, type OpenStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'

/**
 * The daily log is the layer nobody reads on purpose. It is written at a session boundary and
 * read later, by a person or by a retrieval that has no reason to have run — which means a bug
 * here has no immediate symptom and is discovered weeks later, as a missing month. These tests
 * therefore concentrate on the two things that fail silently: which day a row belongs to, and
 * whether a second write to the same day replaces the first.
 */

const stores: OpenStore[] = []

async function freshStore(): Promise<{ store: OpenStore, repository: MemoryRepository }> {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-daily-')), 'store.sqlite') })
  stores.push(store)
  return { store, repository: new MemoryRepository(store.db) }
}

after(() => {
  for (const store of stores) {
    try {
      store.db.close()
    } catch {
      // Already closed; nothing to report.
    }
  }
})

describe('day keys', () => {
  test('formats a local calendar day, not a UTC one', () => {
    // An evening's work must not be filed under tomorrow. With UTC keys, anyone east of
    // Greenwich loses the end of every working day into the next row.
    const evening = new Date(2026, 7, 13, 23, 30, 0)
    assert.equal(dayKey(evening), '2026-08-13')
    const morning = new Date(2026, 7, 13, 0, 30, 0)
    assert.equal(dayKey(morning), '2026-08-13')
  })

  test('accepts only the canonical shape', () => {
    assert.equal(isDayKey('2026-08-13'), true)
    assert.equal(isDayKey('2026-8-13'), false)
    assert.equal(isDayKey('today'), false)
    assert.equal(isDayKey('2026-08-13T10:00:00Z'), false)
  })
})

describe('entry rendering', () => {
  test('labels an entry, and omits the brackets when there is no label', () => {
    assert.equal(renderEntry({ text: 'ran the suite', label: 'test' }), '- [test] ran the suite')
    assert.equal(renderEntry({ text: 'ran the suite' }), '- ran the suite')
    // A label that is only whitespace is not a label; storing "- [] x" would be a parse hazard.
    assert.equal(renderEntry({ text: 'ran the suite', label: '  ' }), '- ran the suite')
  })

  test('round-trips entries through a stored body', () => {
    const body = [renderEntry({ text: 'one', label: 'a' }), renderEntry({ text: 'two' })].join('\n\n')
    assert.deepEqual(parseEntries(body), ['- [a] one', '- two'])
  })

  test('returns an unparseable body rather than nothing', () => {
    // A body edited by hand in the settings panel can have any shape. Showing it is better
    // than reporting an empty day, which would look like the log had been lost.
    assert.deepEqual(parseEntries('just some text'), ['just some text'])
    assert.deepEqual(parseEntries('   '), [])
  })
})

describe('appending to a day', () => {
  test('creates the day on first write and extends it on the next', async () => {
    // One session does not own a day. A row per session would grow the layer with session
    // count, which is exactly the growth-with-volume that the token budget forbids.
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'first thing' }], { date: '2026-05-01' })
    appendDaily(repository, [{ text: 'second thing' }], { date: '2026-05-01' })

    const log = readDaily(repository, '2026-05-01')
    assert.equal(log?.entries.length, 2)
    assert.equal(repository.count({ scope: 'daily' }), 1)
  })

  test('keeps days apart, including two days in the same project', async () => {
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'monday' }], { date: '2026-05-04', projectKey: 'p1' })
    appendDaily(repository, [{ text: 'tuesday' }], { date: '2026-05-05', projectKey: 'p1' })
    appendDaily(repository, [{ text: 'other repo' }], { date: '2026-05-04', projectKey: 'p2' })

    assert.equal(readDaily(repository, '2026-05-04', 'p1')?.entries[0], '- monday')
    assert.equal(readDaily(repository, '2026-05-05', 'p1')?.entries[0], '- tuesday')
    assert.equal(readDaily(repository, '2026-05-04', 'p2')?.entries[0], '- other repo')
    assert.equal(repository.count({ scope: 'daily' }), 3)
  })

  test('writes nothing for an empty entry list', async () => {
    // A session that learned nothing must not create a row. An empty day is indistinguishable
    // from a lost day when read back, so it is better not to have one.
    const { repository } = await freshStore()
    assert.equal(appendDaily(repository, []), undefined)
    assert.equal(appendDaily(repository, [{ text: '   ' }]), undefined)
    assert.equal(repository.count({ scope: 'daily' }), 0)
  })

  test('stamps the project and the sub-id it was given', async () => {
    const { repository } = await freshStore()
    const record = appendDaily(repository, [{ text: 'x' }], {
      date: '2026-05-01',
      projectKey: 'key',
      projectPath: 'D:/work/thing',
      subId: 'worktree-2',
    })
    assert.equal(record?.scope, 'daily')
    assert.equal(record?.projectKey, 'key')
    assert.equal(record?.projectPath, 'D:/work/thing')
    assert.equal(record?.subId, 'worktree-2')
    assert.equal(record?.title, '2026-05-01')
  })

  test('a failed write returns undefined instead of throwing', async () => {
    // This runs after the user has stopped watching. A throw here surfaces as a broken session
    // teardown rather than as a missing log line.
    const { store, repository } = await freshStore()
    store.db.close()
    assert.equal(appendDaily(repository, [{ text: 'x' }]), undefined)
  })

  test('reactivates an archived day rather than writing into a row nobody reads', async () => {
    // A day can be archived by the retention sweep and then written to again — a resumed
    // session, a backfill, a clock that moved. Extending the archived row without reviving it
    // would store the entry and show nothing.
    const { repository } = await freshStore()
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    const key = dayKey(old)
    appendDaily(repository, [{ text: 'first' }], { date: key })
    assert.equal(purgeDaily(repository, { retentionDays: 30 }).archived, 1)
    assert.equal(readDaily(repository, key)?.status, 'archived')

    appendDaily(repository, [{ text: 'after the sweep' }], { date: key })
    const log = readDaily(repository, key)
    assert.equal(log?.status, 'active')
    assert.equal(log?.entries.length, 2)
  })
})

describe('which day a stored row belongs to', () => {
  test('prefers the title, and falls back to created_at when it is not a day', async () => {
    // The title is editable from the panel. A renamed row must not silently change its day,
    // and created_at is the field that cannot be renamed away.
    const { repository } = await freshStore()
    const record = appendDaily(repository, [{ text: 'x' }], { date: '2026-05-01' })
    assert.ok(record !== undefined)
    assert.equal(dateOf(record), '2026-05-01')

    const renamed = repository.update(record.id, { title: 'renamed by the user' })
    assert.ok(renamed !== undefined)
    // Asserted against the row's OWN created_at rather than against a literal: the row was
    // created now, not in 2026-05, so a hard-coded expectation would only pass by accident.
    assert.equal(dateOf(renamed), renamed.createdAt.slice(0, 10))
  })
})

describe('reading days back', () => {
  test('lists newest first regardless of insertion order', async () => {
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'older' }], { date: '2026-04-02' })
    appendDaily(repository, [{ text: 'newest' }], { date: '2026-06-09' })
    appendDaily(repository, [{ text: 'middle' }], { date: '2026-05-01' })

    assert.deepEqual(listDaily(repository).map((log) => log.date), ['2026-06-09', '2026-05-01', '2026-04-02'])
  })

  test('honours the limit and the project filter', async () => {
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'a' }], { date: '2026-04-01', projectKey: 'p1' })
    appendDaily(repository, [{ text: 'b' }], { date: '2026-04-02', projectKey: 'p1' })
    appendDaily(repository, [{ text: 'c' }], { date: '2026-04-03', projectKey: 'p2' })

    assert.equal(listDaily(repository, { projectKey: 'p1' }).length, 2)
    assert.equal(listDaily(repository, { projectKey: null }).length, 0)
    assert.equal(listDaily(repository, { anyProject: true }).length, 3)
    assert.equal(listDaily(repository, { projectKey: 'p1', limit: 1 }).length, 1)
  })

  test('reports a missing day as undefined rather than as an empty day', async () => {
    // The two are different answers: "nothing happened" versus "no such day".
    const { repository } = await freshStore()
    assert.equal(readDaily(repository, '1999-01-01'), undefined)
  })
})

describe('retention', () => {
  /**
   * A day key a fixed number of days from now.
   *
   * Anchored on the wall clock because `purgeDaily` compares against it: a hard-coded date would
   * pass today and fail as the calendar moved on, which is a test that reports a bug where there
   * is only an ageing test.
   */
  function daysAgo(days: number): string {
    const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    return dayKey(at)
  }

  test('archives days past the window and keeps them readable', async () => {
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'old' }], { date: daysAgo(100) })
    appendDaily(repository, [{ text: 'recent' }], { date: daysAgo(5) })

    const result = purgeDaily(repository, { retentionDays: 30 })
    assert.equal(result.archived, 1)
    assert.deepEqual(result.dates, [daysAgo(100)])

    // Archived, not deleted: "what was I doing last month" is still answerable.
    assert.equal(readDaily(repository, daysAgo(100))?.status, 'archived')
    assert.equal(readDaily(repository, daysAgo(5))?.status, 'active')
    assert.equal(listDaily(repository).length, 2)
  })

  test('is a no-op when everything is inside the window', async () => {
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'recent' }], { date: daysAgo(1) })
    const result = purgeDaily(repository, { retentionDays: 30 })
    assert.equal(result.archived, 0)
    assert.deepEqual(result.dates, [])
  })

  test('does not archive twice, so a second run reports nothing', async () => {
    // Without the status filter the second run would report the same day again and a log line
    // would claim work that did not happen.
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'old' }], { date: daysAgo(100) })
    assert.equal(purgeDaily(repository, { retentionDays: 30 }).archived, 1)
    assert.equal(purgeDaily(repository, { retentionDays: 30 }).archived, 0)
  })
})

describe('markdown export', () => {
  test('headings a day per section', async () => {
    const { repository } = await freshStore()
    appendDaily(repository, [{ text: 'did a thing', label: 'note' }], { date: '2026-05-01' })
    const markdown = toMarkdown(listDaily(repository), 'Daily log')
    assert.match(markdown, /^# Daily log\n/u)
    assert.match(markdown, /## 2026-05-01/u)
    assert.match(markdown, /- \[note\] did a thing/u)
  })
})

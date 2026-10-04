/**
 * The panel's method dispatch, tested through the handler the route registers.
 *
 * Every assertion here runs through `createPanelApi().handle`, not through the underlying service:
 * the panel is a second entrance to the same store, and what matters is that it is exactly as
 * strict as the conversational tools — the same gate for a write, the same refusal of another
 * project's rows, and a failure value rather than a thrown error for anything a click can get
 * wrong.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { createPanelApi } from '../src/panel/api.ts'
import type { PanelHandler } from '../src/panel/api.ts'
import type {
  PanelEnvelope,
  PanelExportResult,
  PanelGetResult,
  PanelImportResult,
  PanelListResult,
  PanelLogResult,
  PanelMemory,
  PanelOverview,
  PanelRememberResult,
  PanelSearchResult,
  PanelUpdateResult,
} from '../src/panel/protocol.ts'
import type { PanelDailyResult, PanelForgetResult } from '../src/panel/protocol.ts'
import { StoreHandle } from '../src/storage/handle.ts'
import { openStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import type { NewMemory } from '../src/storage/repository.ts'

const PROJECT = { key: 'p'.repeat(16), path: 'D:\\work\\one' } as const

const homes: string[] = []
const handles: StoreHandle[] = []

after(async () => {
  for (const handle of handles) await handle.close()
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

/** A panel handler over a store seeded with the given rows. */
async function prepare(rows: readonly NewMemory[] = []): Promise<PanelHandler> {
  const home = mkdtempSync(join(tmpdir(), 'evm-panel-api-'))
  homes.push(home)
  const opened = await openStore({ dshHome: home })
  if (rows.length > 0) {
    const repository = new MemoryRepository(opened.db)
    for (const row of rows) repository.insert(row)
  }
  opened.db.close()
  const store = new StoreHandle(home)
  handles.push(store)
  return createPanelApi({ store }).handle
}

/** The value of a successful answer, or a failed assertion naming the error. */
async function valueOf<T>(handle: PanelHandler, method: string, payload?: unknown): Promise<T> {
  const answer = (await handle(method, payload)) as PanelEnvelope<T>
  assert.equal(answer.ok, true, `expected ${method} to succeed, got ${JSON.stringify(answer)}`)
  return (answer as { readonly value: T }).value
}

/** The error of a failed answer. */
async function errorOf(handle: PanelHandler, method: string, payload?: unknown): Promise<{ code: string, message: string }> {
  const answer = (await handle(method, payload)) as PanelEnvelope<unknown>
  assert.equal(answer.ok, false, `expected ${method} to fail, got ${JSON.stringify(answer)}`)
  return (answer as { readonly error: { code: string, message: string } }).error
}

describe('the panel dispatch', () => {
  test('overview counts the store and names where it lives', async () => {
    const handle = await prepare([
      { text: '用户偏好中文回答', scope: 'global', tags: ['style'] },
      { text: '这个项目使用 pnpm', scope: 'project', projectKey: PROJECT.key, projectPath: PROJECT.path },
      { text: '已经归档的一条', scope: 'global', status: 'archived' },
    ])

    const overview = await valueOf<PanelOverview>(handle, 'overview')

    assert.equal(overview.total, 3)
    assert.equal(typeof overview.database, 'string')
    assert.ok(overview.status === 'ready')
    assert.deepEqual(overview.projects.map((row) => row.projectKey), [PROJECT.key])
    // Compared field by field: the driver hands back null-prototype rows, which `deepEqual` would
    // reject even when they carry exactly these values.
    assert.deepEqual(overview.tags.map((row) => [row.tag, row.count]), [['style', 1]])
  })

  test('list pages, filters by layer, and clamps an absurd limit', async () => {
    const handle = await prepare([
      { text: '全局一', scope: 'global' },
      { text: '全局二', scope: 'global' },
      { text: '全局三', scope: 'global' },
      { text: '项目一', scope: 'project', projectKey: PROJECT.key },
    ])

    const page = await valueOf<PanelListResult>(handle, 'list', { limit: 2 })
    assert.equal(page.items.length, 2)
    assert.equal(page.total, 4)
    assert.equal(page.limit, 2)

    const globals = await valueOf<PanelListResult>(handle, 'list', { globalOnly: true })
    assert.equal(globals.total, 3)

    const projectOnly = await valueOf<PanelListResult>(handle, 'list', { project: PROJECT })
    assert.equal(projectOnly.total, 1)
    assert.equal(projectOnly.items[0]?.scope, 'project')

    const clamped = await valueOf<PanelListResult>(handle, 'list', { limit: 100_000 })
    assert.equal(clamped.limit, 200)
  })

  test('get returns the whole row and reports a missing one as a failure value', async () => {
    const handle = await prepare([{ text: '正文内容', scope: 'global' }])
    const listed = await valueOf<PanelListResult>(handle, 'list', {})
    const id = listed.items[0]?.id
    assert.ok(typeof id === 'number')

    const got = await valueOf<PanelGetResult>(handle, 'get', { id })
    assert.equal(got.item.text, '正文内容')

    const missing = await errorOf(handle, 'get', { id: 99_999 })
    assert.equal(missing.code, 'memory/not-found')

    const malformed = await errorOf(handle, 'get', {})
    assert.equal(malformed.code, 'request/invalid')
  })

  test('search needs a query and finds Chinese text', async () => {
    const handle = await prepare([
      { text: '这个项目约定使用前缀缓存，命中率要稳定', scope: 'global' },
      { text: '完全无关的一句话', scope: 'global' },
    ])

    const empty = await errorOf(handle, 'search', { query: '   ' })
    assert.equal(empty.code, 'request/invalid')

    const hits = await valueOf<PanelSearchResult>(handle, 'search', { query: '前缀缓存' })
    assert.ok(hits.hits.some((hit) => hit.text.includes('前缀缓存')), JSON.stringify(hits))
  })

  test('remember writes through the same gate as the tools, and refuses what it may not write', async () => {
    const handle = await prepare()

    const written = await valueOf<PanelRememberResult>(handle, 'remember', {
      text: '用户偏好简洁回答',
      tags: ['style', 'style'],
      pinned: true,
    })
    assert.equal(typeof written.id, 'number')
    assert.equal(written.scope, 'global')

    const again = await valueOf<PanelRememberResult>(handle, 'remember', { text: '用户偏好简洁回答' })
    assert.equal(again.id, written.id, 'the same statement is the same row, not a second one')

    const empty = await errorOf(handle, 'remember', { text: '  ' })
    assert.equal(empty.code, 'request/invalid')

    const noProject = await errorOf(handle, 'remember', { text: '项目约定', scope: 'project' })
    assert.equal(noProject.code, 'request/invalid')

    const identity = await errorOf(handle, 'remember', { text: '我是谁', scope: 'identity' })
    assert.equal(identity.code, 'request/invalid')
  })

  test('update patches the fields the panel owns and refuses an empty patch', async () => {
    const handle = await prepare([{ text: '原来的正文', scope: 'global' }])
    const listed = await valueOf<PanelListResult>(handle, 'list', {})
    const id = listed.items[0]?.id
    assert.ok(typeof id === 'number')

    const updated = await valueOf<PanelUpdateResult>(handle, 'update', {
      id,
      patch: { title: '新标题', pinned: true, tags: ['a', 'b'] },
    })
    assert.equal(updated.item.title, '新标题')
    assert.equal(updated.item.pinned, true)
    assert.deepEqual([...updated.item.tags], ['a', 'b'])

    const nothing = await errorOf(handle, 'update', { id, patch: {} })
    assert.equal(nothing.code, 'request/invalid')

    const missing = await errorOf(handle, 'update', { id: 99_999, patch: { pinned: true } })
    assert.equal(missing.code, 'memory/not-found')
  })

  test('forget archives instead of deleting, and the archive leaves the default list', async () => {
    const handle = await prepare([
      { text: '要归档的一条', scope: 'global' },
      { text: '我是谁', scope: 'identity' },
    ])
    const listed = await valueOf<PanelListResult>(handle, 'list', {})
    const target = listed.items.find((row: PanelMemory) => row.text === '要归档的一条')
    const identity = listed.items.find((row: PanelMemory) => row.scope === 'identity')
    assert.ok(target !== undefined && identity !== undefined)

    const archived = await valueOf<PanelForgetResult>(handle, 'forget', { id: target.id })
    assert.equal(archived.ok, true)
    assert.equal(archived.status, 'archived')

    // The page opens on the active filter, which is the view where an archived row must be gone.
    const active = await valueOf<PanelListResult>(handle, 'list', { status: ['active'] })
    assert.equal(active.items.some((row) => row.id === target.id), false)

    // …and reachable again through the filter that exists for it.
    const archivedView = await valueOf<PanelListResult>(handle, 'list', { status: ['archived'] })
    assert.equal(archivedView.items.some((row) => row.id === target.id), true)

    const still = await valueOf<PanelGetResult>(handle, 'get', { id: target.id })
    assert.equal(still.item.status, 'archived')

    // The identity layer is not the plugin's to archive; the service says so and the panel reports
    // it as a refusal rather than as a crash.
    const refused = await valueOf<PanelForgetResult>(handle, 'forget', { id: identity.id })
    assert.equal(refused.ok, false)
    assert.notEqual(refused.reason, '')
  })

  test('daily reads one day and log appends to it', async () => {
    const handle = await prepare()

    const before = await valueOf<PanelDailyResult>(handle, 'daily', { date: '2024-05-06' })
    assert.equal(before.log, null)

    const written = await valueOf<PanelLogResult>(handle, 'log', {
      entries: ['读了导入引擎的代码', '修好了面板的路由'],
      date: '2024-05-06',
    })
    assert.equal(written.date, '2024-05-06')
    assert.equal(written.written, 2)

    const after = await valueOf<PanelDailyResult>(handle, 'daily', { date: '2024-05-06' })
    assert.ok(after.log !== null)
    assert.equal(after.log.entries.length, 2)

    const nothing = await errorOf(handle, 'log', { entries: [] })
    assert.equal(nothing.code, 'request/invalid')
  })

  test('export renders Markdown, and archived rows are included only on request', async () => {
    const handle = await prepare([
      { text: '用户偏好中文回答', scope: 'global', tags: ['style'] },
      { text: '已经归档的一条', scope: 'global', status: 'archived' },
    ])

    const active = await valueOf<PanelExportResult>(handle, 'export', {})
    assert.ok(active.markdown.includes('用户偏好中文回答'))
    assert.equal(active.markdown.includes('已经归档的一条'), false)
    assert.equal(active.count, 1)
    assert.ok(active.filename.endsWith('.md'))
    assert.equal(active.bytes, Buffer.byteLength(active.markdown, 'utf8'))

    const everything = await valueOf<PanelExportResult>(handle, 'export', { includeArchived: true })
    assert.ok(everything.markdown.includes('已经归档的一条'))
    assert.equal(everything.count, 2)
  })

  test('a store that cannot be opened is reported as an unavailable store, not as an internal error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evm-panel-api-broken-'))
    homes.push(home)
    const file = join(home, 'not-a-directory')
    writeFileSync(file, 'x', 'utf8')
    const store = new StoreHandle(join(file, 'nested'))
    handles.push(store)
    const handle = createPanelApi({ store }).handle

    const error = await errorOf(handle, 'overview')

    assert.equal(error.code, 'store/unavailable')
    assert.notEqual(error.message, '')
  })

  test('import previews a directory through the step-7 engine, and validates its target', async () => {
    const handle = await prepare()
    const dir = mkdtempSync(join(tmpdir(), 'evm-panel-api-import-'))
    homes.push(dir)
    writeFileSync(
      join(dir, 'MEMORY.md'),
      ['# MEMORY.md — 用户长期偏好', '', '- 回答用中文，不要客套话', '- 代码示例尽量短'].join('\n'),
      'utf8',
    )

    const preview = await valueOf<PanelImportResult>(handle, 'import', { path: dir, dryRun: true })
    assert.equal(preview.ok, true)
    assert.equal(preview.dryRun, true)
    assert.ok(preview.considered >= 1, JSON.stringify(preview))

    // `written` on a preview is what the run WOULD write — the store is what decides whether it
    // happened, so that is what this asserts.
    const untouched = await valueOf<PanelListResult>(handle, 'list', {})
    assert.equal(untouched.total, 0)

    // The same path for real: the rows land, so the preview was a report and not a no-op.
    const real = await valueOf<PanelImportResult>(handle, 'import', { path: dir })
    assert.equal(real.dryRun, false)
    assert.ok(real.written > 0, JSON.stringify(real))

    const stored = await valueOf<PanelSearchResult>(handle, 'search', { query: '客套话' })
    assert.ok(stored.hits.some((hit) => hit.text.includes('不要客套话')), JSON.stringify(stored))

    const noPath = await errorOf(handle, 'import', { path: '  ' })
    assert.equal(noPath.code, 'request/invalid')

    const noProject = await errorOf(handle, 'import', { path: dir, scope: 'project' })
    assert.equal(noProject.code, 'request/invalid')
  })

  test('an unknown method is a failure value that names it', async () => {
    const handle = await prepare()
    const error = await errorOf(handle, 'delete-everything')
    assert.equal(error.code, 'request/invalid')
    assert.ok(error.message.includes('delete-everything'))
  })
})

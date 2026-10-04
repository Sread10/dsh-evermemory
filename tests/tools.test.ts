import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { after, describe, test } from 'node:test'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'

import { unwrapConfig } from '../src/config.ts'
import type { ResolvedConfig } from '../src/config.ts'
import { createSession, listVisible } from '../src/memory/service.ts'
import { openStore, type OpenStore } from '../src/storage/db.ts'
import { StoreHandle } from '../src/storage/handle.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import { mountMemoryTools } from '../src/tools/memory.ts'

/**
 * The tool set is the plugin's only write path from a conversation (constraint #5: user messages
 * are never intercepted), so these tests drive the tools the way the host does — through
 * `execute` — and check three things at once:
 *
 *  1. the value's SHAPE matches the declared output schema, because the host validates that value
 *     and rejects the call if it does not (dsh-tools/lib/index.js:3544). A field added to a
 *     service result and not to the schema would fail in production, not here, without the check
 *     in {@link call};
 *  2. the WRITE landed in the right layer, read back through the repository rather than trusted
 *     from the tool's own report;
 *  3. the RENDERED text says something a model can act on, since that text — not the value — is
 *     what reaches the conversation.
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

/** A working directory that resolves to a project: a marker file is what makes the identity
 * trustworthy, and an untrustworthy identity silently sends every project write to `global`. */
function projectDir(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'evm-tools-')), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}\n')
  return dir
}

interface Runtime {
  readonly store: OpenStore
  readonly repository: MemoryRepository
  readonly handle: StoreHandle
  readonly config: ResolvedConfig
  readonly tools: Map<string, ToolDefinition<never, unknown>>
}

async function runtime(config: Partial<ResolvedConfig> = {}): Promise<Runtime> {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-tools-db-')), 'store.sqlite') })
  stores.push(store)
  const repository = new MemoryRepository(store.db)
  const handle = new StoreHandle()
  handle.adopt(repository, store)

  const resolved = unwrapConfig(config as never)
  const tools = new Map<string, ToolDefinition<never, unknown>>()
  const ctx = {
    get(service: string) {
      if (service !== 'tools') return undefined
      return {
        register(definition: ToolDefinition<never, unknown>) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      }
    },
  }

  const mounted = mountMemoryTools(ctx as never, resolved, handle)
  assert.equal(mounted, 4, 'all four tools must mount')
  return { store, repository, handle, config: resolved, tools }
}

/** A `ToolExecution` as the host builds it: the calling agent carries the working directory. */
function execution(cwd: string, aborted = false): ToolExecution {
  return {
    name: 'evermemory_test',
    signal: { aborted },
    agent: { session: { header: { cwd } } },
  } as unknown as ToolExecution
}

interface CallResult<Value> {
  readonly value: Value
  readonly text: string
}

/**
 * Call one tool and validate its value against its declared schema.
 *
 * The validation is a small re-implementation of the host's value check, and it is here rather
 * than in the shim because it runs against REAL results: `additionalProperties: false` plus a
 * service result that grew a field is exactly the bug that passes every other test and then fails
 * at the first tool call in a real host.
 */
async function call<Value>(
  rt: Runtime,
  name: string,
  args: unknown,
  cwd: string,
  options: { aborted?: boolean } = {},
): Promise<CallResult<Value>> {
  const definition = rt.tools.get(name)
  assert.ok(definition !== undefined, `${name} must be registered`)
  const value = (await definition.execute(args as never, execution(cwd, options.aborted ?? false))) as Value
  check(definition.output.schema as SchemaNode, value, `${name}.output`)
  const rendered = definition.output.render(args as never, value as never)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} must render something`)
  return { value, text: rendered.map((block) => block.text).join('\n') }
}

interface SchemaNode {
  readonly type?: string
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly additionalProperties?: boolean
  readonly items?: SchemaNode
  readonly oneOf?: readonly SchemaNode[]
  readonly enum?: readonly unknown[]
  readonly const?: unknown
}

function check(schema: SchemaNode, value: unknown, path: string): void {
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.some((branch) => {
      try {
        check(branch, value, path)
        return true
      } catch {
        return false
      }
    })
    assert.ok(matched, `${path}: value matches no oneOf branch`)
    return
  }
  if (schema.type === 'json') return
  if (schema.enum !== undefined) assert.ok(schema.enum.includes(value), `${path}: value is not in enum`)
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${path}: value is not the const`)
  switch (schema.type) {
    case 'string':
      assert.equal(typeof value, 'string', `${path}: expected a string`)
      break
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${path}: expected a boolean`)
      break
    case 'integer':
      assert.ok(Number.isInteger(value), `${path}: expected an integer`)
      break
    case 'number':
      assert.equal(typeof value, 'number', `${path}: expected a number`)
      break
    case 'null':
      assert.equal(value, null, `${path}: expected null`)
      break
    case 'array':
      assert.ok(Array.isArray(value), `${path}: expected an array`)
      if (schema.items !== undefined) {
        value.forEach((entry, index) => check(schema.items as SchemaNode, entry, `${path}[${index}]`))
      }
      break
    case 'object': {
      assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${path}: expected an object`)
      const record = value as Record<string, unknown>
      const properties = schema.properties ?? {}
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          assert.ok(key in properties, `${path}.${key} is not declared in the output schema`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (key in record) check(child, record[key], `${path}.${key}`)
      }
      break
    }
    default:
      break
  }
}

/** The project key the tools will use for a directory, and a precondition that it is not null. */
function keyOf(cwd: string): string {
  const session = createSession(cwd)
  assert.ok(
    session.projectKey !== null,
    `precondition: ${cwd} must resolve to a trustworthy project, else every project assertion below passes for the wrong reason`,
  )
  return session.projectKey
}

describe('mounting', () => {
  test('registers the four conversational tools under the evermemory prefix', async () => {
    const rt = await runtime()
    assert.deepEqual(
      [...rt.tools.keys()].sort(),
      ['evermemory_forget', 'evermemory_log', 'evermemory_remember', 'evermemory_search'],
    )
    for (const [name, definition] of rt.tools) {
      assert.equal(definition.name, name)
      assert.ok(definition.description.length > 40, `${name} needs a description a model can route on`)
      // The schemas were checked when `defineTool` was called: the shim re-implements the host's
      // eager compilation, so a malformed schema fails this test rather than the plugin mount.
      assert.ok(definition.output.render instanceof Function)
    }
  })

  test('registers nothing when the host has no tools service', () => {
    const handle = new StoreHandle()
    const mounted = mountMemoryTools({ get: () => undefined } as never, unwrapConfig({} as never), handle)
    assert.equal(mounted, 0)
  })
})

describe('remember', () => {
  test('writes an entry, reports its id, and files it in the project layer', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const key = keyOf(cwd)

    const { value, text } = await call<{ decision: string, id?: number, scope: string, superseded: number[] }>(
      rt,
      'evermemory_remember',
      { text: 'this project builds with pnpm, never npm' },
      cwd,
    )

    assert.equal(value.decision, 'new')
    assert.equal(value.scope, 'project')
    assert.equal(typeof value.id, 'number')
    assert.deepEqual(value.superseded, [])
    assert.match(text, new RegExp(`#${value.id}`))

    const row = rt.repository.get(value.id as number)
    assert.ok(row !== undefined, 'the reported id must exist')
    assert.equal(row.scope, 'project')
    assert.equal(row.projectKey, key)
    assert.equal(row.source, 'dialogue')
    assert.equal(row.status, 'active')
    assert.match(row.text, /pnpm/u)
  })

  test('an explicit scope overrides the layer the text would have suggested', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')

    const { value } = await call<{ decision: string, scope: string }>(
      rt,
      'evermemory_remember',
      { text: 'this project builds with pnpm, never npm', scope: 'global' },
      cwd,
    )
    assert.equal(value.scope, 'global')
  })

  test('the same statement twice is recognised, not duplicated', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const args = { text: 'deployments go out on Thursday afternoons' }

    const first = await call<{ decision: string, id?: number }>(rt, 'evermemory_remember', args, cwd)
    const rowCount = rt.repository.count({ status: 'active' })
    const second = await call<{ decision: string, id?: number, reason: string }>(rt, 'evermemory_remember', args, cwd)

    assert.equal(second.value.decision, 'ignore')
    assert.match(second.value.reason, /identical to memory #\d+/u)
    assert.equal(rt.repository.count({ status: 'active' }), rowCount, 'nothing new may be written')
    assert.equal(first.value.id, second.value.id)
  })

  test('a correction supersedes the statement it corrects', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')

    const first = await call<{ id?: number }>(
      rt,
      'evermemory_remember',
      { text: 'the staging deploy target is staging.example.com' },
      cwd,
    )
    const second = await call<{ decision: string, id?: number, superseded: number[], text: string }>(
      rt,
      'evermemory_remember',
      { text: 'correction: the deploy target is production.example.com, not staging' },
      cwd,
    )

    assert.equal(second.value.decision, 'update', 'an unmatched correction revises rather than appends')
    assert.deepEqual(second.value.superseded, [first.value.id])
    const superseded = rt.repository.get(first.value.id as number)
    assert.notEqual(superseded?.status, 'active', 'the corrected entry must stop being injected')
    assert.equal(rt.repository.count({ status: 'active' }), 1)
  })

  test('a rejected statement is reported with its reason instead of being stored', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')

    const { value, text } = await call<{ decision: string, reason: string, id?: number }>(
      rt,
      'evermemory_remember',
      { text: '你还记得我之前说过什么吗' },
      cwd,
    )

    assert.equal(value.decision, 'rejected')
    assert.match(value.reason, /session-recall/u)
    assert.equal(value.id, undefined, 'a rejected write reports no id')
    assert.equal(rt.repository.count(), 0, 'a rejected write stores nothing')
    assert.match(text, /not stored/u)
  })
})

describe('forget', () => {
  test('archives the entry instead of deleting it', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const remembered = await call<{ id?: number }>(
      rt,
      'evermemory_remember',
      { text: 'this project builds with pnpm, never npm' },
      cwd,
    )
    const id = remembered.value.id as number

    const { value, text } = await call<{ ok: boolean, status: string, text: string }>(
      rt,
      'evermemory_forget',
      { id },
      cwd,
    )

    assert.equal(value.ok, true)
    assert.equal(value.status, 'archived')
    assert.match(text, new RegExp(`forgot #${id}`, 'u'))
    const row = rt.repository.get(id)
    assert.ok(row !== undefined, 'forget archives; the row stays')
    assert.equal(row.status, 'archived')
  })

  test('is idempotent: forgetting an archived entry reports it plainly', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const remembered = await call<{ id?: number }>(
      rt,
      'evermemory_remember',
      { text: 'this project builds with pnpm, never npm' },
      cwd,
    )
    const id = remembered.value.id as number
    await call(rt, 'evermemory_forget', { id }, cwd)

    const { value } = await call<{ ok: boolean, reason: string }>(rt, 'evermemory_forget', { id }, cwd)
    assert.equal(value.ok, true)
    assert.equal(value.reason, 'already archived')
  })

  test('refuses the identity layer, which the plugin does not own', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const key = keyOf(cwd)
    const row = rt.repository.insert({ text: 'the user is a backend engineer', scope: 'identity', projectKey: key })

    const { value, text } = await call<{ ok: boolean, reason: string }>(rt, 'evermemory_forget', { id: row.id }, cwd)
    assert.equal(value.ok, false)
    assert.match(value.reason, /identity layer/u)
    assert.match(text, /not forgotten/u)
    assert.equal(rt.repository.get(row.id)?.status, 'active')
  })

  test("refuses an entry owned by another project", async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const other = projectDir('beta')
    const otherKey = keyOf(other)
    const row = rt.repository.insert({ text: 'beta builds with bun', scope: 'project', projectKey: otherKey })

    const { value } = await call<{ ok: boolean, reason: string }>(rt, 'evermemory_forget', { id: row.id }, cwd)
    assert.equal(value.ok, false)
    assert.match(value.reason, /another project/u)
    assert.equal(rt.repository.get(row.id)?.status, 'active', 'a cross-project forget must not archive')
  })

  test('reports an unknown id rather than throwing', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const { value } = await call<{ ok: boolean, status: string, reason: string }>(
      rt,
      'evermemory_forget',
      { id: 4242 },
      cwd,
    )
    assert.equal(value.ok, false)
    assert.equal(value.status, 'unknown')
    assert.match(value.reason, /no memory #4242/u)
  })
})

describe('search', () => {
  test('finds Chinese text, which the FTS tokenizer alone cannot do', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    await call(
      rt,
      'evermemory_remember',
      { text: '项目统一使用 pnpm 安装依赖，不要用 npm', scope: 'project' },
      cwd,
    )

    const english = await call<{ count: number, entries: { id: number, text: string }[] }>(
      rt,
      'evermemory_search',
      { query: 'pnpm' },
      cwd,
    )
    assert.equal(english.value.count, 1)

    const chinese = await call<{ count: number, entries: { text: string }[] }>(
      rt,
      'evermemory_search',
      { query: '依赖' },
      cwd,
    )
    assert.equal(chinese.value.count, 1, 'a two-character CJK query must match')
    assert.match(chinese.value.entries[0]?.text ?? '', /pnpm/u)
    assert.match(chinese.text, /#\d+ \[project\]/u)
  })

  test('never returns another project\'s memories', async () => {
    const rt = await runtime()
    const alpha = projectDir('alpha')
    const beta = projectDir('beta')
    await call(rt, 'evermemory_remember', { text: 'alpha builds with pnpm', scope: 'project' }, alpha)
    await call(rt, 'evermemory_remember', { text: 'beta builds with bun', scope: 'project' }, beta)

    const { value } = await call<{ entries: { text: string }[] }>(rt, 'evermemory_search', { query: 'builds' }, alpha)
    assert.equal(value.entries.length, 1)
    assert.match(value.entries[0]?.text ?? '', /alpha/u)
  })

  test('lists the most recently used entries when no query is given', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    await call(rt, 'evermemory_remember', { text: 'alpha builds with pnpm' }, cwd)
    await call(rt, 'evermemory_remember', { text: 'the release branch is release/next' }, cwd)

    const { value, text } = await call<{ count: number, query: string }>(rt, 'evermemory_search', {}, cwd)
    assert.equal(value.count, 2)
    assert.equal(value.query, '')
    assert.match(text, /2 entries/u)
  })

  test('an empty store says so instead of rendering an empty list', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const { value, text } = await call<{ count: number }>(rt, 'evermemory_search', {}, cwd)
    assert.equal(value.count, 0)
    assert.match(text, /no memories recorded yet/u)
  })

  test('lists an explicitly requested layer, including the identity layer', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    // Inserted directly: the identity layer is owned by the hand-edited file, and the tools
    // refuse to write it, so nothing here could have created this row.
    rt.repository.insert({ text: 'the user writes in Chinese', scope: 'identity', title: '语言' })
    await call(rt, 'evermemory_remember', { text: 'alpha builds with pnpm' }, cwd)

    const identity = await call<{ count: number, entries: { scope: string }[] }>(
      rt,
      'evermemory_search',
      { scope: 'identity' },
      cwd,
    )
    assert.equal(identity.value.count, 1, 'the layer is listed rather than listed-and-filtered-away')
    assert.equal(identity.value.entries[0]?.scope, 'identity')
    // A layer request is a filter, not an addition: the project row must not be swept in with it.
    assert.doesNotMatch(identity.text, /pnpm/u)
  })

  test('a layer request stays inside this project', async () => {
    const rt = await runtime()
    const alpha = projectDir('alpha')
    const beta = projectDir('beta')
    await call(rt, 'evermemory_remember', { text: 'beta ships on Friday', scope: 'project' }, beta)
    await call(rt, 'evermemory_remember', { text: 'alpha uses pnpm', scope: 'project' }, alpha)

    const own = await call<{ entries: { text: string }[] }>(rt, 'evermemory_search', { scope: 'project' }, alpha)
    assert.equal(own.value.entries.length, 1, 'the layer name alone must not open every project')
    assert.match(own.value.entries[0]?.text ?? '', /alpha/u)
  })

  test('clamps the requested limit to the configured maximum', async () => {
    const rt = await runtime({ searchLimitMax: 2 } as never)
    const cwd = projectDir('alpha')
    // Inserted directly rather than remembered: three remembers of similar statements would be
    // merged into one row by the gate, and the count would then test the merge, not the clamp.
    for (const text of ['alpha uses pnpm', 'beta ships on Friday', 'gamma owns the schema']) {
      rt.repository.insert({ text, scope: 'global' })
    }

    const wide = await call<{ count: number }>(rt, 'evermemory_search', { query: 'alpha', limit: 500 }, cwd)
    assert.equal(wide.value.count, 1, 'only one row matches the query')

    const all = await call<{ count: number }>(rt, 'evermemory_search', {}, cwd)
    assert.equal(all.value.count, 2, 'the configured maximum wins over the request')

    rt.repository.insert({ text: 'delta owns the parser', scope: 'global' })
    const narrow = await call<{ count: number }>(rt, 'evermemory_search', { limit: 0 }, cwd)
    assert.equal(narrow.value.count, 1, 'a zero limit is raised to one')
  })
})

describe('log', () => {
  test('appends to today and reports the day row', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')

    const { value, text } = await call<{ date: string, written: number, id?: number }>(
      rt,
      'evermemory_log',
      { entries: ['wired the tool set', 'found the daily-layer leak'] },
      cwd,
    )

    assert.equal(value.written, 2)
    assert.match(value.date, /^\d{4}-\d{2}-\d{2}$/u)
    assert.equal(typeof value.id, 'number')
    assert.match(text, /appended 2 entries/u)

    const row = rt.repository.get(value.id as number)
    assert.equal(row?.scope, 'daily')
    assert.match(row?.text ?? '', /wired the tool set/u)
    assert.match(row?.text ?? '', /found the daily-layer leak/u)
  })

  test('files an explicit date under that day and revives it if archived', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const first = await call<{ id?: number }>(rt, 'evermemory_log', { entries: ['day one'], date: '2026-02-14' }, cwd)
    rt.repository.update(first.value.id as number, { status: 'archived' })

    const second = await call<{ id?: number, written: number }>(
      rt,
      'evermemory_log',
      { entries: ['day two'], date: '2026-02-14' },
      cwd,
    )

    assert.equal(second.value.id, first.value.id, 'one row per day, not one per call')
    const row = rt.repository.get(first.value.id as number)
    assert.equal(row?.status, 'active', 'appending to an archived day brings it back')
    assert.match(row?.text ?? '', /day one/u)
    assert.match(row?.text ?? '', /day two/u)
  })

  test('reports an empty entry list instead of writing an empty day', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    const { value, text } = await call<{ written: number, reason: string }>(
      rt,
      'evermemory_log',
      { entries: [] },
      cwd,
    )
    assert.equal(value.written, 0)
    assert.equal(value.reason, 'no log entries to write')
    assert.match(text, /nothing appended/u)
  })
})

describe('failures are reported, not thrown at the model as filesystem errors', () => {
  test('a store that cannot be opened reports an unavailable database', async () => {
    // A home directory whose parent is a FILE: creating the store directory under it must fail.
    const blocker = join(mkdtempSync(join(tmpdir(), 'evm-tools-block-')), 'blocker')
    writeFileSync(blocker, 'not a directory\n')
    const handle = new StoreHandle(join(blocker, 'home'))
    const tools = new Map<string, ToolDefinition<never, unknown>>()
    const ctx = {
      get(service: string) {
        return service === 'tools' ? { register: (definition: ToolDefinition<never, unknown>) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        } } : undefined
      },
    }
    mountMemoryTools(ctx as never, unwrapConfig({} as never), handle)

    const definition = tools.get('evermemory_remember')
    assert.ok(definition !== undefined)
    await assert.rejects(
      async () => definition.execute({ text: 'alpha builds with pnpm' } as never, execution(projectDir('alpha'))),
      /memory database is unavailable/u,
    )
  })

  test('an aborted call writes nothing', async () => {
    const rt = await runtime()
    const cwd = projectDir('alpha')
    await assert.rejects(
      async () => call(rt, 'evermemory_remember', { text: 'alpha builds with pnpm' }, cwd, { aborted: true }),
      /cancelled/u,
    )
    assert.equal(rt.repository.count(), 0)
  })
})

/**
 * A working directory that resolves to NO project at all, so the session has a null project key.
 *
 * The path is deliberately one that does not exist, sitting directly under the volume root.
 * Identity resolution walks UP from the directory looking for a marker file, and a marker above
 * the temp directory makes an ordinary temp fixture a trustworthy project on some machines and
 * not on others — `~/.dsh` is a marker, so on a machine with a DSH home every temp directory
 * beneath it resolves to that home as a project, while `D:\SKILL制作` — the live example that
 * produced this suite — resolves to nothing. The volume root holds no marker, so this path ends
 * the chain the same way everywhere: `source: 'cwd'`, and untrustworthy.
 *
 * Existence is irrelevant to identity resolution, and the store these tests write to is a temp
 * database, so nothing here needs the directory to be real — only for the walk above it to be the
 * one a session with no project sees.
 */
function unprojectedDir(): string {
  const dir = join(parse(tmpdir()).root, 'evm-tools-no-project')
  assert.equal(
    createSession(dir).projectKey,
    null,
    `precondition: ${dir} must resolve to no project, else the null-key assertions below pass for the wrong reason`,
  )
  return dir
}

describe('a session with no project', () => {
  test('reads back the journal entry it just wrote', async () => {
    const rt = await runtime()
    const cwd = unprojectedDir()

    const logged = await call<{ written: number, id?: number }>(
      rt,
      'evermemory_log',
      { entries: ['tried the unprojected layer'] },
      cwd,
    )
    assert.equal(logged.value.written, 1)
    assert.equal(
      rt.repository.get(logged.value.id as number)?.projectKey,
      null,
      'the day is filed under a null key: that is the layer under test, not an accident of the fixture',
    )

    const found = await call<{ count: number, entries: { id: number, scope: string, text: string }[] }>(
      rt,
      'evermemory_search',
      { query: 'unprojected' },
      cwd,
    )
    assert.equal(found.value.count, 1, 'an entry the session wrote has to be findable by the session')
    assert.equal(found.value.entries[0]?.id, logged.value.id)
    assert.equal(found.value.entries[0]?.scope, 'daily')
    assert.match(found.text, /#\d+ \[daily\]/u)
  })

  test('lists it when the daily layer is requested, and reports nothing for the project layer', async () => {
    const rt = await runtime()
    const cwd = unprojectedDir()
    await call(rt, 'evermemory_log', { entries: ['shipped the daily fix'] }, cwd)

    const daily = await call<{ count: number, entries: { scope: string, text: string }[] }>(
      rt,
      'evermemory_search',
      { scope: 'daily' },
      cwd,
    )
    assert.equal(daily.value.count, 1, 'the unprojected day is a layer this session can list')
    assert.equal(daily.value.entries[0]?.scope, 'daily')

    const project = await call<{ count: number }>(rt, 'evermemory_search', { scope: 'project' }, cwd)
    assert.equal(project.value.count, 0, 'a session with no project has no project layer to list')
  })

  test('never sees a keyed row, and a keyed session never sees the unprojected day', async () => {
    const rt = await runtime()
    const plain = unprojectedDir()
    const alpha = projectDir('alpha')
    // A day on each side and a project rule, so every direction of a leak has a row to leak.
    await call(rt, 'evermemory_log', { entries: ['unprojected day'] }, plain)
    await call(rt, 'evermemory_log', { entries: ['keyed day'] }, alpha)
    await call(rt, 'evermemory_remember', { text: 'alpha builds with pnpm', scope: 'project' }, alpha)

    const fromPlain = await call<{ count: number, entries: { text: string }[] }>(rt, 'evermemory_search', {}, plain)
    assert.equal(fromPlain.value.count, 1, 'the unprojected session owns one row: its own day')
    assert.match(fromPlain.value.entries[0]?.text ?? '', /unprojected day/u)

    const fromAlpha = await call<{ count: number, entries: { text: string }[] }>(rt, 'evermemory_search', {}, alpha)
    assert.equal(fromAlpha.value.count, 2, 'the project session owns its rule and its own day')
    assert.ok(
      fromAlpha.value.entries.every((entry) => !entry.text.includes('unprojected day')),
      `the unprojected day leaked into a project session: ${JSON.stringify(fromAlpha.value.entries)}`,
    )

    // A query with terms that the strict `AND` cannot satisfy is retried with `OR`
    // (`src/retrieval/retriever.ts:152-171`), so this search legitimately returns this session's
    // own day — the one that shares the word "day". What it must never return is the other side's
    // row: a null key is a layer, not a wildcard.
    const cross = await call<{ entries: { text: string }[] }>(
      rt,
      'evermemory_search',
      { query: 'unprojected day' },
      alpha,
    )
    assert.ok(
      cross.value.entries.every((entry) => !entry.text.includes('unprojected day')),
      `the unprojected day is reachable from a keyed session: ${JSON.stringify(cross.value.entries)}`,
    )

    const reverse = await call<{ count: number }>(rt, 'evermemory_search', { query: 'pnpm' }, plain)
    assert.equal(reverse.value.count, 0, 'and the keyed project rule is not reachable from the null key')
  })

  test('can archive its own unprojected day, and still cannot archive a keyed one', async () => {
    // Write and read were fixed together; a row a session may create but never retract would pile
    // up forever, so the ownership guard has to read the null key the same way the readers do.
    const rt = await runtime()
    const plain = unprojectedDir()
    const alpha = projectDir('alpha')

    const own = await call<{ id?: number }>(rt, 'evermemory_log', { entries: ['a note to retract'] }, plain)
    const forgotten = await call<{ ok: boolean, status: string }>(rt, 'evermemory_forget', { id: own.value.id }, plain)
    assert.equal(forgotten.value.ok, true)
    assert.equal(forgotten.value.status, 'archived')

    const keyed = await call<{ id?: number }>(rt, 'evermemory_log', { entries: ['alpha note'] }, alpha)
    const refused = await call<{ ok: boolean, reason: string }>(rt, 'evermemory_forget', { id: keyed.value.id }, plain)
    assert.equal(refused.value.ok, false, 'an unprojected session must not reach a keyed row')
    assert.match(refused.value.reason, /another project/u)
  })

  test('the injection reader and the search tool agree about what it owns', async () => {
    // `listVisible` is what the injection engine's index/card reader calls, and its own doc says
    // the two callers "must agree". They did not: a session could be told about a memory by a tool
    // and never see it in the prompt, or the reverse.
    const rt = await runtime()
    const cwd = unprojectedDir()
    const logged = await call<{ id?: number }>(rt, 'evermemory_log', { entries: ['the unprojected layer is real'] }, cwd)

    const visible = listVisible(rt.repository, createSession(cwd).projectKey, { status: 'active' })
    assert.deepEqual(visible.map((row) => row.id), [logged.value.id])
  })
})

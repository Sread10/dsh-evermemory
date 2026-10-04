import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'

import { unwrapConfig } from '../src/config.ts'
import { createSession } from '../src/memory/service.ts'
import { openStore, type OpenStore } from '../src/storage/db.ts'
import { StoreHandle } from '../src/storage/handle.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import { mountImportTools } from '../src/tools/import.ts'

/**
 * The import tool, driven the way the host drives it.
 *
 * The runner's own tests cover policy with literal items; this file covers the join between the
 * conversation and the filesystem — that a path the model names actually gets read, that the
 * calling session's project is the one an import is filed into, and that a failure comes back as a
 * value the model can explain rather than as a thrown error the host turns into a stack trace.
 *
 * Every call validates the returned value against the tool's own output schema, because the host
 * does (`dsh-tools/lib/index.js:3544`) and `additionalProperties: false` means a field added here
 * and not to the schema fails at the first call in production.
 */

const stores: OpenStore[] = []
const dirs: string[] = []

after(() => {
  for (const store of stores) {
    try {
      store.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A working directory that resolves to a project, plus a scratch directory for fixtures. */
function workspace(): { cwd: string; scratch: string } {
  const root = mkdtempSync(join(tmpdir(), 'evm-import-tool-'))
  dirs.push(root)
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'package.json'), '{}\n')
  return { cwd, scratch: root }
}

interface Runtime {
  readonly repository: MemoryRepository
  readonly tools: Map<string, ToolDefinition<never, unknown>>
}

async function runtime(): Promise<Runtime> {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-import-db-')), 'store.sqlite') })
  stores.push(store)
  const repository = new MemoryRepository(store.db)
  const handle = new StoreHandle()
  handle.adopt(repository, store)

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

  const mounted = mountImportTools(ctx as never, unwrapConfig({}), handle)
  assert.equal(mounted, 1)
  return { repository, tools }
}

/** A `ToolExecution` as the host builds it. */
function execution(cwd: string): ToolExecution {
  return { name: 'evermemory_import', signal: { aborted: false }, agent: { session: { header: { cwd } } } } as unknown as ToolExecution
}

interface SchemaNode {
  readonly type?: string
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly additionalProperties?: boolean
  readonly items?: SchemaNode
}

/** Undeclared keys are the failure the host rejects, so this checks exactly that. */
function check(schema: SchemaNode, value: unknown, path: string): void {
  if (schema.type === 'object') {
    assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${path}: expected an object`)
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const declared = schema.properties?.[key]
      assert.ok(declared !== undefined, `${path}.${key} is not declared in the output schema`)
      check(declared, inner, `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path}: expected an array`)
    for (const [index, entry] of (value as readonly unknown[]).entries()) {
      if (schema.items !== undefined) check(schema.items, entry, `${path}[${index}]`)
    }
    return
  }
  if (schema.type === 'integer') assert.equal(typeof value, 'number')
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean')
  else if (schema.type === 'string') assert.equal(typeof value, 'string')
}

interface CallResult<Value> {
  readonly value: Value
  readonly text: string
}

async function call<Value>(rt: Runtime, args: unknown, cwd: string): Promise<CallResult<Value>> {
  const definition = rt.tools.get('evermemory_import')
  assert.ok(definition !== undefined, 'the import tool must be registered')
  const value = (await definition.execute(args as never, execution(cwd))) as Value
  check(definition.output.schema as SchemaNode, value, 'evermemory_import.output')
  const rendered = definition.output.render(args as never, value as never)
  assert.ok(Array.isArray(rendered) && rendered.length > 0)
  return { value, text: rendered.map((block) => block.text).join('\n') }
}

/** Two entries in this plugin's own JSON Lines export shape. */
function exportFile(scratch: string, entries: readonly Record<string, unknown>[]): string {
  const path = join(scratch, 'evermemory-export.jsonl')
  const lines = [{ evermemory: 1, version: '0.0.1' }, ...entries].map((entry) => JSON.stringify(entry))
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('import tool', () => {
  test('is registered with a description that names the sources it reads', async () => {
    const rt = await runtime()
    const definition = rt.tools.get('evermemory_import')
    assert.ok(definition !== undefined)
    assert.match(definition.description, /ChatGPT/u)
    assert.match(definition.description, /ZCode/u)
    assert.match(definition.description, /Claude Code/u)
  })

  test('imports an export file and reports each decision', async () => {
    const { cwd, scratch } = workspace()
    const rt = await runtime()
    const path = exportFile(scratch, [
      { text: 'Deploys go out on Thursday afternoons.', title: 'Deploys', tags: ['ops'] },
      { text: 'The staging database is rebuilt every Sunday night.', title: 'Staging' },
    ])

    const { value, text } = await call<{ ok: boolean; written: number; source: string; considered: number }>(rt, { path }, cwd)

    assert.equal(value.ok, true)
    assert.equal(value.source, 'evermemory export')
    assert.equal(value.written, 2)
    assert.equal(value.considered, 2)
    assert.match(text, /imported from evermemory export: 2 of 2/u)
    assert.match(text, /2 new/u)
    assert.equal(rt.repository.count({ scope: ['global'] }), 2)
    assert.deepEqual(rt.repository.list({ scope: ['global'] }).map((row) => row.sourcePlatform), ['evermemory', 'evermemory'])
  })

  test('files a project import into the calling session project, not into a new one', async () => {
    const { cwd, scratch } = workspace()
    const rt = await runtime()
    const path = exportFile(scratch, [{ text: 'This checkout builds with pnpm, never npm.' }])
    const expected = createSession(cwd).projectKey
    assert.ok(expected !== null, 'the fixture directory must resolve to a project, or this proves nothing')

    const { value } = await call<{ written: number }>(rt, { path, scope: 'project' }, cwd)

    assert.equal(value.written, 1)
    const rows = rt.repository.list({ scope: ['project'], projectKey: expected })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.projectKey, expected)
  })

  test('a dry run reports the same work and changes nothing', async () => {
    const { cwd, scratch } = workspace()
    const rt = await runtime()
    const path = exportFile(scratch, [{ text: 'Standups are at 09:30 on weekdays.' }])

    const { value, text } = await call<{ dryRun: boolean; written: number }>(rt, { path, dryRun: true }, cwd)

    assert.equal(value.dryRun, true)
    assert.equal(value.written, 1)
    assert.match(text, /would import/u)
    assert.equal(rt.repository.count(), 0)
  })

  test('a path that does not exist comes back as a failure the model can explain', async () => {
    const { cwd } = workspace()
    const rt = await runtime()

    const { value, text } = await call<{ ok: boolean; errors: readonly string[] }>(rt, { path: join(cwd, 'nope.json') }, cwd)

    assert.equal(value.ok, false)
    assert.match(value.errors[0] ?? '', /nothing at/u)
    assert.match(text, /import failed:/u)
  })

  test('a format nothing recognises is refused by name', async () => {
    const { cwd, scratch } = workspace()
    const rt = await runtime()
    const path = join(scratch, 'mystery.dat')
    writeFileSync(path, 'binary-ish\x00content')

    const { value, text } = await call<{ ok: boolean; errors: readonly string[] }>(rt, { path }, cwd)

    assert.equal(value.ok, false)
    assert.match(text, /import failed:/u)
    assert.ok(value.errors.length >= 1)
  })

  test('a second run of the same file does nothing and says so', async () => {
    const { cwd, scratch } = workspace()
    const rt = await runtime()
    const path = exportFile(scratch, [{ text: 'Releases are tagged from main, never from a branch.' }])

    await call(rt, { path }, cwd)
    const { value, text } = await call<{ written: number; known: number }>(rt, { path }, cwd)

    assert.equal(value.written, 0)
    assert.equal(value.known, 1)
    assert.match(text, /skipped by the ledger/u)
    assert.equal(rt.repository.count({ scope: ['global'] }), 1)
  })
})

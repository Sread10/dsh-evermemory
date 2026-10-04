/**
 * The shipped browser half, compiled and mounted.
 *
 * Same reasoning as `tests/artifact.test.ts`, one half further out. Every check that touched
 * `lib/client.js` read it as TEXT — the contract suite for its `require` allow-list and size
 * budget, the dictionary suite for the two dictionaries — so the 0.1.0 bundle shipped with a
 * backslash in front of every backtick, which is not JavaScript. The build passed, the
 * typecheck passed, 424 tests passed, and the failure was waiting in a browser: the settings
 * section would have thrown a syntax error instead of rendering.
 *
 * So this suite does what a browser does. It compiles the artifact, runs it with a fake
 * `window.__ModuleLoader__`, resolves the module's `require` against the real `react` the
 * module table provides, and then calls the `apply` the Host would call — with a fake settings
 * shell — asserting the registrations that make the section appear at all.
 *
 * Skipped when `lib/` is absent, because a bare `npm test` on a fresh checkout has no build.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script, createContext } from 'node:vm'
import { describe, test } from 'node:test'

import { NS } from '../src/client/locale.ts'
import { API_ROUTE_PREFIX, PLUGIN_NAME } from '../src/constants.ts'

/** The published browser half. */
const BUNDLE = new URL('../lib/client.js', import.meta.url)
const SKIP = existsSync(BUNDLE) ? false : 'lib/ is not built; run `npm run build` before this suite'

/** What the client module system hands a factory. */
type Factory = (require: (name: string) => unknown) => Record<string, unknown>

interface ModuleRegistration {
  readonly id: string
  readonly factory: Factory
}

interface Harness {
  readonly module: ModuleRegistration
  readonly source: string
  readonly styles: readonly string[]
}

/** Options a registration carries, as this plugin uses them. */
interface RegistrationOptions {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly locale?: string
  readonly label?: string | (() => string)
  readonly inject?: () => Record<string, unknown>
}

interface RegistrationCall {
  readonly options: RegistrationOptions
  readonly component: unknown
}

interface DictionaryCall {
  readonly ns: string
  readonly locale: string
  readonly dict: Record<string, string>
}

/**
 * Compile and run the bundle the way the browser does.
 *
 * The `document` records the stylesheet instead of rendering it, so the CSS half is covered
 * here too: the artifact's own tail injects it, and an injected-empty tag would look the same
 * as a missing one in any text-only check.
 *
 * @returns the single module registration, the source text and the injected stylesheets.
 */
function harness(): Harness {
  const source = readFileSync(BUNDLE, 'utf8')
  const loaded: ModuleRegistration[] = []
  const styles: string[] = []

  const sandbox: Record<string, unknown> = {
    window: { __ModuleLoader__: { load: (module: ModuleRegistration) => loaded.push(module) } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: (tag: { textContent: string }) => styles.push(tag.textContent) },
    },
  }

  new Script(source, { filename: 'lib/client.js' }).runInContext(createContext(sandbox))

  assert.equal(loaded.length, 1, 'the bundle must register exactly one client module')
  const [module] = loaded
  assert.ok(module !== undefined, 'the bundle registered no module')
  return { module, source, styles }
}

/** The module table, as far as this bundle uses it. */
const nodeRequire = createRequire(import.meta.url)
function requireFromTable(name: string): unknown {
  if (name === 'react' || name === 'react/jsx-runtime') return nodeRequire(name)
  throw new Error(
    `the bundle required "${name}", which the DSH client module table does not resolve. ` +
      `Add it to the stub only if the table really carries it; otherwise move the code to the host half.`,
  )
}

interface Mount {
  readonly exports: Record<string, unknown>
  readonly dictionaries: readonly DictionaryCall[]
  readonly slots: readonly string[]
  readonly registrations: readonly RegistrationCall[]
}

/**
 * Mount the browser half on a fake client context.
 *
 * @param services - extra client services (`connection`, `configForms`) to offer.
 * @returns everything the half registered.
 */
function mount(services: Record<string, unknown> = {}): Mount {
  const { module } = harness()
  const exports = module.factory(requireFromTable)

  const dictionaries: DictionaryCall[] = []
  const slots: string[] = []
  const registrations: RegistrationCall[] = []
  const effects: string[] = []

  const slotsService = {
    inject: (slot: string, body: () => () => void) => {
      slots.push(slot)
      const dispose = body()
      assert.equal(typeof dispose, 'function', `the entry for ${slot} must return its disposer`)
    },
    register: (options: RegistrationOptions, component: unknown) => {
      registrations.push({ options, component })
      return () => undefined
    },
    entries: () => [],
  }
  const localeService = {
    register: (ns: string, locale: string, dict: Record<string, string>) => {
      dictionaries.push({ ns, locale, dict })
      return () => undefined
    },
    bind: (ns: string) => (key: string) => `${ns}:${key}`,
  }

  const ctx = {
    get: (name: string) => (name === 'slots' ? slotsService : name === 'locale' ? localeService : services[name]),
    effect: (body: () => unknown, label: string) => {
      effects.push(label)
      const dispose = body()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
  }

  const apply = exports['apply']
  assert.equal(typeof apply, 'function', 'the browser half must export apply()')
  ;(apply as (ctx: unknown) => void)(ctx)

  return { exports, dictionaries, slots, registrations }
}

describe('the shipped browser half', { skip: SKIP }, () => {
  test('compiles, and its bundled text keeps every backtick it was compiled with', () => {
    const { source } = harness()
    assert.ok(
      !source.includes('\\`'),
      'the bundle contains a backslash-escaped backtick: the body was rewritten on its way into the ' +
        'wrapper, which invalidates every template literal in it (this is the 0.1.0 defect)',
    )
  })

  test('registers one module in the loader table and requires nothing else', () => {
    const { module } = harness()
    assert.equal(module.id, PLUGIN_NAME)
    assert.equal(typeof module.factory, 'function')
    const exports = module.factory(requireFromTable)
    assert.equal(Object.prototype.toString.call(exports), '[object Module]')
    // Spread, so the comparison is between two arrays of this realm: the module's own array has
    // the VM context's `Array.prototype`, and a strict comparison would fail on the prototype
    // alone — "same structure but not reference-equal".
    assert.deepEqual([...(exports['inject'] as readonly string[])], ['slots', 'locale'])
  })

  test('injects its stylesheet once, keyed so a reload replaces it', () => {
    const { styles } = harness()
    assert.equal(styles.length, 1, 'exactly one style tag, and no second copy on a reload')
    const css = styles[0] ?? ''
    assert.match(css, /--dsw-/u)
    assert.match(css, /\.evm-/u)
  })

  test('registers both dictionaries under one namespace', () => {
    const { dictionaries } = mount()
    assert.deepEqual(
      dictionaries.map((call) => [call.ns, call.locale]),
      [
        [NS, 'zh'],
        [NS, 'en'],
      ],
    )
    const [zh, en] = dictionaries
    assert.ok(zh !== undefined && en !== undefined)
    assert.deepEqual(Object.keys(zh.dict).sort(), Object.keys(en.dict).sort())
    assert.ok(Object.keys(zh.dict).length > 100)
  })

  test('declares the settings section with the id the list slot requires', () => {
    const { slots, registrations } = mount()
    assert.deepEqual(slots, ['settings.section'])
    assert.equal(registrations.length, 1)

    const [registration] = registrations
    assert.ok(registration !== undefined)
    assert.equal(registration.options.name, 'settings.section')
    assert.equal(registration.options.id, PLUGIN_NAME)
    assert.equal(registration.options.order, 16)
    assert.equal(registration.options.locale, NS)
    assert.equal(typeof registration.component, 'function', 'the entry must carry a component')
    assert.equal(typeof registration.options.label, 'function')
    assert.equal((registration.options.label as () => string)(), `${NS}:nav.title`)
  })

  test('hands the page the translator, and the panel only when a connection exists', () => {
    const share = mount().registrations[0]?.options.inject
    assert.equal(typeof share, 'function')
    // `forms` is always a key — it is `configForms?.get(...)`, so the page must test the value.
    const withoutConnection = (share as () => Record<string, unknown>)()
    assert.deepEqual(Object.keys(withoutConnection).sort(), ['forms', 't'])
    assert.equal(withoutConnection['forms'], undefined)

    const connection = { rpc: { call: () => Promise.resolve({ ok: true, value: undefined }) } }
    const withConnection = (mount({ connection }).registrations[0]?.options.inject as () => Record<string, unknown>)()
    assert.deepEqual(Object.keys(withConnection).sort(), ['forms', 'panel', 't'])
    const panel = withConnection['panel'] as Record<string, unknown>
    assert.deepEqual(Object.keys(panel).sort(), [
      'daily',
      'exportDocument',
      'forget',
      'get',
      'importPath',
      'list',
      'log',
      'overview',
      'remember',
      'search',
      'update',
    ])
  })

  test('reaches the Host through the panel route, and turns a dropped carrier into a value', async () => {
    const calls: { channel: string; endpoint: string; payload: unknown }[] = []
    const answer = { ok: true, value: { marker: true } }
    const recording = {
      rpc: {
        call: (channel: string, endpoint: string, payload: unknown) => {
          calls.push({ channel, endpoint, payload })
          return Promise.resolve(answer)
        },
      },
    }
    const panel = (mount({ connection: recording }).registrations[0]?.options.inject as () => Record<string, unknown>)()[
      'panel'
    ] as { list: (request: unknown) => Promise<unknown> }

    assert.deepEqual(await panel.list({ limit: 10 }), answer)
    assert.deepEqual(calls, [{ channel: API_ROUTE_PREFIX, endpoint: 'list', payload: { limit: 10 } }])

    const broken = { rpc: { call: () => Promise.reject(new Error('socket closed')) } }
    const failing = (mount({ connection: broken }).registrations[0]?.options.inject as () => Record<string, unknown>)()[
      'panel'
    ] as { overview: () => Promise<{ ok: boolean; error?: { code: string; message: string } }> }

    const result = await failing.overview()
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'transport')
    // The detail keeps the cause either way. It reads `Error: socket closed` rather than
    // `socket closed` only because this Error was made in the test's realm while the bundle's
    // `instanceof Error` asks about the module realm — in a page the two are the same realm.
    assert.match(result.error?.message ?? '', /^无法连接到宿主：/u)
    assert.match(result.error?.message ?? '', /socket closed/u)
  })

  test('carries the preferences form when the Host offers one', () => {
    const forms = { get: (entryId: string) => ({ entryId, writable: true }) }
    const share = (mount({ configForms: forms }).registrations[0]?.options.inject as () => Record<string, unknown>)()
    assert.deepEqual((share['forms'] as { entryId: string }).entryId, PLUGIN_NAME)
  })
})

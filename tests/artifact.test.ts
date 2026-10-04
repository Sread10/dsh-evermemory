/**
 * The shipped artifact, mounted.
 *
 * Every other suite loads `src/`, which the loader type-strips on the way in. The file that
 * actually gets published is `lib/index.js`, and nothing checked that it RUNS: the contract suite
 * reads it as text (imports, bundle budget), and behaviour is asserted against the sources. A
 * refactor that typechecks and passes every unit test can still ship a bundle whose registrations
 * land nowhere — and the failure would only appear in a user's editor.
 *
 * So this suite imports the built host half, mounts it on a fake context, and drives one turn:
 * `agent/created`, then a step carrying a user message that matches a seeded memory. The body of
 * that memory reaches the model only through the per-turn card channel, so finding the body in the
 * rendered text proves the whole chain — bundle, store, retrieval, ledger — survives compilation.
 *
 * Skipped when `lib/` is absent, because a bare `npm test` on a fresh checkout has no build; the
 * release gate builds first (`prepack`), which is when this runs.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, test } from 'node:test'

import { CONTEXT_NAME } from '../src/inject/context.ts'
import { openStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'

/** The published entry point, resolved rather than imported so a missing build is a skip. */
const ENTRY = new URL('../lib/index.js', import.meta.url)
const HAS_BUILD = existsSync(ENTRY)
const SKIP = HAS_BUILD ? false : 'lib/ is not built; run `npm run build` before this suite'

/** The shape `src/index.ts` compiles to, as the host loader sees it. */
interface Artifact {
  readonly name: string
  readonly inject: readonly string[]
  readonly VERSION: string
  readonly PLUGIN_NAME: string
  readonly apply: (ctx: unknown, config: unknown) => void
}

interface Registration {
  readonly name: string
  readonly order: number
  readonly text: () => string
}

/**
 * A prompt registry.
 *
 * An agent's prompt takes the plugin's as its parent, because that is how the host assembles one,
 * and a same-named registration on the agent shadows the plugin's. Without the parent link the
 * artifact's plugin-level fallback would be invisible here and an agent that registered nothing
 * would look the same as one that did.
 */
class LocalPrompt {
  readonly #own: Registration[] = []
  readonly #ownContexts: Registration[] = []

  constructor(private readonly parent?: LocalPrompt) {}

  get contexts(): Registration[] {
    const shadowed = new Set(this.#ownContexts.map((call) => call.name))
    return [...(this.parent?.contexts ?? []).filter((call) => !shadowed.has(call.name)), ...this.#ownContexts]
  }

  get sections(): Registration[] {
    return [...(this.parent?.sections ?? []), ...this.#own]
  }

  get registeredContexts(): Registration[] {
    return [...this.#ownContexts]
  }

  section(call: Registration): () => void {
    this.#own.push(call)
    return () => undefined
  }

  context(call: Registration): () => void {
    this.#ownContexts.push(call)
    return () => undefined
  }

  contextText(name: string): string {
    return this.contexts.find((call) => call.name === name)?.text() ?? ''
  }
}

type Listener = (payload: unknown, next?: () => unknown) => unknown

/** The Cordis surface the artifact touches: `get`, `inject`, `on`, `effect`. */
class LocalContext {
  readonly prompt = new LocalPrompt()
  readonly tools = { register: () => () => undefined }
  readonly #listeners = new Map<string, Listener[]>()
  readonly disposers: (() => void)[] = []

  get(name: string): unknown {
    if (name === 'systemPrompt') return this.prompt
    if (name === 'tools') return this.tools
    return undefined
  }

  /** Queued rather than run: this host offers neither `connection` nor `webServer`. */
  inject(names: string[]): () => void {
    void names
    return () => undefined
  }

  on(name: string, listener: Listener, options?: unknown): () => void {
    const entries = this.#listeners.get(name) ?? []
    if ((options as { prepend?: unknown } | undefined)?.prepend === true) entries.unshift(listener)
    else entries.push(listener)
    this.#listeners.set(name, entries)
    return () => undefined
  }

  effect(body: () => unknown): () => void {
    const result = body()
    const dispose = typeof result === 'function' ? (result as () => void) : () => undefined
    this.disposers.push(dispose)
    return dispose
  }

  listenerCount(name: string): number {
    return this.#listeners.get(name)?.length ?? 0
  }

  /**
   * Fire an event.
   *
   * Given a `next` the listeners compose as the pre-step waterfall; without one they run as the
   * serial chain `agent/created` uses, where every listener runs.
   */
  async fire(name: string, payload: unknown, next?: () => unknown): Promise<unknown> {
    const entries = this.#listeners.get(name) ?? []
    assert.ok(entries.length > 0, `nothing registered for ${name}`)
    if (next === undefined) {
      let result: unknown
      for (const listener of entries) result = await listener(payload)
      return result
    }
    const chain = (index: number): unknown => {
      const listener = entries[index]
      if (listener === undefined) return next()
      return listener(payload, () => chain(index + 1))
    }
    return await chain(0)
  }
}

interface LocalAgent {
  readonly id: string
  readonly ctx: { get: (name: string) => unknown }
  readonly prompt: LocalPrompt
  readonly session: { readonly header: { readonly cwd: string } }
}

const roots: string[] = []
const originalHome = process.env['DSH_HOME']
let mounted: LocalContext | undefined

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const dispose of mounted?.disposers.reverse() ?? []) {
    try {
      dispose()
    } catch {
      // Teardown is best-effort; the store close is fire-and-forget and gets a turn below.
    }
  }
  mounted = undefined
  await new Promise((resolve) => setTimeout(resolve, 20))
})

after(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A file the store still holds open: the OS temp directory is its problem, not a failure.
    }
  }
})

describe('the shipped artifact', () => {
  test('mounts, registers per agent, and injects a memory body on the turn that asks', { skip: SKIP }, async () => {
    // The title is what the index channel renders; the body below only ever arrives as a card, so
    // finding it in the text means the card channel ran, not merely the index.
    const home = tempDir('evm-artifact-')
    const store = await openStore({ dshHome: home })
    const repository = new MemoryRepository(store.db)
    repository.insert({ text: '依赖约定\n装依赖用 pnpm，不要用 npm', scope: 'global' })
    store.db.close()
    process.env['DSH_HOME'] = home

    const artifact = (await import(ENTRY.href)) as unknown as Artifact

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly version: string
    }
    assert.equal(artifact.VERSION, pkg.version)
    assert.equal(artifact.name, artifact.PLUGIN_NAME)
    assert.deepEqual([...artifact.inject], ['tools', 'systemPrompt'])

    const ctx = new LocalContext()
    mounted = ctx
    artifact.apply(ctx, {})

    const pluginPrompt = ctx.prompt
    const agentPrompt = new LocalPrompt(pluginPrompt)
    const agent: LocalAgent = {
      id: 'artifact-agent',
      ctx: { get: (name: string) => (name === 'systemPrompt' ? agentPrompt : undefined) },
      prompt: agentPrompt,
      session: { header: { cwd: tempDir('evm-artifact-cwd-') } },
    }

    // The fallback registration is on the plugin context, and the agent's own arrives with the
    // agent — which is the isolation rule, asserted here against the compiled bundle.
    assert.equal(pluginPrompt.registeredContexts.length, 1)
    assert.equal(agentPrompt.registeredContexts.length, 0)

    await ctx.fire('agent/created', { agent })
    assert.equal(agentPrompt.registeredContexts.length, 1)
    assert.equal(agentPrompt.registeredContexts[0]?.name, CONTEXT_NAME)
    assert.equal(agentPrompt.contexts.length, 1)

    // A realistic question: it names the subject, so retrieval has a term to match on. A CJK run
    // with no verbatim overlap is a different question, and the index channel answers it.
    const asking = {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'pnpm 和 npm 该用哪个' }],
    }
    const payload = { agent, messages: [asking], turn: 1, step: 1, signal: { aborted: false } }
    const enter = (): { kind: string; messages: unknown[] } => ({ kind: 'enter', messages: [] })

    await ctx.fire('agent/pre-step', payload, enter)
    const first = agentPrompt.contextText(CONTEXT_NAME)
    assert.match(first, /\[记忆索引/u)
    assert.match(first, /不要用 npm/u)

    // Reading it twice is two steps: the card ledger lives in the bundle too, so the body is
    // offered once per session rather than once per step.
    await ctx.fire('agent/pre-step', payload, enter)
    const second = agentPrompt.contextText(CONTEXT_NAME)
    assert.doesNotMatch(second, /不要用 npm/u)
  })
})

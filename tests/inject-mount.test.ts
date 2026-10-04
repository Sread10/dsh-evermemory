/**
 * The registration table, tested.
 *
 * This is the architectural decision of step 5, and it is invisible to every other suite: the rules
 * section and the memory context must both be registered on the AGENT's context (each reads that
 * agent's project), while the tail reminder and the per-step listener belong to the PLUGIN context.
 * A test that only exercised `InjectionState` would pass just as happily with the sections on the
 * wrong context — and the failure mode is silent: rules and memories for one project applied to
 * every other one.
 *
 * The fake context is deliberately structural rather than a Cordis mock. The plugin reaches the
 * prompt service through `ctx.get('systemPrompt')`, so a fake that merely hangs a `systemPrompt`
 * property off the context would let a broken lookup pass.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, test } from 'node:test'

import { apply } from '../src/index.ts'
import {
  ORDER_MEMORY_TAIL_REMINDER,
  ORDER_RULES,
  ORDER_RUNTIME_CONTEXT,
  STEP_QUERY_CHARS,
} from '../src/constants.ts'
import { CONTEXT_NAME } from '../src/inject/context.ts'
import { stepQuery } from '../src/inject/mount.ts'
import { TAIL_REMINDER, TAIL_SECTION_NAME } from '../src/inject/reminder.ts'
import { createSession } from '../src/memory/service.ts'
import { RULES_SECTION_NAME } from '../src/rules/section.ts'
import { openStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import type { NewMemory } from '../src/storage/repository.ts'

interface SectionCall {
  readonly name: string
  readonly order: number
  readonly text: () => string
  readonly interpolate?: boolean
}

interface ContextCall {
  readonly name: string
  readonly order: number
  readonly text: () => string
}

/**
 * A prompt registry.
 *
 * An agent's prompt carries the plugin's as its parent, because that is how the host assembles one:
 * a registration made on the plugin context reaches every agent, and a same-named registration on
 * an agent context shadows it for that agent alone. Without that merge this suite could not tell
 * "scoped to this agent" apart from "not registered at all" — and the fallback registrations, which
 * exist precisely for the sessions that get nothing else, would look like they were in force
 * everywhere.
 */
class FakePrompt {
  readonly #own: SectionCall[] = []
  readonly #ownContexts: ContextCall[] = []

  constructor(private readonly parent?: FakePrompt) {}

  /** What the assembly sees: the parent's contributions, then this context's own. */
  get sections(): SectionCall[] {
    return merge(this.parent?.sections ?? [], this.#own)
  }

  get contexts(): ContextCall[] {
    return merge(this.parent?.contexts ?? [], this.#ownContexts)
  }

  /** Only what was registered on this context, for asserting WHERE a registration landed. */
  get registeredSections(): SectionCall[] {
    return [...this.#own]
  }

  get registeredContexts(): ContextCall[] {
    return [...this.#ownContexts]
  }

  section(call: SectionCall): () => void {
    this.#own.push(call)
    return () => undefined
  }

  context(call: ContextCall): () => void {
    this.#ownContexts.push(call)
    return () => undefined
  }

  named(name: string): SectionCall | undefined {
    return this.sections.find((section) => section.name === name)
  }

  /** The text a named runtime context renders, which is what the model would receive. */
  contextText(name: string): string {
    return this.contexts.find((call) => call.name === name)?.text() ?? ''
  }
}

/** Parent entries, then the child's — minus any parent entry the child shadows by name. */
function merge<T extends { readonly name: string }>(parent: readonly T[], own: readonly T[]): T[] {
  const shadowed = new Set(own.map((entry) => entry.name))
  return [...parent.filter((entry) => !shadowed.has(entry.name)), ...own]
}

type Listener = (payload: unknown, next?: () => unknown) => unknown

interface Registered {
  readonly listener: Listener
  readonly options: unknown
}

interface FakeTool {
  readonly description: string
  /** The definition's `execute`, kept so a test can drive a tool the way the host would. */
  readonly run: ((args: unknown, exec: unknown) => Promise<unknown>) | undefined
}

/** The slice of `ctx.tools` the plugin uses. */
class FakeTools {
  readonly registered = new Map<string, FakeTool>()

  register(definition: {
    readonly name: string
    readonly description?: string
    readonly execute?: unknown
  }): () => void {
    this.registered.set(definition.name, {
      description: definition.description ?? '',
      run: definition.execute as ((args: unknown, exec: unknown) => Promise<unknown>) | undefined,
    })
    return () => this.registered.delete(definition.name)
  }
}

/** The slice of the Cordis context the plugin uses: `get`, `on`, `effect`, `inject`. */
class FakeContext {
  readonly prompt = new FakePrompt()
  readonly tools = new FakeTools()
  /** Listeners per event, in registration order. Two slices share `agent/created`. */
  readonly #listeners = new Map<string, Registered[]>()
  readonly disposers: (() => void)[] = []
  readonly effectLabels: string[] = []
  /** Extra services, so a test can model one that mounts after the plugin does. */
  readonly services = new Map<string, unknown>()
  /** Injections still waiting for a service to appear, in registration order. */
  readonly waiting: { readonly names: readonly string[], readonly body: (ctx: FakeContext) => void }[] = []

  get(name: string): unknown {
    if (name === 'systemPrompt') return this.prompt
    if (name === 'tools') return this.tools
    return this.services.get(name)
  }

  /**
   * The slice of `ctx.inject` the plugin uses.
   *
   * Faithful where it matters: the body runs as soon as every named service is present, and runs
   * when a missing one arrives later — which is the whole point of the optional-service pattern the
   * panel route relies on, and the only way to test it without a real Host.
   *
   * @param names - the services the body needs.
   * @param body - the callback, given this context.
   * @returns the disposer.
   */
  inject(names: string[], body: (ctx: FakeContext) => void): () => void {
    const missing = names.filter((name) => this.get(name) === undefined)
    if (missing.length === 0) {
      body(this)
      return () => undefined
    }
    const entry = { names: missing, body }
    this.waiting.push(entry)
    return () => {
      const index = this.waiting.indexOf(entry)
      if (index >= 0) this.waiting.splice(index, 1)
    }
  }

  /**
   * Publish a service and run every injection that was waiting for it.
   *
   * @param name - the service name.
   * @param value - the service object.
   */
  provide(name: string, value: unknown): void {
    this.services.set(name, value)
    for (const entry of [...this.waiting]) {
      if (entry.names.some((needed) => this.get(needed) === undefined)) continue
      this.waiting.splice(this.waiting.indexOf(entry), 1)
      entry.body(this)
    }
  }

  on(name: string, listener: Listener, options?: unknown): () => void {
    const entries = this.#listeners.get(name) ?? []
    // `prepend` is honoured because the pre-step ordering is part of the design: this plugin's
    // listener has to run before the first-party ones, and a fake that ignored the option could
    // not tell that apart from registering last.
    if ((options as { prepend?: unknown } | undefined)?.prepend === true) entries.unshift({ listener, options })
    else entries.push({ listener, options })
    this.#listeners.set(name, entries)
    return () => undefined
  }

  effect(body: () => unknown, label?: string): () => void {
    this.effectLabels.push(label ?? '')
    const result = body()
    const dispose = typeof result === 'function' ? (result as () => void) : () => undefined
    this.disposers.push(dispose)
    return dispose
  }

  has(name: string): boolean {
    return (this.#listeners.get(name)?.length ?? 0) > 0
  }

  /** How many listeners this context holds for an event, which is how the table is asserted. */
  listenerCount(name: string): number {
    return this.#listeners.get(name)?.length ?? 0
  }

  /** Options the first listener for `name` was registered with. */
  optionsOf(name: string): unknown {
    return this.#listeners.get(name)?.[0]?.options
  }

  /**
   * Fire an event at its listeners.
   *
   * Two dispatch shapes are modelled, because the host uses both. Given a `next` (the pre-step
   * decision), the listeners compose as a waterfall: each wraps the rest, and a listener that does
   * not call `next()` vetoes the remainder. Without one they run as a serial chain — every listener
   * runs in order, awaited, and only a bail value stops the rest. That distinction is load-bearing:
   * the host registers `agent/created` as serial ("Rejects if the id is already registered or a
   * serial `agent/created` listener fails", `dsh-agent/lib/index.js:473`), and two slices both
   * listen for it, while `agent/pre-step` is a waterfall.
   *
   * An unknown event throws, because a test that fires at a listener which was never registered is
   * asserting nothing.
   */
  async fire(name: string, payload: unknown, next?: () => unknown): Promise<unknown> {
    const entries = this.#listeners.get(name) ?? []
    if (entries.length === 0) throw new Error(`no listener registered for ${name}`)
    if (next === undefined) {
      let result: unknown
      for (const entry of entries) {
        result = await entry.listener(payload)
        if (result !== undefined && result !== null && result !== false) return result
      }
      return result
    }
    const chain = (index: number): unknown => {
      const entry = entries[index]
      if (entry === undefined) return next()
      return entry.listener(payload, () => chain(index + 1))
    }
    return await chain(0)
  }

  /** Run the plugin's effects in reverse, the way an unload would. */
  async unmount(): Promise<void> {
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Teardown is best-effort here too; the assertion is that it does not throw.
      }
    }
    // The store close is fire-and-forget; give it a turn to release the file before cleanup.
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface FakeAgent {
  readonly id: string
  readonly ctx: { get: (name: string) => unknown }
  readonly prompt: FakePrompt
  readonly session: { readonly header: { readonly cwd: string } }
}

function fakeAgent(cwd: string): FakeAgent {
  // Parented to the plugin's prompt when one is mounted, so the agent sees what the host would
  // assemble for it rather than only its own registrations.
  const prompt = new FakePrompt(pluginPrompt)
  return {
    id: `agent-${Math.random().toString(16).slice(2)}`,
    ctx: { get: (name: string) => (name === 'systemPrompt' ? prompt : undefined) },
    prompt,
    session: { header: { cwd } },
  }
}

const homes: string[] = []
let current: FakeContext | undefined
/** The plugin-level prompt an agent created by `fakeAgent` is assembled with, when there is one. */
let pluginPrompt: FakePrompt | undefined
const originalHome = process.env['DSH_HOME']

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  homes.push(dir)
  return dir
}

/** Prepare a DSH home holding a store with the given rows, and point `DSH_HOME` at it. */
async function prepareHome(rows: readonly NewMemory[] = []): Promise<string> {
  const home = tempDir('evm-mount-')
  const store = await openStore({ dshHome: home })
  const repository = new MemoryRepository(store.db)
  for (const row of rows) repository.insert(row)
  store.db.close()
  process.env['DSH_HOME'] = home
  return home
}

function mount(config: Record<string, unknown> = {}): FakeContext {
  const ctx = new FakeContext()
  current = ctx
  pluginPrompt = ctx.prompt
  apply(
    ctx as unknown as Parameters<typeof apply>[0],
    config as Parameters<typeof apply>[1],
  )
  return ctx
}

/** Poll a value that appears asynchronously, so no test depends on a fixed sleep. */
async function until(read: () => string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== '') return value
    if (Date.now() > deadline) throw new Error('nothing was injected before the deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  await current?.unmount()
  current = undefined
  pluginPrompt = undefined
})

after(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  for (const dir of homes) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A file still held open by the store; the temp directory is the OS's problem, not a test
      // failure. Swallowing it keeps a flaky filesystem from reporting a product defect.
    }
  }
})

/**
 * Drive one step and return the text this agent's runtime context would inject.
 *
 * The rebuild is finished when `fire` resolves — the listener awaits the store before it renders —
 * so this is read rather than polled, and reading it twice is two steps, which is what the
 * deduplication assertions are about.
 */
async function step(ctx: FakeContext, agent: FakeAgent, messages: unknown): Promise<string> {
  await ctx.fire(
    'agent/pre-step',
    { agent, messages, turn: 1, step: 1, signal: { aborted: false } },
    () => ({ kind: 'enter', messages: [] }),
  )
  return agent.prompt.contextText(CONTEXT_NAME)
}

describe('registration table', () => {
  test('the memory context is scoped per agent, with a plugin-level fallback under it', async () => {
    await prepareHome()
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))

    // The plugin-level registration exists for a session whose own context cannot be reached. It
    // renders empty until such a session rebuilds into it, so an ordinary agent never pays for it.
    assert.equal(ctx.prompt.registeredContexts.length, 1)
    assert.equal(ctx.prompt.registeredContexts[0]?.name, CONTEXT_NAME)
    assert.equal(ctx.prompt.registeredContexts[0]?.order, ORDER_RUNTIME_CONTEXT)
    // Nothing agent-scoped may be mounted before an agent exists: there is no cwd to scope it to.
    assert.equal(ctx.prompt.registeredSections.length, 0)
    assert.equal(agent.prompt.registeredContexts.length, 0)
    // Two slices hang off the same lifecycle event — rules and memory — which the host dispatches
    // serially, so registering both is safe and each is awaited in turn.
    assert.equal(ctx.listenerCount('agent/created'), 2)

    await ctx.fire('agent/created', { agent })

    assert.equal(agent.prompt.registeredContexts.length, 1)
    assert.equal(agent.prompt.registeredContexts[0]?.name, CONTEXT_NAME)
    assert.equal(agent.prompt.registeredContexts[0]?.order, ORDER_RUNTIME_CONTEXT)
    // The agent's registration shadows the plugin-level one by name, so the assembly contributes
    // one text and not two.
    assert.equal(agent.prompt.contexts.length, 1)
  })

  test('two agents in two projects do not share one memory text', async () => {
    const first = tempDir('evm-cwd-a-')
    const second = tempDir('evm-cwd-b-')
    mkdirSync(join(first, '.dsh'), { recursive: true })
    mkdirSync(join(second, '.dsh'), { recursive: true })
    const keyOf = (cwd: string): string => createSession(cwd).projectKey ?? ''
    assert.notEqual(keyOf(first), keyOf(second))

    await prepareHome([
      { text: 'A 项目的缓存策略是 pnpm', scope: 'project', projectKey: keyOf(first) },
      { text: 'B 项目的缓存策略是 yarn', scope: 'project', projectKey: keyOf(second) },
    ])

    const ctx = mount()
    const agentA = fakeAgent(first)
    const agentB = fakeAgent(second)
    await ctx.fire('agent/created', { agent: agentA })
    await ctx.fire('agent/created', { agent: agentB })
    // The second agent's rebuild is the one that would be left standing if the two shared a state.
    await step(ctx, agentA, [])
    await step(ctx, agentB, [])

    const textA = agentA.prompt.contextText(CONTEXT_NAME)
    const textB = agentB.prompt.contextText(CONTEXT_NAME)
    assert.match(textA, /A 项目的缓存策略是 pnpm/u)
    assert.doesNotMatch(textA, /yarn/u)
    assert.match(textB, /B 项目的缓存策略是 yarn/u)
    assert.doesNotMatch(textB, /pnpm/u)
  })

  test('the rules section is registered on the agent context, from agent/created', async () => {
    const home = await prepareHome()
    const cwd = tempDir('evm-cwd-')
    mkdirSync(join(cwd, '.dsh', 'rules'), { recursive: true })
    writeFileSync(join(cwd, '.dsh', 'rules', 'a.md'), '项目规则：用 pnpm\n', 'utf8')
    void home

    const ctx = mount()
    const agent = fakeAgent(cwd)
    await ctx.fire('agent/created', { agent })

    assert.equal(agent.prompt.sections.length, 1)
    assert.equal(agent.prompt.sections[0]?.name, RULES_SECTION_NAME)
    assert.equal(agent.prompt.sections[0]?.order, ORDER_RULES)
    assert.match(agent.prompt.sections[0]?.text() ?? '', /用 pnpm/u)
    // The plugin context must not carry a second copy: registering the same name there for a
    // second agent would throw, which is exactly why this is scoped to the agent.
    assert.equal(ctx.prompt.named(RULES_SECTION_NAME), undefined)
  })

  test('the rules section is scoped per agent, so two agents do not share one project', async () => {
    await prepareHome()
    const first = tempDir('evm-cwd-a-')
    const second = tempDir('evm-cwd-b-')
    mkdirSync(join(first, '.dsh', 'rules'), { recursive: true })
    writeFileSync(join(first, '.dsh', 'rules', 'a.md'), 'A 项目的规则\n', 'utf8')
    mkdirSync(join(second, '.dsh', 'rules'), { recursive: true })
    writeFileSync(join(second, '.dsh', 'rules', 'b.md'), 'B 项目的规则\n', 'utf8')

    const ctx = mount()
    const agentA = fakeAgent(first)
    const agentB = fakeAgent(second)
    await ctx.fire('agent/created', { agent: agentA })
    await ctx.fire('agent/created', { agent: agentB })

    assert.match(agentA.prompt.sections[0]?.text() ?? '', /A 项目的规则/u)
    assert.doesNotMatch(agentA.prompt.sections[0]?.text() ?? '', /B 项目的规则/u)
    assert.match(agentB.prompt.sections[0]?.text() ?? '', /B 项目的规则/u)
  })

  test('rulesEnabled: false registers neither the section nor the lifecycle listeners', async () => {
    await prepareHome()
    const ctx = mount({ rulesEnabled: false })
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })

    // `agent/created` is shared with the memory slice, which is still on: exactly one listener means
    // rules registered none, and the agent is asked for a rules section directly rather than
    // inferred from the event being absent.
    assert.equal(ctx.listenerCount('agent/created'), 1)
    assert.equal(ctx.has('agent/disposed'), false)
    assert.equal(agent.prompt.sections.length, 0)
    assert.equal(agent.prompt.named(RULES_SECTION_NAME), undefined)
  })

  test('memoryEnabled: false registers neither the context nor the per-step listener', async () => {
    await prepareHome()
    const ctx = mount({ memoryEnabled: false })

    assert.equal(ctx.prompt.contexts.length, 0)
    assert.equal(ctx.has('agent/pre-step'), false)
  })

  test('the conversational tools are registered on the plugin context', async () => {
    await prepareHome()
    const ctx = mount()

    assert.deepEqual(
      [...ctx.tools.registered.keys()].sort(),
      ['evermemory_forget', 'evermemory_import', 'evermemory_log', 'evermemory_remember', 'evermemory_search'],
    )
    // Global tools, one registration for the whole process: the calling agent is read from
    // `exec`, because registering the same names per agent would throw on the second session.
    for (const [name, entry] of ctx.tools.registered) {
      assert.ok(entry.description.length > 40, `${name} needs a description a model can route on`)
    }
  })

  test('memoryEnabled: false registers no tools either', async () => {
    await prepareHome()
    const ctx = mount({ memoryEnabled: false })
    assert.equal(ctx.tools.registered.size, 0)
  })

  test('the pre-step listener runs ahead of the first-party listeners', async () => {
    await prepareHome()
    const ctx = mount()

    assert.deepEqual(ctx.optionsOf('agent/pre-step'), { prepend: true })
  })

  test('the tail reminder is off by default and mounted at 9999 when enabled', async () => {
    await prepareHome([{ text: '用 pnpm', scope: 'global', pinned: true, importance: 9 }])
    const off = mount()
    assert.equal(off.prompt.named(TAIL_SECTION_NAME), undefined)

    const on = mount({ tailReminderEnabled: true })
    const section = on.prompt.named(TAIL_SECTION_NAME)
    assert.ok(section !== undefined, 'the tail section should be registered')
    assert.equal(section.order, ORDER_MEMORY_TAIL_REMINDER)
    // A stored memory containing `{{` must not become a prompt variable, and an unknown variable
    // must not throw during assembly.
    assert.equal(section.interpolate, false)
    assert.equal(await until(() => section.text()), TAIL_REMINDER)
  })

  test('an empty store gets no tail reminder text, though the section exists', async () => {
    await prepareHome()
    const ctx = mount({ tailReminderEnabled: true })
    const section = ctx.prompt.named(TAIL_SECTION_NAME)
    assert.ok(section !== undefined)
    // Both by default. Telling a model to consult a memory it does not have can only produce an
    // invented retrieval; an empty section is dropped by the assembly, leaving no gap.
    assert.equal(ctx.prompt.contexts[0]?.text(), '')
    assert.equal(section.text(), '')
  })
})

describe('the per-step listener', () => {
  test('returns the decision unchanged, whatever it is', async () => {
    await prepareHome()
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })

    const decision = { kind: 'enter', messages: ['claimed'] }
    const returned = await ctx.fire(
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: { aborted: false } },
      () => decision,
    )

    assert.equal(returned, decision)
  })

  test('the store is open by the first step, so memory reaches the context', async () => {
    await prepareHome([{ text: '用户要求用 pnpm', scope: 'global', pinned: true, importance: 9 }])
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })
    await ctx.fire(
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: { aborted: false } },
      () => ({ kind: 'enter', messages: [] }),
    )

    const text = await until(() => agent.prompt.contextText(CONTEXT_NAME))
    assert.match(text, /用 pnpm/u)
  })

  test('a rejected step is not paid for', async () => {
    await prepareHome([{ text: '用户要求用 pnpm', scope: 'global', pinned: true, importance: 9 }])
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })
    await ctx.fire(
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: { aborted: false } },
      () => ({ kind: 'reject' }),
    )

    // No request will be sent, so the query and the render would both be wasted work.
    assert.equal(agent.prompt.contextText(CONTEXT_NAME), '')
  })

  test('an aborted signal skips the rebuild', async () => {
    await prepareHome([{ text: '用户要求用 pnpm', scope: 'global', pinned: true, importance: 9 }])
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })
    await ctx.fire(
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: { aborted: true } },
      () => ({ kind: 'enter', messages: [] }),
    )

    assert.equal(agent.prompt.contextText(CONTEXT_NAME), '')
  })

  test('a payload without an agent is ignored rather than throwing', async () => {
    await prepareHome()
    const ctx = mount()

    const decision = { kind: 'enter', messages: [] }
    const returned = await ctx.fire(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1 },
      () => decision,
    )

    assert.equal(returned, decision)
  })

  test('unloading closes the store instead of leaving the file open', async () => {
    await prepareHome()
    const ctx = mount()
    assert.deepEqual(ctx.effectLabels, ['evermemory.close-store'])

    await ctx.unmount()
    current = undefined
  })
})

// ---------------------------------------------------------------------------------------------
// The per-turn card channel
// ---------------------------------------------------------------------------------------------

/** A memory the query below matches, and one that is not pinned — so the card is its only channel. */
const CARD_ROW: NewMemory = { text: '缓存策略：装依赖用 pnpm，不要用 npm', scope: 'global' }

/** The message a real user turn carries: the host tags those `source.kind === 'user'`. */
const ASK = {
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '缓存策略 pnpm 怎么定' }],
}

/** The card block's header, which the index block does not share. */
const CARD_HEADER = /\[相关记忆 · \d+ 条/u

describe('the per-turn card channel', () => {
  test('a user message retrieves bodies, and the next step does not pay for them twice', async () => {
    await prepareHome([CARD_ROW])
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })

    const first = await step(ctx, agent, [ASK])
    assert.match(first, CARD_HEADER)
    assert.match(first, /pnpm/u)

    // The ledger is the reason the host can still deduplicate: a body already in the transcript is
    // not offered again, so the snapshot text of an idle turn stops changing and the prefix holds.
    const second = await step(ctx, agent, [ASK])
    assert.doesNotMatch(second, CARD_HEADER)
  })

  test('a step with no user message of its own retrieves nothing', async () => {
    await prepareHome([CARD_ROW])
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })

    // What the second step of a turn actually carries: the runtime-context snapshot and a tool
    // result. Neither is a question, and retrieving against them would turn an announcement into a
    // query — and would spend the turn's retrieval on every step instead of once.
    const text = await step(ctx, agent, [
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '缓存策略 pnpm' }] },
      { role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: '缓存策略 pnpm' }] },
    ])
    assert.doesNotMatch(text, CARD_HEADER)
    // The rebuild did run: the index carries the entry, which is what proves the store was read.
    assert.match(text, /\[记忆索引/u)
  })

  test('a conversational write re-offers the memory it just changed', async () => {
    await prepareHome([CARD_ROW])
    const ctx = mount()
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })

    assert.match(await step(ctx, agent, [ASK]), CARD_HEADER)
    assert.doesNotMatch(await step(ctx, agent, [ASK]), CARD_HEADER)

    const remember = ctx.tools.registered.get('evermemory_remember')
    assert.ok(remember?.run !== undefined, 'the remember tool should be mounted')
    const written = await remember.run(
      { text: CARD_ROW.text },
      { signal: { aborted: false }, name: 'evermemory_remember', agent },
    )
    // The decision is not the subject here — a write is, which is the event the ledger hears about.
    // This one is `new`: the seeded row is global and a session that knows its project writes into
    // the project's layer, so the two never meet in one pool.
    assert.equal(typeof (written as { id?: unknown }).id, 'number')

    // Re-offered with the SAME text as the first step, which is the case the host still appends:
    // the snapshot it compares against is the previous step's, and that one had no card in it.
    assert.match(await step(ctx, agent, [ASK]), CARD_HEADER)
  })

  test('cardInjectionEnabled: false leaves the index alone and sends no card', async () => {
    await prepareHome([CARD_ROW])
    const ctx = mount({ cardInjectionEnabled: false })
    const agent = fakeAgent(tempDir('evm-cwd-'))
    await ctx.fire('agent/created', { agent })

    const text = await step(ctx, agent, [ASK])
    assert.doesNotMatch(text, CARD_HEADER)
    assert.match(text, /\[记忆索引/u)
  })
})

describe('stepQuery', () => {
  test('reads the user text out of a batch that holds other producers too', () => {
    assert.equal(
      stepQuery([
        { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '索引' }] },
        { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: '好的' }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '缓存策略' }] },
      ]),
      '缓存策略',
    )
  })

  test('answers nothing for a batch with no user message, however it is shaped', () => {
    assert.equal(stepQuery([]), '')
    assert.equal(stepQuery([{ role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'x' }] }]), '')
    assert.equal(stepQuery([{ role: 'user', source: { kind: 'model-selection' }, content: [] }]), '')
    assert.equal(stepQuery([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image' }] }]), '')
    assert.equal(stepQuery(undefined), '')
  })

  test('keeps the end of a long paste, where the question is', () => {
    const text = `${'x'.repeat(5000)}最后的问题是什么`
    const query = stepQuery([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }])

    assert.equal(query.length, STEP_QUERY_CHARS)
    assert.ok(query.endsWith('最后的问题是什么'))
  })
})

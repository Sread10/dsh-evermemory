/**
 * Host half of dsh-evermemory.
 *
 * Mounts two independent modules that share one storage layer but have almost nothing else in
 * common:
 *
 *  - **Module 1, behavioural rules.** Static text, injected as a system-prompt section at
 *    `ORDER_RULES`. It only changes when the user edits a rules file, so it sits in the
 *    prompt head and is paid for once per session by the prefix cache.
 *
 *  - **Module 2, long-term memory.** Dynamic retrieval, injected through the
 *    runtime-context channel, which appends a sourced user-role message only when the
 *    rendered text actually changed. Nothing here rewrites the prompt head, so a busy
 *    memory store never invalidates the cached prefix.
 *
 * That split is the whole architecture. Anything that changes per turn goes through
 * runtime context; anything that is stable per session goes through a section. The
 * mistake to avoid — and the one the brief's first draft made — is putting a per-turn
 * index in a section, where every change loses prefix reuse from its first changed token.
 *
 * Where each registration happens is deliberate:
 *
 * | registration        | context       | event            | why                                  |
 * |---------------------|---------------|------------------|--------------------------------------|
 * | rules section       | `agent.ctx`   | `agent/created`  | reads that agent's cwd                |
 * | memory context      | `agent.ctx`   | `agent/created`  | renders that agent's project layer     |
 * | memory context      | plugin `ctx`  | `apply`          | fallback for an unreachable agent ctx  |
 * | tail reminder       | plugin `ctx`  | `apply`          | constant text belongs in the head     |
 * | injection refresh   | plugin `ctx`  | `agent/pre-step` | per step, and asynchronous            |
 * | memory tools        | plugin `ctx`  | `apply`          | global tools; the agent comes from `exec` |
 * | import tool         | plugin `ctx`  | `apply`          | same, and it only reads a path the user names |
 * | panel data route    | `connection`  | injected         | needs `webServer`; optional by design |
 *
 * The rules section and the memory context both have to be agent-scoped and therefore both have to
 * be registered from an event: the AgentOptions builder runs after `applying`, so a `section()` call
 * made during `apply()` would land on the plugin context — where it could not know which project it
 * belongs to — and re-registering the same name there for a second agent would throw. The host
 * shadows a plugin-level registration by an agent-level one of the same name, which is what makes
 * the plugin-level memory context a safe fallback: it is only ever read by an agent that never got
 * one of its own, and it renders empty until such an agent rebuilds into it.
 *
 * The panel route is the one registration that is skipped on a Host without a web server. That is
 * why it waits for `connection` and `webServer` through `ctx.inject` instead of being listed in
 * `inject`: a headless Host still gets rules and memory, and a page that can never load costs it
 * nothing.
 */

import type { Context, Disposer } from '@deepseek-ai/cordis'

import { CARD_RECALL_LIMIT, ORDER_RULES, ORDER_RUNTIME_CONTEXT, PLUGIN_NAME } from './constants.js'
import { assertConfigUsable, unwrapConfig } from './config.js'
import type { DeclaredConfig, ResolvedConfig } from './config.js'
import {
  CONTEXT_NAME,
  SECTION_CARDS,
  SECTION_CONSTRAINTS,
  SECTION_INDEX,
  InjectionState,
} from './inject/context.js'
import { Sessions, stepQuery } from './inject/mount.js'
import type { AgentLike } from './inject/mount.js'
import { systemPromptOf } from './inject/prompt.js'
import { mountTailReminder } from './inject/reminder.js'
import { createSession } from './memory/service.js'
import { mountPanelRoute } from './panel/route.js'
import { mountRulesSection, refreshRules } from './rules/section.js'
import { StoreHandle } from './storage/handle.js'
import { createAccess, mountMemoryTools } from './tools/memory.js'
import type { Access } from './tools/memory.js'
import { mountImportTools } from './tools/import.js'

export { Config } from './config.js'
export { PLUGIN_NAME } from './constants.js'
export { PACKAGE_NAME, VERSION } from './version.js'

/** The Cordis plugin name. Must equal `insert.id` in cordis.patch.yml. */
export const name = PLUGIN_NAME

/**
 * Services this plugin cannot work without.
 *
 * `systemPrompt` provides both injection channels; `tools` is what the conversational tool set
 * registers against. Everything else — `settings` for the preferences form, `webServer` for the
 * panel's data route — is injected optionally via `ctx.inject([...], …)`, because a Host without a
 * web server should still get memory and rules.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * Mount the plugin.
 *
 * @param ctx - plugin context. Every registration below is a Cordis effect, so unloading
 *   the plugin removes its sections and closes the database together.
 * @param config - schema-validated configuration, possibly still holding volatile
 *   references, which `unwrapConfig()` resolves. Typed as a partial on purpose: the loader hands
 *   over the keys the user actually set, and `unwrapConfig()` is what fills the rest.
 */
export function apply(ctx: Context, config: Partial<DeclaredConfig>): void {
  const resolved = unwrapConfig(config)
  assertConfigUsable(resolved)

  const store = new StoreHandle()
  const sessions = new Sessions()
  // The fallback text for a session whose own context cannot be reached, plus the one the
  // plugin-level registration renders. Empty until an agent actually rebuilds into it, so a Host
  // where every agent gets its own context never pays for it.
  const shared = new InjectionState()
  // One accessor for the whole plugin. The tools write through it and the injection path reads
  // through it, so both see one `MemoryService` over one open connection — a second accessor would
  // be a second cache, and the two could disagree about which repository is current.
  const access = createAccess(store)

  // Kick the open now, without awaiting: `apply()` is synchronous and blocking the plugin tree on a
  // disk operation would delay every other plugin's mount. This is not merely an optimisation —
  // nothing else opens the store. The injection path can only read `repositoryIfReady`, so without
  // this a session that never calls a tool would never inject a single memory.
  void store.repository().catch(() => {
    // Remembered in the handle and reported once by `describeFailure()`. Retrying here would put a
    // throwing filesystem call on the mount path of every load.
  })

  if (resolved.rulesEnabled) mountRules(ctx, resolved, sessions)
  mountTail(ctx, resolved, store)
  if (resolved.memoryEnabled) {
    // A write changes what the next step may offer, but only for the session that wrote: another
    // project's ledger knows nothing about this row and must not be emptied on its behalf.
    const invalidate = (agent: unknown): void => {
      const entry = sessions.get(agent)
      if (entry === undefined) shared.invalidateCards()
      else entry.injections.invalidateCards()
    }
    mountMemory(ctx, resolved, sessions, shared, store, access)
    // The conversational write path. Mounted with the read path on purpose: a session that can be
    // told a memory but not asked to store one is a memory system that only ever loses things.
    // `onWrite` is what keeps the injection ledger honest about a store the user just corrected.
    mountMemoryTools(ctx, resolved, store, { access, onWrite: invalidate })
    // Import is a write path too, and the only one that reads files the user did not write for us.
    mountImportTools(ctx, resolved, store)
  }

  // The settings panel's data route. Mounted regardless of `memoryEnabled`, because the panel is
  // also where a user turns memory back on: a Host that skipped the route when memory was off would
  // hide the only switch that turns it back on. A Host without a web server never runs the body.
  mountPanelRoute(ctx, store)

  ctx.effect(() => () => {
    void store.close()
  }, 'evermemory.close-store')
}

/** Rules slice: the section, registered per agent because it reads that agent's working directory. */
function mountRules(ctx: Context, config: ResolvedConfig, sessions: Sessions): void {
  const options = { extraDirs: config.extraRuleDirs, maxChars: config.turnBudgetChars }

  ctx.on('agent/created', (payload: unknown) => {
    const agent = agentOf(payload)
    if (agent === null) return
    const entry = sessions.track(agent, sessions.cwdOf(agent))
    // Read once here so the very first prompt assembly already carries the rules. Waiting for
    // the first `agent/pre-step` would be a step too late: assembly happens before the hook, so
    // the first turn of every session would run without them.
    refreshRules(entry.rules.state, options, { cwd: entry.cwd, tick: entry.rules.tick, force: true })
    const mounted = mountRulesSection(agent.ctx, entry.rules.state, ORDER_RULES)
    if (!mounted) {
      // The agent context is not readable, which happens on a host build that scopes differently.
      // Fall back to the plugin context: one section shared by every agent, correct for the global
      // rules and blind to per-project ones. Better than no rules at all.
      mountRulesSection(ctx, entry.rules.state, ORDER_RULES)
    }
  })

  ctx.on('agent/disposed', (payload: unknown) => {
    sessions.forget(agentOf(payload))
  })
}

/** The tail reminder, guarded on the store actually having something to remind about. */
function mountTail(ctx: Context, config: ResolvedConfig, store: StoreHandle): void {
  mountTailReminder(ctx, config, () => {
    const repository = store.repositoryIfReady
    if (repository === undefined) return false
    try {
      return repository.count({ status: 'active' }) > 0
    } catch {
      // The count runs during prompt assembly. A failing query must cost the reminder, not the
      // prompt.
      return false
    }
  })
}

/**
 * Memory slice: one runtime-context registration per agent, rebuilt each step.
 *
 * The context is registered twice on purpose. The agent-scoped registration carries that agent's own
 * text, which is the one that contains its project layer; the plugin-level one is the fallback for a
 * session whose context cannot be reached, and the host shadows it by name for every agent that has
 * a registration of its own.
 */
function mountMemory(
  ctx: Context,
  config: ResolvedConfig,
  sessions: Sessions,
  shared: InjectionState,
  store: StoreHandle,
  access: Access,
): void {
  // Constant-time: `InjectionState` holds the rendered text, rebuilt in the pre-step hook. This
  // callback must never query, because it runs during prompt assembly. Renders empty — and is
  // therefore dropped by the assembly — until a session without its own context rebuilds into it.
  systemPromptOf(ctx)?.context({
    name: CONTEXT_NAME,
    order: ORDER_RUNTIME_CONTEXT,
    text: () => shared.text,
  })

  ctx.on('agent/created', (payload: unknown) => {
    const agent = agentOf(payload)
    if (agent === null) return
    const entry = sessions.track(agent, sessions.cwdOf(agent))
    // Registered here rather than in `apply()` because the text belongs to this agent's project:
    // `sessions.track` is what gives it a state of its own, and a second agent in a second project
    // must not be served the first one's memories.
    const mounted = systemPromptOf(agent.ctx)?.context({
      name: CONTEXT_NAME,
      order: ORDER_RUNTIME_CONTEXT,
      text: () => entry.injections.text,
    })
    if (mounted === undefined) {
      // The agent context is not readable, which happens on a host build that scopes differently.
      // Fall back to the shared text: one text for every such agent, blind to the per-project layer,
      // exactly as the rules section falls back to the plugin context. Better than no memory at all.
      entry.injections = shared
    } else {
      // Recorded so `agent/disposed` unregisters it: this one is registered by name, and a name
      // that outlives its agent is a name the next registration can collide with.
      entry.disposers.push(mounted)
    }
  })

  ctx.on(
    'agent/pre-step',
    async (payload: unknown, next: () => Promise<unknown>) => {
      const incoming = payload as {
        agent?: unknown
        messages?: unknown
        turn?: number
        step?: number
        signal?: { aborted?: boolean }
      }
      // The decision belongs to the rest of the chain; this plugin only observes. `next()` runs
      // first so a rejected step never pays for an injection that will not be sent.
      const decision = await next()
      if (incoming.signal?.aborted === true) return decision
      const agent = agentOf(payload)
      if (agent === null) return decision
      // A rejected step sends no request, so the query and the render would both be wasted work.
      // Worse than wasted: the cards it rendered would be recorded as delivered and never offered
      // again, hiding those memories for the rest of the session behind an injection that never
      // reached the model.
      if ((decision as { kind?: unknown }).kind === 'reject') return decision

      if (config.rulesEnabled) {
        const entry = sessions.get(agent)
        if (entry !== undefined) {
          // Cheap by design: after the first read this is a timestamp comparison, and it is what
          // makes editing a rules file take effect without restarting the host.
          refreshRules(
            entry.rules.state,
            { extraDirs: config.extraRuleDirs, maxChars: config.turnBudgetChars },
            { cwd: entry.cwd ?? sessions.cwdOf(agent), tick: entry.rules.tick },
          )
        }
      }

      if (!config.memoryEnabled) return decision
      // An agent the host never announced has no context of its own, so its text goes to the shared
      // fallback — the only context such a session can see.
      const entry =
        sessions.get(agent) ?? sessions.track(agent, sessions.cwdOf(agent), shared)
      // `repositoryIfReady` is `undefined` until the store has been opened AND the repository
      // installed. Awaiting it here is what makes the FIRST step of a session see memory instead of
      // every session starting blank. The open is normally already in flight from `apply()`, so
      // this awaits a promise rather than starting a disk operation; when that first open failed,
      // the rejection is remembered and re-thrown here without touching the filesystem again.
      const repository =
        store.repositoryIfReady ?? (await store.repository().catch(() => undefined))
      if (repository === undefined) return decision

      const session = createSession(sessions.cwdOf(agent))
      // The per-turn card channel's producer. Its input is the text this step is actually about:
      // the host hands the step the batch it claimed, and `stepQuery` picks the user's own message
      // out of it. A step carrying no user message — the second and later steps of a turn, which
      // follow a tool call — retrieves nothing and costs nothing.
      //
      // Retrieved only when the channel is on: a switched-off switch must not buy a query per turn.
      const query = config.cardInjectionEnabled ? stepQuery(incoming.messages) : ''
      const service = query === '' ? undefined : access.ready() ?? (await access.open().catch(() => undefined))

      entry.injections.rebuild({
        repository,
        config,
        // The same call the tools make, so the injection path and the write path cannot disagree
        // about which project this session belongs to.
        projectKey: session.projectKey,
        ...(query === '' || service === undefined
          ? {}
          : {
              cards: () => {
                // Never throws into the host's waterfall: this runs inside prompt assembly, where
                // failing would cost every agent in the session its request, not just this plugin.
                try {
                  return service.recall(session, query, CARD_RECALL_LIMIT)
                } catch {
                  return []
                }
              },
            }),
      })
      return decision
    },
    // Ahead of the first-party listeners: the context must be current before anything else reads
    // it, and this listener has no opinion about the decision.
    { prepend: true },
  )
}

/** Read the agent out of a payload, or `null` when the host sent something else. */
function agentOf(payload: unknown): AgentLike | null {
  const agent = (payload as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return null
  return agent as AgentLike
}

/** Re-exported so the browser half and the tests share one definition. */
export { SECTION_CARDS, SECTION_CONSTRAINTS, SECTION_INDEX }
export type { Disposer }

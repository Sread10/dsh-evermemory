/**
 * Wiring: what gets mounted where, and what happens when a piece is missing.
 *
 * Three registrations, in three places, for three different reasons:
 *
 *   - The **rules section** goes on the AGENT-scoped context, registered from `agent/created`.
 *     It belongs to one agent because it reads that agent's `cwd`; a global registration would
 *     have to guess which project the prompt belongs to. Registering at `agent/created` is what
 *     makes an agent-scoped section legal — the AgentOptions builder runs after `applying`, so a
 *     registration made during `apply()` would land on the plugin context instead.
 *
 *   - The **memory context** goes on the AGENT-scoped context, registered from `agent/created`,
 *     with a plugin-wide registration underneath it that the agent's own shadows by name. It needs
 *     the same scope as the rules for the same reason: the text it renders contains the project
 *     layer, so one shared text would hand one project's memories to another project's session. The
 *     plugin-level registration is what an agent without a readable context still gets, and it
 *     renders empty until such an agent actually rebuilds into it.
 *
 *   - The **tail reminder** goes on the plugin context: it is constant text and carries nothing
 *     that belongs to a project.
 *
 * Everything here is idempotent and every failure is local. A host without `systemPrompt` loses
 * injection but keeps the tools; a database that cannot be opened loses memory but keeps the
 * rules; and a section that throws during assembly would take out every agent in the session, so
 * nothing registered here is allowed to throw.
 */

import type { MemoryRepository } from '../storage/repository.js'
import { STEP_QUERY_CHARS } from '../constants.js'
import { InjectionState } from './context.js'
import { createRulesState, newRuleTickState } from '../rules/section.js'
import type { RuleTickState, RulesState } from '../rules/section.js'

/**
 * The subset of an agent this module uses.
 *
 * Declared structurally rather than importing `@deepseek-ai/dsh-agent` types, because the host
 * supplies the real object and this plugin only ever reads three fields from it. A missing shim
 * cannot then turn into a compile error for code that would have worked.
 */
export interface AgentLike {
  readonly id: string
  readonly ctx?: unknown
  readonly session?: {
    readonly header?: { readonly cwd?: string | undefined }
    readonly id?: string
  }
}

/** A tracked session's state. */
export interface SessionEntry {
  /** The agent context, kept for diagnostics. */
  readonly agent: AgentLike
  /** Working directory this session was created with, or `undefined`. */
  readonly cwd: string | undefined
  /** The behavioural-rules state for this agent, so two projects cannot share one rule text. */
  readonly rules: RulesSlot
  /**
   * The memory-injection state for this agent.
   *
   * Per agent for the same reason the rules are: the rendered text carries the project layer, so a
   * single shared state would show one project's memories — index, constraints and card bodies — to
   * a session sitting in another one. Mutable because a session whose context cannot be reached
   * falls back to the shared state every such session uses.
   */
  injections: InjectionState
  /** Registered section disposers, so a disposal can be undone. */
  readonly disposers: (() => void)[]
}

/**
 * Per-agent rules state.
 *
 * Per agent rather than per plugin: the rendered rule text includes the project-level files, so a
 * single shared state would show one project's rules to every other project's session — the exact
 * failure the project layer exists to prevent.
 */
export interface RulesSlot {
  readonly state: RulesState
  readonly tick: RuleTickState
}

/** Build an empty rules slot. */
export function newRulesSlot(): RulesSlot {
  return { state: createRulesState(), tick: newRuleTickState() }
}

/**
 * Per-agent bookkeeping, keyed by the agent object.
 *
 * A `WeakMap` rather than a `Map` keyed by id: a long-lived host creates and discards agents for
 * subagents continuously, and a strong map would hold every one of them for the lifetime of the
 * process. Keying on the object means the entry goes away exactly when the agent does.
 */
export class Sessions {
  readonly #entries = new WeakMap<object, SessionEntry>()

  /**
   * Record an agent, returning its entry.
   *
   * Idempotent: the rules listener and the memory listener both announce a new agent, and the
   * second call must not replace what the first one filled in — rebuilding the entry would throw
   * away the rules state that was just read from disk and the disposers registered so far.
   */
  track(agent: AgentLike, cwd: string | undefined, injections?: InjectionState): SessionEntry {
    const existing = this.#entries.get(agent)
    if (existing !== undefined) return existing
    const entry: SessionEntry = {
      agent,
      cwd,
      rules: newRulesSlot(),
      injections: injections ?? new InjectionState(),
      disposers: [],
    }
    this.#entries.set(agent, entry)
    return entry
  }

  get(agent: unknown): SessionEntry | undefined {
    if (typeof agent !== 'object' || agent === null) return undefined
    return this.#entries.get(agent)
  }

  /** Working directory for an agent, falling back to the session header the way the host does. */
  cwdOf(agent: unknown): string | undefined {
    const tracked = this.get(agent)
    if (tracked !== undefined) return tracked.cwd
    return (agent as AgentLike | undefined)?.session?.header?.cwd
  }

  forget(agent: unknown): void {
    if (typeof agent !== 'object' || agent === null) return
    const entry = this.#entries.get(agent)
    if (entry === undefined) return
    for (const dispose of entry.disposers) {
      try {
        dispose()
      } catch {
        // A disposer that throws must not stop the others. This runs during agent teardown,
        // where an escaping error surfaces as a broken session rather than as a leaked section.
      }
    }
    this.#entries.delete(agent)
  }
}

/**
 * The text a step is asking about, read from the batch that step claimed, or `''`.
 *
 * Only messages the host tagged `source.kind === 'user'` count, and that whitelist is the point.
 * Everything else in a batch is a producer's artefact: this plugin's own channels ride inside a
 * `runtime-context` snapshot, a model switch is `model-selection`, and a plugin added later will
 * bring its own kind. Retrieving against one of those would turn an announcement into a query.
 *
 * Searched from the END, so the second and later steps of a turn — whose batch holds tool results
 * and no user message at all — answer `''` and cost nothing: retrieval happens once per user turn,
 * not once per step.
 */
export function stepQuery(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as MessageLike | undefined
    if (message?.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    const text = textOf(message.content)
    if (text === '') continue
    return text.length <= STEP_QUERY_CHARS ? text : text.slice(text.length - STEP_QUERY_CHARS)
  }
  return ''
}

/** The fields of a claimed message this module reads. */
interface MessageLike {
  readonly role?: unknown
  readonly source?: { readonly kind?: unknown } | undefined
  readonly content?: unknown
}

/**
 * The text parts of one message, joined.
 *
 * Image parts and tool-result parts carry no query, and a message that is not text-only is not a
 * question anyone typed.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const candidate = part as { type?: unknown; text?: unknown } | undefined
    if (candidate?.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

/** The parts of the memory subsystem the injection path needs. */
export interface MemoryAccess {
  /** The repository, once the store is open. Throws when memory is unavailable. */
  repository(): MemoryRepository
  /** True when the store has at least one active entry, for the tail reminder's guard. */
  hasEntries(): boolean
}
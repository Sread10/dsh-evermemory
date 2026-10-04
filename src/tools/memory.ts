/**
 * The conversational tool set: the only way a user's instruction reaches memory.
 *
 * Constraint #5 forbids intercepting user messages to detect "remember this". The model decides,
 * and it decides by calling a tool — which means these definitions are the plugin's whole write
 * API from the conversation, and every rule about layers, ids and failures has to be legible from
 * them alone.
 *
 * Two things every tool here shares:
 *
 *  - **The store may not be open.** `apply()` kicks the open without awaiting it, so a tool called
 *    in the first seconds of a session can arrive before the database does. Each call awaits the
 *    handle and reports a plain failure rather than throwing a filesystem error into the history.
 *  - **The session comes from the call, not from a global.** `exec.agent` is present only when the
 *    caller is agent-scoped, so the working directory is read off it and falls back to the
 *    process's. That is also what makes each call resolve the project key the same way the
 *    injection path does — one definition of identity, in `memory/service.ts`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

import type { MemoryScope } from '../constants.js'
import { TOOL_PREFIX } from '../constants.js'
import type { ResolvedConfig } from '../config.js'
import { MemoryService, createSession } from '../memory/service.js'
import type { MemorySession } from '../memory/service.js'
import type { MemoryRepository } from '../storage/repository.js'
import type { SqliteDatabase } from '../storage/db.js'
import type { StoreHandle } from '../storage/handle.js'
import { toolsOf } from './service.js'

/** Longest body printed per entry. The store allows far longer; a tool result is not a dump. */
const RENDER_TEXT_CHARS = 240

/** Longest body echoed back after a merge, where the entry's text is not what the caller sent. */
const RENDER_MERGED_CHARS = 400

/**
 * The service, once per open store.
 *
 * Cached against the repository object rather than construction time: `StoreHandle.adopt()` swaps
 * the repository in tests, and a cache keyed on nothing would then hand a tool a connection to a
 * closed database. Keying on the repository makes the invalidation automatic.
 */
export interface Access {
  ready(): MemoryService | undefined
  open(): Promise<MemoryService>
}

/** Build the accessor over a store handle. */
export function createAccess(store: StoreHandle): Access {
  let cached: MemoryService | undefined
  let cachedFor: MemoryRepository | undefined

  const serviceFor = (repository: MemoryRepository, db: SqliteDatabase): MemoryService => {
    if (cached === undefined || cachedFor !== repository) {
      cached = new MemoryService(repository, db)
      cachedFor = repository
    }
    return cached
  }

  return {
    ready(): MemoryService | undefined {
      const repository = store.repositoryIfReady
      const db = store.dbIfReady
      if (repository === undefined || db === undefined) return undefined
      return serviceFor(repository, db)
    },
    async open(): Promise<MemoryService> {
      const repository = await store.repository()
      const db = store.dbIfReady
      if (db === undefined) throw new Error('the memory database opened without a usable handle')
      return serviceFor(repository, db)
    },
  }
}

/** What one call needs: the service, and the session it runs as. */
interface CallContext {
  readonly service: MemoryService
  readonly session: MemorySession
}

/**
 * Resolve the service and the session for one call.
 *
 * A missing database throws, and the host turns the message into the model's tool result. That is
 * deliberate: a silent no-op would let the model report a memory as stored when nothing was
 * written, and the user would find out the next time they were contradicted.
 */
async function callContext(access: Access, exec: ToolExecution): Promise<CallContext> {
  if (exec.signal.aborted) throw new Error('cancelled before it ran')
  const service = access.ready() ?? (await access.open().catch(() => undefined))
  if (service === undefined) throw new Error('the memory database is unavailable; nothing was written')
  return { service, session: createSession(cwdOf(exec)) }
}

/** The calling agent's working directory, when the host sent one. */
export function cwdOf(exec: ToolExecution): string | undefined {
  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

// ---------------------------------------------------------------------------------------------
// remember
// ---------------------------------------------------------------------------------------------

interface RememberArgs {
  readonly text: string
  readonly scope?: 'global' | 'project'
  readonly title?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
}

interface RememberValue {
  readonly decision: string
  readonly scope: string
  readonly text: string
  readonly reason: string
  readonly superseded: readonly number[]
  /** Absent when nothing was written and no existing entry was matched. */
  readonly id?: number
}

/** Fields shared by every tool here, so a schema mistake is fixed in one place. */
function rememberSchema(): ToolDefinition['output']['schema'] {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: { type: 'string', description: 'new | merge | update | ignore | rejected' },
      id: { type: 'integer', description: 'row id of the entry written, or of the entry the request matched' },
      scope: { type: 'string', description: 'layer the entry lives in' },
      text: { type: 'string', description: 'the entry body after the write' },
      reason: { type: 'string', description: 'why the write took this form' },
      superseded: { type: 'array', items: { type: 'integer' }, description: 'entries retired as contradicted' },
    },
  }
}

function rememberTool(access: Access, wrote: (agent: unknown) => void): ToolDefinition<RememberArgs, RememberValue> {
  return defineTool<RememberArgs, RememberValue>({
    name: `${TOOL_PREFIX}remember`,
    description:
      'Store one durable statement in long-term memory so it survives future sessions: a standing ' +
      'preference, a correction, a project convention, or a fact the user asked you to keep. Not ' +
      'for anything that only matters in this conversation.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The statement to store, verbatim and in the language it was said.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'global: every session. project: this repository only. Omit to decide from the text.',
      },
      title: { type: 'string', description: 'Short label for the memory index. Omit to derive one.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional grouping tags.' },
      pinned: {
        type: 'boolean',
        description: 'true: always injected as a standing rule instead of only when relevant.',
      },
    },
    output: {
      schema: rememberSchema(),
      render: (_args, value) => {
        if (value.decision === 'rejected') return [{ type: 'text', text: `not stored — ${value.reason}` }]
        const lines = [
          value.id === undefined ? value.decision : `${value.decision} #${value.id} (${value.scope})`,
          value.reason,
        ]
        if (value.superseded.length > 0) lines.push(`superseded: ${value.superseded.map((id) => `#${id}`).join(' ')}`)
        // A merge keeps the earlier statement and appends this one, so the body is no longer what
        // the caller sent. Printing it is how the caller learns what the entry now says.
        if (value.decision === 'merge') lines.push(`entry now reads: ${clip(value.text, RENDER_MERGED_CHARS)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    // Read-then-write: two overlapping remembers can both see "no similar entry" and both insert.
    // The registry honours this by not starting the second call until the first has returned.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { service, session } = await callContext(access, exec)
      const result = service.remember(session, {
        text: args.text,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
      })
      // A refused write stored nothing and a supersede-only one changed nothing the model needs
      // re-offered, so the notification follows the row: `id === null` means no entry exists.
      if (result.id !== null) wrote(exec.agent)
      return {
        decision: result.decision,
        scope: result.scope,
        text: result.text,
        reason: result.reason,
        superseded: result.superseded,
        ...(result.id === null ? {} : { id: result.id }),
      }
    },
  })
}

// ---------------------------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------------------------

interface ForgetArgs {
  readonly id: number
}

interface ForgetValue {
  readonly ok: boolean
  readonly id: number
  readonly status: string
  readonly text: string
  readonly reason: string
}

function forgetTool(access: Access, wrote: (agent: unknown) => void): ToolDefinition<ForgetArgs, ForgetValue> {
  return defineTool<ForgetArgs, ForgetValue>({
    name: `${TOOL_PREFIX}forget`,
    description:
      'Forget one memory by id. The entry is archived: it stops being injected and searched but stays ' +
      'recoverable. Use when the user says a stored memory is wrong or no longer applies.',
    parameters: {
      id: { type: 'integer', required: true, description: 'Entry id, as shown by search results.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'integer' },
          status: { type: 'string', description: 'active | outdated | archived | pending | unknown' },
          text: { type: 'string', description: 'what the entry said' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `forgot #${value.id} (${value.status}): ${clip(value.text, RENDER_TEXT_CHARS)}` }]
          : [{ type: 'text', text: `not forgotten: ${value.reason}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { service, session } = await callContext(access, exec)
      const result = service.forget(session, { id: args.id })
      // Retiring an entry changes the index and can free the slot a card was occupying, so the
      // ledger has to hear about it for the same reason a write has to.
      if (result.ok) wrote(exec.agent)
      return result
    },
  })
}

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

interface SearchArgs {
  readonly query?: string
  readonly scope?: MemoryScope
  readonly limit?: number
}

interface SearchEntryValue {
  readonly id: number
  readonly title: string
  readonly text: string
  readonly scope: string
  readonly status: string
  readonly pinned: boolean
  readonly importance: number
  readonly tags: readonly string[]
  readonly updatedAt: string
}

interface SearchValue {
  readonly count: number
  readonly query: string
  readonly entries: readonly SearchEntryValue[]
}

function searchTool(access: Access, config: ResolvedConfig): ToolDefinition<SearchArgs, SearchValue> {
  return defineTool<SearchArgs, SearchValue>({
    name: `${TOOL_PREFIX}search`,
    description:
      'Search long-term memory, or list what is known. Call this before telling the user you do not ' +
      'know something about them or about this project — the answer may already be stored.',
    parameters: {
      query: { type: 'string', description: 'Keywords. Omit to list the most recently used entries.' },
      scope: {
        type: 'string',
        enum: ['identity', 'global', 'project', 'daily'],
        description: 'Restrict to one layer. Omit to search every layer this session can see.',
      },
      limit: { type: 'integer', description: `Maximum entries to return. Default ${config.searchLimitDefault}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          query: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                title: { type: 'string' },
                text: { type: 'string' },
                scope: { type: 'string' },
                status: { type: 'string' },
                pinned: { type: 'boolean' },
                importance: { type: 'integer' },
                tags: { type: 'array', items: { type: 'string' } },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.entries.length === 0) {
          return [{
            type: 'text',
            text: value.query === '' ? 'no memories recorded yet for this session' : `no entry matched "${value.query}"`,
          }]
        }
        const lines = value.entries.map((entry) => {
          const flags = [entry.scope, entry.pinned ? 'pinned' : '', entry.status === 'active' ? '' : entry.status]
            .filter((part) => part !== '')
            .join(' ')
          const label = entry.title === '' ? '' : `${entry.title} — `
          return `#${entry.id} [${flags}] ${label}${clip(entry.text, RENDER_TEXT_CHARS)}`
        })
        return [{ type: 'text', text: `${value.count} ${value.count === 1 ? 'entry' : 'entries'}:\n${lines.join('\n')}` }]
      },
    },
    // Read-only, and the one call a model is likely to issue several of at once.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { service, session } = await callContext(access, exec)
      const requested = args.limit ?? config.searchLimitDefault
      const limit = Math.max(1, Math.min(config.searchLimitMax, Math.trunc(requested)))
      const entries = service.search(session, {
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.scope === undefined ? {} : { scope: [args.scope] }),
        limit,
      })
      return {
        count: entries.length,
        query: args.query?.trim() ?? '',
        entries: entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          text: entry.text,
          scope: entry.scope,
          status: entry.status,
          pinned: entry.pinned,
          importance: entry.importance,
          tags: entry.tags,
          updatedAt: entry.updatedAt,
        })),
      }
    },
  })
}

// ---------------------------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------------------------

interface LogArgs {
  readonly entries: readonly string[]
  readonly date?: string
}

interface LogValue {
  readonly date: string
  readonly written: number
  readonly reason: string
  readonly id?: number
}

function logTool(access: Access, wrote: (agent: unknown) => void): ToolDefinition<LogArgs, LogValue> {
  return defineTool<LogArgs, LogValue>({
    name: `${TOOL_PREFIX}log`,
    description:
      "Append to today's journal: what was done, decided or learned in this session. One entry per " +
      'line. The journal is a daily memory entry, not a task list — use the todo tool for work in progress.',
    parameters: {
      entries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'One line per entry.',
      },
      date: { type: 'string', description: 'Day to file under, YYYY-MM-DD. Omit for today.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          written: { type: 'integer' },
          reason: { type: 'string' },
          id: { type: 'integer', description: 'row id of the day, absent when nothing was written' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.written === 0
          ? `nothing appended: ${value.reason}`
          : `appended ${value.written} ${value.written === 1 ? 'entry' : 'entries'} to ${value.date}${value.id === undefined ? '' : ` (#${value.id})`}`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { service, session } = await callContext(access, exec)
      const result = service.log(session, {
        entries: args.entries.map((text) => ({ text })),
        ...(args.date === undefined ? {} : { date: args.date }),
      })
      // The daily layer is indexed and retrievable, so a fresh journal entry is exactly the kind
      // of thing the next turn should be able to be reminded of.
      if (result.written > 0) wrote(exec.agent)
      return {
        date: result.date,
        written: result.written,
        reason: result.reason,
        ...(result.id === null ? {} : { id: result.id }),
      }
    },
  })
}

// ---------------------------------------------------------------------------------------------
// mounting
// ---------------------------------------------------------------------------------------------

/**
 * What the mount can share with the rest of the plugin.
 *
 * Both fields exist for the same reason: a write and an injection must not disagree. `access`
 * makes the injection path read through the same cached service the tools write through, and
 * `onWrite` is what lets the injection path learn that the store changed — a memory the user just
 * corrected is exactly the one that must be offered again, even though its id has been seen.
 */
export interface MemoryToolHooks {
  /** The service accessor, when the caller already built one. */
  readonly access?: Access | undefined
  /**
   * Called with the calling agent after a write lands, never before and never for a failed one.
   *
   * The agent is part of the notification because the ledger it invalidates is per session: a write
   * in one project must not re-offer another project's memories.
   */
  readonly onWrite?: ((agent: unknown) => void) | undefined
}

/**
 * Register the tool set on the plugin context.
 *
 * Global tools, not agent-scoped: the tools read the calling agent out of `exec`, so one
 * registration serves every agent in the process — and a per-agent registration of the same names
 * would be one duplicate-name throw per session.
 *
 * @param ctx - plugin context.
 * @param config - resolved configuration, for the search limits.
 * @param store - the store handle the tools write through.
 * @param hooks - the accessor to reuse and the write notification. Optional: a test that mounts
 *   the tools alone gets a private accessor and no listener.
 * @returns how many tools were registered, which is what the wiring test asserts.
 */
export function mountMemoryTools(
  ctx: Context,
  config: ResolvedConfig,
  store: StoreHandle,
  hooks: MemoryToolHooks = {},
): number {
  const tools = toolsOf(ctx)
  if (tools === undefined) return 0

  const access = hooks.access ?? createAccess(store)
  // A bookkeeping failure must not turn a completed write into a failed tool call: the memory is
  // already on disk, and telling the model otherwise would invite it to write the same thing again.
  const wrote = (agent: unknown): void => {
    try {
      hooks.onWrite?.(agent)
    } catch {
      // Deliberately swallowed: the injection ledger is a cache, not the record.
    }
  }
  const definitions: readonly ToolDefinition<never, unknown>[] = [
    rememberTool(access, wrote) as ToolDefinition<never, unknown>,
    forgetTool(access, wrote) as ToolDefinition<never, unknown>,
    searchTool(access, config) as ToolDefinition<never, unknown>,
    logTool(access, wrote) as ToolDefinition<never, unknown>,
  ]

  for (const definition of definitions) tools.register(definition)
  return definitions.length
}

/** Trim a body for display without lying about it: the ellipsis says text was left out. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

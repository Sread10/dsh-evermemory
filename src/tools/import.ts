/**
 * The import tool: the conversational entry point to `runImport`.
 *
 * The import engine is the only part of this plugin that reads files the user did not write for it,
 * so this tool's whole job is to make one thing clear to the model: **what it is about to read and
 * what happened afterwards**. It hands back counts and a handful of quoted decisions rather than
 * the imported text, because a tool result is part of the conversation and an export of forty
 * thousand turns has no business being one.
 *
 * A dry run exists because "import my ChatGPT export" is a request with a real cost — hundreds of
 * entries, each one merged against the store — and the honest first answer is a preview.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

import { TOOL_PREFIX } from '../constants.js'
import type { ResolvedConfig } from '../config.js'
import { runImport } from '../importers/run.js'
import { createSession } from '../memory/service.js'
import type { StoreHandle } from '../storage/handle.js'
import { clip, cwdOf } from './memory.js'
import { toolsOf } from './service.js'

/** Items one call will consider when the caller does not say. Safe to re-run: the ledger skips. */
const DEFAULT_IMPORT_LIMIT = 500

/** Ceiling for one call, so a mistyped limit cannot turn into an hour of merging. */
const MAX_IMPORT_LIMIT = 2000

/** How many decisions the report quotes. */
const RENDER_SAMPLES = 5

/** Longest quoted text per sample. */
const RENDER_SAMPLE_CHARS = 140

/** An import may walk a large export, extract an archive and merge hundreds of entries. */
const IMPORT_TIMEOUT_MS = 120_000

interface ImportArgs {
  readonly path: string
  readonly scope?: 'global' | 'project'
  readonly tags?: readonly string[]
  readonly dryRun?: boolean
  readonly limit?: number
}

interface ImportSampleValue {
  readonly decision: string
  readonly text: string
  readonly uri: string
  readonly reason?: string
}

interface ImportValue {
  readonly ok: boolean
  readonly source: string
  readonly path: string
  readonly scope: string
  readonly dryRun: boolean
  readonly scanned: number
  readonly considered: number
  readonly known: number
  readonly oversized: number
  readonly written: number
  readonly merged: number
  readonly updated: number
  readonly ignored: number
  readonly rejected: number
  readonly logged: number
  readonly truncated: boolean
  readonly errors: readonly string[]
  readonly samples: readonly ImportSampleValue[]
}

function importTool(store: StoreHandle, config: ResolvedConfig): ToolDefinition<ImportArgs, ImportValue> {
  return defineTool<ImportArgs, ImportValue>({
    name: `${TOOL_PREFIX}import`,
    description:
      'Import long-term memories from another tool\'s data on this machine. Reads ChatGPT and ' +
      'claude.ai conversation exports (conversations.json, or the export .zip itself), Claude ' +
      'cloud memories (memories.json), Claude Code transcripts (~/.claude/projects), ZCode ' +
      '(~/.zcode/cli/memories), WorkBuddy/CodeBuddy memory directories, and plain JSON, JSONL or ' +
      'Markdown files. Formats are detected from content, not from the file name. Imported ' +
      'material goes through the same quality gate and merge as anything else, and each item is ' +
      'recorded in a ledger so re-running an import never duplicates work. Use dryRun first when ' +
      'the export is large or unfamiliar.',
    parameters: {
      path: {
        type: 'string',
        description: 'File or directory to import; ~ is expanded. A .zip export is extracted first.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description:
          'Layer for items whose source does not imply one. Defaults to global. Use project for ' +
          'material that is only true of the repository this session is working in.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to add to every imported entry, e.g. the name of the tool it came from.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Report what would be imported without writing anything.',
      },
      limit: {
        type: 'integer',
        description: `Most items to consider in this call (default ${DEFAULT_IMPORT_LIMIT}, max ${MAX_IMPORT_LIMIT}). A truncated import can simply be called again.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'false when nothing was read at all' },
          source: { type: 'string', description: 'detected source, e.g. ChatGPT export' },
          path: { type: 'string', description: 'what was read, after ~ expansion' },
          scope: { type: 'string', description: 'default layer used for items with none of their own' },
          dryRun: { type: 'boolean' },
          scanned: { type: 'integer', description: 'items the source produced' },
          considered: { type: 'integer', description: 'items this call looked at, after the limit' },
          known: { type: 'integer', description: 'items already imported by an earlier run' },
          oversized: { type: 'integer', description: 'items longer than the entry ceiling' },
          written: { type: 'integer' },
          merged: { type: 'integer' },
          updated: { type: 'integer' },
          ignored: { type: 'integer' },
          rejected: { type: 'integer' },
          logged: { type: 'integer', description: 'daily-log entries appended' },
          truncated: { type: 'boolean', description: 'more items remain; call again to continue' },
          errors: { type: 'array', items: { type: 'string' }, description: 'per-file problems, if any' },
          samples: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                decision: { type: 'string' },
                text: { type: 'string' },
                uri: { type: 'string' },
                reason: { type: 'string' },
              },
            },
            description: 'the first few decisions, for the report',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderImport(value) }],
    },
    timeoutMs: IMPORT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolExecution): Promise<ImportValue> {
      if (exec.signal.aborted) throw new Error('cancelled before it ran')
      const repository = store.repositoryIfReady ?? (await store.repository().catch(() => undefined))
      if (repository === undefined) throw new Error('the memory database is unavailable; nothing was imported')

      const session = createSession(cwdOf(exec))
      const limit = Math.max(1, Math.min(MAX_IMPORT_LIMIT, Math.trunc(args.limit ?? DEFAULT_IMPORT_LIMIT)))
      const outcome = await runImport(repository, {
        path: args.path,
        maxChars: config.maxMemoryChars,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
        projectKey: session.projectKey,
        projectPath: session.projectPath,
        limits: { maxItems: limit },
      })

      return {
        ok: outcome.ok,
        source: outcome.source,
        path: outcome.path,
        scope: args.scope ?? 'global',
        dryRun: outcome.dryRun,
        scanned: outcome.scanned,
        considered: outcome.considered,
        known: outcome.known,
        oversized: outcome.oversized,
        written: outcome.written,
        merged: outcome.merged,
        updated: outcome.updated,
        ignored: outcome.ignored,
        rejected: outcome.rejected,
        logged: outcome.logged,
        truncated: outcome.truncated,
        errors: outcome.errors,
        samples: outcome.samples.slice(0, RENDER_SAMPLES).map((sample) => ({
          decision: sample.decision,
          text: clip(sample.text, RENDER_SAMPLE_CHARS),
          uri: sample.uri,
          ...(sample.reason === undefined ? {} : { reason: sample.reason }),
        })),
      }
    },
  })
}

/** One report a person can read: what was read, what happened, and what is left. */
function renderImport(value: ImportValue): string {
  if (!value.ok && value.considered === 0) {
    return `import failed: ${value.errors.join('; ') || 'nothing was read'}`
  }

  const verb = value.dryRun ? 'would import' : 'imported'
  const lines = [`${verb} from ${value.source}: ${value.considered} of ${value.scanned} item(s) at ${value.path}`]

  const counts: string[] = []
  if (value.written > 0) counts.push(`${value.written} new`)
  if (value.merged > 0) counts.push(`${value.merged} merged`)
  if (value.updated > 0) counts.push(`${value.updated} updated`)
  if (value.ignored > 0) counts.push(`${value.ignored} already known`)
  if (value.logged > 0) counts.push(`${value.logged} logged`)
  if (value.known > 0) counts.push(`${value.known} skipped by the ledger`)
  if (value.oversized > 0) counts.push(`${value.oversized} too long`)
  if (value.rejected > 0) counts.push(`${value.rejected} refused by the gate`)
  if (counts.length > 0) lines.push(counts.join(', '))

  for (const sample of value.samples) {
    const reason = sample.reason === undefined ? '' : ` (${sample.reason})`
    lines.push(`  - ${sample.decision}: ${sample.text}${reason}`)
  }

  if (value.truncated) lines.push('more items remain — call again with the same path to continue')
  if (value.errors.length > 0) lines.push(`problems: ${value.errors.slice(0, 3).join('; ')}`)
  return lines.join('\n')
}

/**
 * Register the import tool on the plugin context.
 *
 * @param ctx - plugin context.
 * @param config - resolved configuration, for the entry ceiling.
 * @param store - the store handle the import writes through.
 * @returns how many tools were registered.
 */
export function mountImportTools(ctx: Context, config: ResolvedConfig, store: StoreHandle): number {
  const tools = toolsOf(ctx)
  if (tools === undefined) return 0
  tools.register(importTool(store, config) as ToolDefinition<never, unknown>)
  return 1
}

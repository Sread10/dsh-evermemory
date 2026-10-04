/**
 * Deciding what the user actually pointed at.
 *
 * The detection is by CONTENT SHAPE, never by filename, and that is not fastidiousness: Claude and
 * ChatGPT both ship a file called `conversations.json`, and one has a flat `chat_messages` array
 * while the other has a `mapping` tree. A reader that trusted the name would parse every ChatGPT
 * export as an empty Claude one and report "0 memories imported" without an error — the worst
 * possible outcome, because it looks like success.
 *
 * Files are sniffed from a bounded head rather than parsed: an export can be larger than memory,
 * and a decision that only needs to know which keys appear near the start should not require
 * reading the whole thing.
 */

import { listDir, listFiles, readText, statSafe } from './fs.js'
import { scanChatGpt } from './sources/chatgpt.js'
import { scanClaudeCode, scanClaudeMemories, scanClaudeWeb } from './sources/claude.js'
import { scanWorkBuddy } from './sources/workbuddy.js'
import { scanZCode } from './sources/zcode.js'
import { scanGeneric } from './sources/generic.js'
import type { Scan, ScanOptions, SourceInput } from './types.js'

/** What a path turned out to be. */
export interface Detected {
  /** Stable identifier, used in the report and in tests. */
  readonly id: DetectedId
  /** The source's own label, e.g. `ChatGPT export`. */
  readonly label: string
  readonly scan: Scan
  /** The path to scan, which differs from the input when a directory was unwrapped. */
  readonly input: SourceInput
}

export type DetectedId =
  | 'chatgpt'
  | 'claude-web'
  | 'claude-memories'
  | 'claude-code'
  | 'zcode'
  | 'workbuddy'
  | 'generic'

/** Bytes of a file read to decide what it is. */
const SNIFF_BYTES = 64 * 1024

/**
 * Directory names owned by the WorkBuddy family of memory stores.
 *
 * All three generations are here because they hold the SAME memories: a project used with WorkBuddy,
 * then CodeBuddy, then the harness itself has three copies on disk, and the reader collapses them by
 * content.
 */
const WORKBUDDY_MARKERS = ['.deepseek-harness', '.workbuddy', '.codebuddy'] as const

/**
 * The WorkBuddy / harness memory file.
 *
 * Verified against a real store rather than assumed: the user-level file is
 * `~/.workbuddy/memory/<workspace-id>_memory.md` — the underscore form, not a bare `memory.md` —
 * and a project's is `MEMORY.md`. Both are sectioned documents, and both are one file rather than a
 * directory, so they need a rule of their own. `memory_summary.md` is deliberately not matched:
 * it summarises the other files instead of holding anything of its own.
 */
const WORKBUDDY_FILE = /(?:^|_)memory\.md$/u

/** The last segment of a path, with either separator. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]+/u)
  return parts[parts.length - 1] ?? ''
}

/** The segment before the last one, or `''` when there is none. */
function parentName(path: string): string {
  const parts = path.split(/[\\/]+/u).filter((part) => part !== '')
  return parts[parts.length - 2] ?? ''
}

/**
 * Is this the WorkBuddy family's store?
 *
 * Checks the path itself as well as its children, because all three of these are things a user
 * reasonably types: the project that holds `.workbuddy/`, the marker directory itself, and the
 * `memory/` inside it.
 *
 * @param path - the directory the user named.
 * @param dirs - names of its subdirectories.
 * @param names - names of everything inside it.
 * @returns true when the WorkBuddy reader should handle it.
 */
function looksLikeWorkBuddy(path: string, dirs: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
  const self = baseName(path).toLowerCase()
  const parent = parentName(path).toLowerCase()
  if (WORKBUDDY_MARKERS.some((marker) => dirs.has(marker))) return true
  if (WORKBUDDY_MARKERS.some((marker) => marker === self)) return true
  if (self === 'memory' && WORKBUDDY_MARKERS.some((marker) => marker === parent)) return true
  return names.has('MEMORY.md')
}

/**
 * Layer an item should be filed into when a run says nothing else.
 *
 * Exported so `run.ts` and the tool descriptions cannot drift apart from the detection order.
 */
export const DEFAULT_IMPORT_SCOPE: 'global' | 'project' = 'global'

/**
 * Work out which source reads this path.
 *
 * @param input - the path the user named.
 * @returns the source to run, or `undefined` when nothing recognises it.
 */
export function detect(input: SourceInput): Detected | undefined {
  const entry = statSafe(input.path)
  if (!entry) return undefined

  if (entry.directory) return detectDirectory(input)
  const sniff = readText(input.path, SNIFF_BYTES)
  if (!sniff.ok) return undefined
  return detectFile(input, entry.name.toLowerCase(), sniff.text)
}

/** Recognise a directory by what is inside it. */
function detectDirectory(input: SourceInput): Detected | undefined {
  const entries = listDir(input.path)
  const names = new Set(entries.map((entry) => entry.name))
  const dirs = new Set(entries.filter((entry) => entry.directory).map((entry) => entry.name))

  // WorkBuddy first, and deliberately so. Its user-level store is `~/.workbuddy/memory/`, whose
  // `memory` child is exactly the shape the ZCode rule below looks for — checking ZCode first would
  // hand a WorkBuddy store to the wrong reader, and that reader would find no frontmatter and import
  // nothing at all. The markers are checked on the path itself as well as on its children, so
  // pointing at `~/.workbuddy`, at `~/.workbuddy/memory`, or at a project that has one all work.
  if (looksLikeWorkBuddy(input.path, dirs, names)) {
    return { id: 'workbuddy', label: 'WorkBuddy memories', scan: scanWorkBuddy, input }
  }

  // ZCode and Claude Code are both directory layouts, and both are recognised by the directory
  // that holds their files rather than by the root the user happens to have typed.
  const projects = listDir(join(input.path, 'projects'))
  if (dirs.has('memory') || (projects.length > 0 && projects.some((project) => listDir(join(project.path, 'memory')).length > 0))) {
    return { id: 'zcode', label: 'ZCode memories', scan: scanZCode, input }
  }

  const jsonl = listFiles(input.path, '.jsonl')
  if (jsonl.length > 0 || entries.some((entry) => entry.directory && listFiles(entry.path, '.jsonl').length > 0)) {
    return { id: 'claude-code', label: 'Claude Code transcripts', scan: scanClaudeCode, input }
  }

  const json = entries.filter((entry) => !entry.directory && entry.name.toLowerCase().endsWith('.json'))
  for (const file of json) {
    const sniff = readText(file.path, SNIFF_BYTES)
    if (!sniff.ok) continue
    const shape = sniffConversations(sniff.text)
    if (shape === 'chatgpt') return { id: 'chatgpt', label: 'ChatGPT export', scan: scanChatGpt, input }
    if (shape === 'claude-web') return { id: 'claude-web', label: 'Claude export', scan: scanClaudeWeb, input }
    if (looksLikeClaudeMemories(sniff.text)) {
      return { id: 'claude-memories', label: 'Claude memories', scan: scanClaudeMemories, input }
    }
  }

  const markdown = listFiles(input.path, '.md')
  if (markdown.length > 0) return { id: 'generic', label: 'Markdown files', scan: scanGeneric, input }

  return undefined
}

/** Recognise a single file by its head. */
function detectFile(input: SourceInput, name: string, head: string): Detected | undefined {
  if (name.endsWith('.jsonl')) {
    return head.includes('"sessionId"') || head.includes('"isMeta"')
      ? { id: 'claude-code', label: 'Claude Code transcripts', scan: scanClaudeCode, input }
      : { id: 'generic', label: 'JSON Lines', scan: scanGeneric, input }
  }

  if (WORKBUDDY_FILE.test(name)) {
    return { id: 'workbuddy', label: 'WorkBuddy memory file', scan: scanWorkBuddy, input }
  }

  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    return { id: 'generic', label: 'Markdown', scan: scanGeneric, input }
  }

  if (name.endsWith('.json')) {
    const shape = sniffConversations(head)
    if (shape === 'chatgpt') return { id: 'chatgpt', label: 'ChatGPT export', scan: scanChatGpt, input }
    if (shape === 'claude-web') return { id: 'claude-web', label: 'Claude export', scan: scanClaudeWeb, input }
    if (looksLikeClaudeMemories(head)) {
      return { id: 'claude-memories', label: 'Claude memories', scan: scanClaudeMemories, input }
    }
    if (head.includes('"memories"') || head.includes('"items"') || /^\s*\[/u.test(head)) {
      return { id: 'generic', label: 'JSON', scan: scanGeneric, input }
    }
  }

  return undefined
}

/**
 * Which conversation export is this?
 *
 * A regex over the head, not `JSON.parse`, because the answer only needs the presence of a key —
 * and parsing is exactly what cannot be done to a file too large to hold.
 *
 * @param head - first bytes of the file.
 * @returns the vendor, or `undefined` when neither matches.
 */
export function sniffConversations(head: string): 'chatgpt' | 'claude-web' | undefined {
  if (/"mapping"\s*:/u.test(head)) return 'chatgpt'
  if (/"chat_messages"\s*:|"messages"\s*:\s*\[/u.test(head)) return 'claude-web'
  return undefined
}

/**
 * Does this look like a Claude `memories.json`?
 *
 * @param head - first bytes of the file.
 * @returns true when one of the three memory fields is present.
 */
export function looksLikeClaudeMemories(head: string): boolean {
  return /"conversations_memory"\s*:|"project_memories"\s*:|"memory_files"\s*:/u.test(head)
}

/** Join two path segments without importing `node:path` for one call. */
function join(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/u, '')}/${name}`
}

/**
 * Human-readable list of what the importer can read, for the error a failed detection produces.
 *
 * @returns one sentence.
 */
export function supportedSources(): string {
  return [
    'a ChatGPT export (conversations.json, or the exported .zip)',
    'a claude.ai export (conversations.json)',
    'a Claude memories.json',
    'a Claude Code transcripts directory (~/.claude/projects) or one .jsonl file',
    'a ZCode memory store (~/.zcode/cli/memories)',
    'WorkBuddy / CodeBuddy memory directories (.workbuddy, .codebuddy, .deepseek-harness), or one <workspace>_memory.md / MEMORY.md file',
    'any Markdown, .txt or JSON Lines file, one entry per paragraph, heading or line',
  ].join('; ')
}

/**
 * Options a scan needs, resolved from a caller's optional overrides.
 *
 * @param options - partial options.
 * @returns complete options.
 */
export function scanOptions(options: Partial<ScanOptions> = {}): ScanOptions {
  return { maxItems: 500, maxFiles: 200, maxBytes: 64 * 1024 * 1024, ...options }
}

/**
 * Import sources: everything Claude leaves on disk or in an account export.
 *
 * Three formats, one module, because they share a platform tag and a folder (`~/.claude`), and
 * because telling them apart is the genuinely hard part:
 *
 * - `conversations.json` from a claude.ai export has a FLAT `chat_messages` array.
 * - `conversations.json` from a ChatGPT export has a TREE in `mapping`.
 * - `memories.json` is claude.ai's server-side memory, three unrelated fields in one file.
 * - `~/.claude/projects/<project>/<session>.jsonl` is Claude Code's own transcript, and it is the
 *   one source here that survives an account being closed — the file is already on the disk.
 *
 * Every shape is probed defensively rather than trusted, because a file named `conversations.json`
 * is attached to both vendors' exports and the wrong parser reports success with zero items.
 */

import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

import type { SourcePlatform } from '../../constants.js'
import { ATTACHMENT_MARKER } from '../../distill/hygiene.js'
import { isDirectory, isFile, listDir, listFiles, readJson, readText, statSafe } from '../fs.js'
import { readJsonArray } from '../json.js'
import {
  emptyScan,
  type ImportItem,
  type Scan,
  type ScanOptions,
  type ScanResult,
  type SourceInput,
} from '../types.js'

/** Platform every item from this module is filed under. */
const SOURCE: SourcePlatform = 'claude'

/** Bytes allowed for one conversation. A long one with pasted code reaches a few MB. */
const MAX_ELEMENT_BYTES = 32 * 1024 * 1024

/**
 * Characters a section title may take before the summary is squeezed out of the label.
 *
 * A title like "Project context and standing preferences for the deployment pipeline" would
 * otherwise consume the whole 60-character budget and make the summary — the part that tells two
 * entries apart — invisible.
 */
const TITLE_CHARS = 40

/**
 * Characters in a generated label.
 *
 * The cap exists because a label is not decoration: the dedup/contradiction gate compares labels to
 * decide whether two entries are the same topic, so a shared template prefix makes every entry look
 * like every other one.
 */
const LABEL_CHARS = 60

/**
 * Short hex digest, for ids the source does not supply.
 *
 * @param input - text to hash.
 * @param length - hex characters to keep.
 * @returns the digest prefix.
 */
function sha(input: string, length: number): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length)
}

/**
 * First non-empty line of a body, stripped of list/quote/heading punctuation and cut at the first
 * sentence ending.
 *
 * @param body - the section body.
 * @returns the summary line, or an empty string when the body is blank.
 */
function firstLineOf(body: string): string {
  for (const line of body.split('\n')) {
    const cleaned = line.replace(/^[-*>#\s]+/u, '').trim()
    if (cleaned !== '') {
      const stop = cleaned.search(/[。.!?！？]/u)
      return (stop === -1 ? cleaned : cleaned.slice(0, stop)).trim()
    }
  }
  return ''
}

/**
 * Build the label for one section: `${title} · ${summary}`, capped.
 *
 * WHY this is not `${title}`: measured on a real `memories.json`, twenty entries labelled
 * "Claude memory · Work context" produced 169 mutual conflicts at the dedup gate — every pair looked
 * like the same topic. Appending the first real sentence, and cutting the title itself short enough
 * that the sentence always survives, is what makes the labels distinct.
 *
 * @param title - the source's own heading.
 * @param body - the section body.
 * @returns a label of at most {@link LABEL_CHARS} characters.
 */
function labelOf(title: string, body: string): string {
  const shortTitle = [...title].slice(0, TITLE_CHARS).join('')
  const summary = firstLineOf(body)
  const merged = summary === '' ? shortTitle : `${shortTitle} · ${summary}`
  if ([...merged].length <= LABEL_CHARS) return merged
  // Cut by code point, not by UTF-16 unit: a real export is half Chinese, and a cut between the two
  // halves of a surrogate pair renders as a replacement character in the report.
  return `${[...merged].slice(0, LABEL_CHARS).join('')}…`
}

// ─────────────────────────────────────────────────────────────────────────────
// claude.ai conversations.json (flat chat_messages)
// ─────────────────────────────────────────────────────────────────────────────

/** Same shard names, as ChatGPT: a big export arrives in pieces. */
const CONVERSATIONS_FILE = /^conversations(-\d+)?\.json$/iu

/** Role vocabulary of this export. Both spellings of "the person" appear in the wild. */
const ROLE: Readonly<Record<string, 'user' | 'assistant'>> = {
  human: 'user',
  user: 'user',
  assistant: 'assistant',
}

/**
 * Message text of one claude.ai message.
 *
 * Three shapes in one function, because all three appear in a single export: the legacy `text`
 * field, the modern `content: [{type:'text'}]` blocks, and `attachments[].extracted_content` — the
 * text Claude extracted from an uploaded file, which is frequently the densest material in the
 * conversation.
 *
 * The attachment body is APPENDED after {@link ATTACHMENT_MARKER} rather than pre-cut here: the
 * runner cuts at the marker when it decides what to mine, and a parser that cut early would throw
 * away material the operator explicitly asked to keep.
 *
 * @param message - one element of `chat_messages`.
 * @returns the combined text, or an empty string.
 */
function webTextOf(message: Record<string, unknown>): string {
  let text = ''
  const legacy = message['text']
  if (typeof legacy === 'string' && legacy.trim() !== '') {
    text = legacy.trim()
  } else {
    const content = message['content']
    if (Array.isArray(content)) {
      const blocks: string[] = []
      for (const block of content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
        const blockText = (block as Record<string, unknown>)['text']
        if (typeof blockText === 'string') blocks.push(blockText)
      }
      text = blocks.join('\n').trim()
    }
  }
  const attachments = Array.isArray(message['attachments']) ? message['attachments'] : []
  const bodies: string[] = []
  for (const attachment of attachments) {
    if (attachment === null || typeof attachment !== 'object') continue
    const extracted = (attachment as Record<string, unknown>)['extracted_content']
    if (typeof extracted === 'string' && extracted.trim() !== '') bodies.push(extracted.trim())
  }
  if (bodies.length === 0) return text
  const blob = bodies.join('\n\n')
  return text === '' ? blob : `${text}\n\n${ATTACHMENT_MARKER}\n${blob}`
}

/** What one export file contributed. */
interface FileScan {
  readonly items: readonly ImportItem[]
  readonly skipped: number
  readonly errors: readonly string[]
  /** True when the reader should not open another file. */
  readonly stop: boolean
  readonly truncated: boolean
}

/**
 * Read one claude.ai `conversations.json`.
 *
 * @param path - the file to read.
 * @param options - caps.
 * @param room - how many more items the scan may collect.
 * @returns what it found, and whether reading should continue.
 */
function scanWebFile(path: string, options: ScanOptions, room: number): FileScan {
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let truncated = false
  for (const step of readJsonArray(path, { maxBytes: options.maxBytes, maxElementBytes: MAX_ELEMENT_BYTES })) {
    if (!step.ok) {
      errors.push(step.error)
      break
    }
    if (items.length >= room) {
      truncated = true
      break
    }
    if (step.value === null || typeof step.value !== 'object' || Array.isArray(step.value)) {
      skipped += 1
      continue
    }
    const conversation = step.value as Record<string, unknown>
    // `chat_messages` first: that is this export's own name for the array. `messages` is accepted
    // because a sharded or re-exported file has been seen with the shorter name.
    const raw = Array.isArray(conversation['chat_messages']) ? conversation['chat_messages'] : conversation['messages']
    const messages = Array.isArray(raw) ? raw : []
    if (messages.length === 0) {
      skipped += 1
      continue
    }
    const uuid = conversation['uuid']
    const id = conversation['id']
    const name = typeof conversation['name'] === 'string' ? conversation['name'].trim() : ''
    const convId =
      (typeof uuid === 'string' && uuid !== '' ? uuid : '') ||
      (typeof id === 'string' && id !== '' ? id : '') ||
      sha(`${name}|${String(conversation['created_at'] ?? '')}`, 16)
    const label = name === '' ? convId : name
    const convAt = isoOf(conversation['created_at'])
    for (const entry of messages) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        skipped += 1
        continue
      }
      const message = entry as Record<string, unknown>
      const sender = message['sender'] ?? message['role']
      const role = typeof sender === 'string' ? ROLE[sender] : undefined
      if (role === undefined) {
        skipped += 1
        continue
      }
      const text = webTextOf(message)
      if (text === '') {
        skipped += 1
        continue
      }
      if (role !== 'user') {
        // Assistant turns are counted, not stored: this plugin never files somebody else's words as
        // the user's memory, and the report should say so rather than quietly show a smaller number.
        skipped += 1
        continue
      }
      if (items.length >= room) {
        truncated = true
        break
      }
      const messageId =
        (typeof message['uuid'] === 'string' && message['uuid'] !== '' ? message['uuid'] : '') ||
        (typeof message['id'] === 'string' && message['id'] !== '' ? message['id'] : '') ||
        sha(text, 16)
      const at = isoOf(message['created_at']) ?? convAt
      items.push({
        text,
        uri: `${path}#${label}`,
        itemId: sha(`claude-web|${convId}|${messageId}`, 24),
        tags: ['claude'],
        kind: 'utterance',
        ...(at === undefined ? {} : { at }),
      })
    }
    if (truncated) break
  }
  return { items, skipped, errors, stop: truncated || errors.length > 0, truncated }
}

/**
 * Scan a claude.ai account export.
 *
 * @param input - `conversations.json`, or the directory holding it.
 * @param options - item, file and byte caps.
 * @returns the user turns found, plus what could not be read.
 */
export const scanClaudeWeb: Scan = (input: SourceInput, options: ScanOptions): ScanResult => {
  const path = input.path
  if (!isDirectory(path) && !isFile(path)) {
    return emptyScan(SOURCE, 'Claude export', [`${path} does not exist`])
  }
  let files: readonly string[]
  if (input.directory) {
    files = listFiles(path, '.json')
      .filter((entry) => CONVERSATIONS_FILE.test(entry.name))
      .map((entry) => entry.path)
    if (files.length === 0) {
      return emptyScan(SOURCE, 'Claude export', [`no conversations*.json in ${path} — is this a claude.ai export?`])
    }
  } else {
    files = [path]
  }
  const cap = Math.min(options.maxFiles, files.length)
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let opened = 0
  let truncated = cap < files.length
  for (const file of files.slice(0, cap)) {
    const room = options.maxItems - items.length
    if (room <= 0) {
      truncated = true
      break
    }
    opened += 1
    const scan = scanWebFile(file, options, room)
    for (const item of scan.items) items.push(item)
    skipped += scan.skipped
    for (const error of scan.errors) errors.push(error)
    if (scan.truncated) truncated = true
    if (scan.stop) break
  }
  return { source: SOURCE, label: 'Claude export', items, files: opened, skipped, errors, truncated }
}

// ─────────────────────────────────────────────────────────────────────────────
// claude.ai cloud memories (memories.json)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a timestamp that is a string or a number of milliseconds.
 *
 * @param value - raw field.
 * @returns an ISO-8601 string, or undefined.
 */
function isoOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value.trim())
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

/** One heading plus its body, out of `conversations_memory`. */
interface Section {
  readonly title: string
  readonly body: string
}

/**
 * Split `conversations_memory` at top-level `**Title**` lines.
 *
 * Only a line that is EXACTLY bold text starts a section. A `**bold**` run inside a sentence is
 * emphasis, and treating it as a heading would cut one memory into two half-sentences.
 *
 * @param text - the `conversations_memory` string.
 * @returns one entry per non-empty section.
 */
function splitSections(text: string): readonly Section[] {
  const sections: Section[] = []
  let title: string | undefined
  let buffer: string[] = []
  const flush = (): void => {
    const body = buffer.join('\n').trim()
    if (title !== undefined && body !== '') sections.push({ title, body })
  }
  for (const line of text.split('\n')) {
    const match = /^\*\*(.+?)\*\*$/u.exec(line.trim())
    const heading = match?.[1]
    if (match !== null && heading !== undefined) {
      flush()
      title = heading.trim()
      buffer = []
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/**
 * Turn one memories.json body into items.
 *
 * Three independent fields, each producing its own items: `conversations_memory` (one string, split
 * at headings), `project_memories` (project id → string) and `memory_files` (Claude's own
 * `/areas/*.md` files). They are independent because a real export often has only one of them.
 *
 * @param data - the parsed JSON value.
 * @param file - path of the file, for the uri.
 * @returns items, and how many recognised-but-empty entries were dropped.
 */
function memoryItemsOf(data: unknown, file: string): { items: readonly ImportItem[]; skipped: number } {
  const items: ImportItem[] = []
  let skipped = 0
  let root = data
  // Export tooling has been seen wrapping the object in a one-element array; unwrap rather than
  // rejecting, since the shape is unambiguous.
  if (Array.isArray(root)) root = root[0]
  if (root === null || typeof root !== 'object') return { items, skipped }
  const record = root as Record<string, unknown>

  const conversationMemory = record['conversations_memory']
  if (typeof conversationMemory === 'string' && conversationMemory.trim() !== '') {
    const sections = splitSections(conversationMemory)
    for (const [index, section] of sections.entries()) {
      items.push({
        text: section.body,
        uri: `${file}#conversations_memory/${index + 1}`,
        itemId: `claude-memory|conversations|${section.title}`,
        title: labelOf(section.title, section.body),
        tags: ['claude', 'memory'],
        kind: 'entry',
      })
    }
    if (sections.length === 0) skipped += 1
  }

  const projects = record['project_memories']
  if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
      const body = typeof value === 'string' ? value.trim() : ''
      if (body === '') {
        skipped += 1
        continue
      }
      // The first 8 characters, because a project id in this file is a UUID and a full one is
      // unreadable in a label while still being enough to recognise the project by.
      const short = key.slice(0, 8)
      items.push({
        text: body,
        uri: `${file}#project/${short}`,
        itemId: `claude-memory|project|${key}`,
        title: labelOf(`Claude project memory · ${short}`, body),
        tags: ['claude', 'memory', `project:${short}`],
        kind: 'entry',
      })
    }
  }

  const files = record['memory_files']
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        skipped += 1
        continue
      }
      const fileEntry = entry as Record<string, unknown>
      const body = typeof fileEntry['content'] === 'string' ? fileEntry['content'].trim() : ''
      if (body === '') {
        skipped += 1
        continue
      }
      const rawPath = typeof fileEntry['path'] === 'string' ? fileEntry['path'].trim() : ''
      // `basename` on a POSIX path works on Windows too (node:path.win32 treats `/` as a separator),
      // so this handles the `/areas/work.md` this field actually contains.
      const name = rawPath === '' ? '(unnamed)' : basename(rawPath)
      items.push({
        text: body,
        uri: `${file}#file/${rawPath === '' ? '(unnamed)' : rawPath}`,
        itemId: `claude-memory|file|${rawPath}`,
        title: labelOf(`Claude memory file · ${name}`, body),
        tags: ['claude', 'memory', 'memory-file'],
        kind: 'entry',
      })
    }
  }

  return { items, skipped }
}

/**
 * Find the `memories.json` the user pointed at.
 *
 * A zip extraction leaves the file one level down, which is why a directory is searched rather than
 * assumed to contain the file directly.
 *
 * @param path - file or directory the user named.
 * @returns the path to read, or an error sentence.
 */
function resolveMemoriesFile(path: string): { readonly file: string } | { readonly error: string } {
  if (!isDirectory(path)) return { file: path }
  const direct = join(path, 'memories.json')
  if (isFile(direct)) return { file: direct }
  for (const entry of listDir(path)) {
    if (!entry.directory) continue
    const nested = join(entry.path, 'memories.json')
    if (isFile(nested)) return { file: nested }
  }
  return { error: `no memories.json in ${path} — is this a claude.ai memories export?` }
}

/**
 * Scan claude.ai cloud memories.
 *
 * @param input - `memories.json`, or a directory holding it.
 * @param options - caps.
 * @returns one entry per section, project and memory file.
 */
export const scanClaudeMemories: Scan = (input: SourceInput, options: ScanOptions): ScanResult => {
  const label = 'Claude memories'
  const path = input.path
  const resolved = resolveMemoriesFile(path)
  if ('error' in resolved) return emptyScan(SOURCE, label, [resolved.error])
  if (!isFile(resolved.file)) return emptyScan(SOURCE, label, [`${resolved.file} does not exist`])
  const parsed = readJson(resolved.file, options.maxBytes)
  if (!parsed.ok) return emptyScan(SOURCE, label, [parsed.error], 1)
  // `readJson` reports a parse failure but not a byte-capped one, so the length is checked too: a
  // truncated JSON file whose truncation happens to land on valid syntax would otherwise import
  // silently as a smaller memory set.
  const size = statSafe(resolved.file)?.size ?? 0
  const errors: string[] = []
  if (size > options.maxBytes) {
    errors.push(`${resolved.file} is ${size} bytes, over the ${options.maxBytes}-byte limit; raise maxBytes to read it all`)
  }
  const found = memoryItemsOf(parsed.value, resolved.file)
  const items = found.items.slice(0, Math.max(options.maxItems, 0))
  return {
    source: SOURCE,
    label,
    items,
    files: 1,
    skipped: found.skipped + (found.items.length - items.length),
    errors,
    truncated: found.items.length > items.length,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code transcripts (~/.claude/projects)
// ─────────────────────────────────────────────────────────────────────────────

/** What one transcript line contributed. */
interface Turn {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at?: string
}

/**
 * Pull a turn out of one transcript line.
 *
 * The accept/reject rules are the whole value of this source, because a transcript is mostly not
 * conversation: `isMeta` lines are Claude Code's own bookkeeping, `thinking` blocks are the model
 * talking to itself, and `tool_use`/`tool_result` blocks are machine payloads. A user line counts
 * only when its content is a plain string — the object form is a tool result being fed back in,
 * which the user never typed.
 *
 * @param line - one parsed JSONL line.
 * @param seq - its index in the file, used for the id.
 * @returns the turn, or undefined when the line is not something the user said or was told.
 */
function turnOf(line: Record<string, unknown>, seq: number): Turn | undefined {
  const type = line['type']
  if (type !== 'user' && type !== 'assistant') return undefined
  if (line['isMeta'] === true) return undefined
  const message = line['message']
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const content = (message as Record<string, unknown>)['content']
  let text = ''
  if (type === 'user') {
    if (typeof content !== 'string' || content.trim() === '') return undefined
    text = content.trim()
  } else {
    if (!Array.isArray(content)) return undefined
    const blocks: string[] = []
    for (const block of content) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
      const record = block as Record<string, unknown>
      if (record['type'] !== 'text') continue
      const blockText = record['text']
      if (typeof blockText === 'string' && blockText !== '') blocks.push(blockText)
    }
    text = blocks.join('\n').trim()
    if (text === '') return undefined
  }
  const timestamp = line['timestamp']
  const at = typeof timestamp === 'string' && timestamp.trim() !== '' ? timestamp.trim() : undefined
  return { seq, role: type, text, ...(at === undefined ? {} : { at }) }
}

/** What one transcript file contributed. */
interface Transcript {
  readonly turns: readonly Turn[]
  readonly convId: string
  readonly project?: string
  readonly skipped: number
  readonly truncated: boolean
}

/**
 * Parse one `.jsonl` transcript.
 *
 * The whole file is read through `readText`, which enforces the byte cap by reading one byte past it
 * so truncation is detectable. A transcript is one session and is measured in megabytes, so parsing
 * it from a bounded string is right where the streaming reader would be overkill.
 *
 * @param path - the transcript file.
 * @param maxBytes - byte cap for the read.
 * @returns the turns, the conversation identity, and what was skipped.
 */
function parseTranscript(path: string, maxBytes: number): Transcript | { readonly error: string } {
  const read = readText(path, maxBytes)
  if (!read.ok) return { error: read.error }
  // The basename is the session id when the file has none inside it; `.jsonl` is stripped so the id
  // matches what the `sessionId` field would have said.
  let convId = basename(path).replace(/\.jsonl$/iu, '')
  let project: string | undefined
  const turns: Turn[] = []
  let skipped = 0
  const lines = read.text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A half-written last line is normal in a transcript of a session that is still running, so an
      // unparseable line is counted and skipped rather than failing the file.
      skipped += 1
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped += 1
      continue
    }
    const record = parsed as Record<string, unknown>
    const sessionId = record['sessionId']
    if (typeof sessionId === 'string' && sessionId !== '') convId = sessionId
    if (project === undefined) {
      const cwd = record['cwd']
      if (typeof cwd === 'string' && cwd !== '') project = cwd
    }
    const turn = turnOf(record, index)
    if (turn === undefined) {
      skipped += 1
      continue
    }
    turns.push(turn)
  }
  return {
    turns,
    convId,
    ...(project === undefined ? {} : { project }),
    skipped,
    truncated: read.truncated,
  }
}

/** Suffix of a transcript file. */
const TRANSCRIPT_FILE = '.jsonl'

/** Directory holding the delegated agents' own transcripts, under each session. */
const SUBAGENTS_DIR = 'subagents'

/**
 * Does this path live in a `subagents/` sidechain?
 *
 * Tested as a path SEGMENT, not as a substring: a project directory can legitimately be called
 * `my-subagents-notes`, and excluding it on a substring match would hide real work.
 *
 * @param path - absolute path to test.
 * @returns true when a `subagents` directory is part of the path.
 */
function isSidechain(path: string): boolean {
  return path.split(/[\\/]+/u).includes(SUBAGENTS_DIR)
}

/**
 * Every transcript to read, newest first.
 *
 * One level under the root only, then one more level inside a project — the layout is
 * `root/<project>/<session>.jsonl`. `subagents/` is skipped because those transcripts are the
 * tool-loop traffic of a delegated agent, not the user's own words.
 *
 * @param root - the projects root, or one project directory, or one file.
 * @returns transcript paths, newest first.
 */
function transcriptFiles(root: string): readonly string[] {
  if (isFile(root)) return root.toLowerCase().endsWith(TRANSCRIPT_FILE) ? [root] : []
  const found: string[] = []
  const direct = listFiles(root, TRANSCRIPT_FILE)
  const projects = listDir(root).filter((entry) => entry.directory)
  // A directory holding `.jsonl` files directly is a project directory; one holding only
  // subdirectories is the projects root. Both are accepted, and a root that is both gets both.
  for (const file of direct) {
    if (!isSidechain(file.path)) found.push(file.path)
  }
  for (const project of projects) {
    if (project.name === SUBAGENTS_DIR) continue
    for (const file of listFiles(project.path, TRANSCRIPT_FILE)) {
      if (!isSidechain(file.path)) found.push(file.path)
    }
  }
  // `listFiles` is already newest-first per directory; this re-sort makes the order global so the
  // cap keeps the most recent sessions rather than the most recent directory's sessions.
  return found
    .map((path) => ({ path, modified: statSafe(path)?.modified ?? 0 }))
    .sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
    .map((entry) => entry.path)
}

/**
 * Scan Claude Code transcripts.
 *
 * The `maxFiles` cap here is a cost gate, not a performance guard: every transcript that survives
 * this scan goes through the distiller, and an uncapped run over a year of sessions is an LLM bill
 * the user did not ask for. That is why the newest files are read first — the recent sessions are
 * the ones whose conventions are still current.
 *
 * @param input - `~/.claude/projects`, one project directory, or one `.jsonl` file.
 * @param options - caps.
 * @returns the user turns found, plus what could not be read.
 */
export const scanClaudeCode: Scan = (input: SourceInput, options: ScanOptions): ScanResult => {
  const label = 'Claude Code transcripts'
  const root = input.path
  if (!isDirectory(root) && !isFile(root)) {
    return emptyScan(SOURCE, label, [`${root} does not exist`])
  }
  const files = transcriptFiles(root)
  if (files.length === 0) {
    return emptyScan(SOURCE, label, [`no .jsonl transcripts under ${root} — is this ~/.claude/projects?`])
  }
  const cap = Math.min(options.maxFiles, files.length)
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let opened = 0
  let truncated = cap < files.length
  for (const file of files.slice(0, cap)) {
    const room = options.maxItems - items.length
    if (room <= 0) {
      truncated = true
      break
    }
    opened += 1
    const transcript = parseTranscript(file, options.maxBytes)
    if ('error' in transcript) {
      errors.push(transcript.error)
      continue
    }
    skipped += transcript.skipped
    if (transcript.truncated) {
      errors.push(`${file} is larger than ${options.maxBytes} bytes and was read only in part`)
      truncated = true
    }
    const uri = `${file}#${transcript.convId}`
    const tags = transcript.project === undefined ? ['claude', 'claude-code'] : ['claude', 'claude-code', transcript.project]
    let taken = 0
    for (const turn of transcript.turns) {
      if (turn.role !== 'user') {
        // Assistant turns are counted, not stored: the user's judgement is the only thing this
        // plugin files, and a transcript is half assistant text by volume.
        skipped += 1
        continue
      }
      if (taken >= room) break
      taken += 1
      items.push({
        text: turn.text,
        uri,
        itemId: sha(`claude-code|${transcript.convId}|${turn.seq}|${turn.role}|${turn.text}`, 24),
        tags,
        kind: 'utterance',
        ...(turn.at === undefined ? {} : { at: turn.at }),
      })
    }
    if (taken < transcript.turns.filter((turn) => turn.role === 'user').length) truncated = true
  }
  return { source: SOURCE, label, items, files: opened, skipped, errors, truncated }
}

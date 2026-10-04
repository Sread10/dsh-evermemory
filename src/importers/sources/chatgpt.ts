/**
 * Import source: a ChatGPT account export (`conversations.json`).
 *
 * How to get one: ChatGPT → Settings → Data controls → Export data, and the mail carries a zip.
 * Big accounts get it sharded as `conversations.json`, `conversations-1.json`, … so a directory is
 * accepted and every `conversations*.json` in it is read.
 *
 * Two shape traps, both of which this module is built around:
 *
 * 1. A conversation is a TREE. `conv.mapping` is an object of node id → `{message, parent,
 *    children}`, and the obvious implementation walks the DAG back from `current_node` to pick the
 *    one branch the user "really" had. That is the wrong call here: the walk needs a root, a leaf
 *    and a tie-break for edited nodes, and every one of those is a guess about which branch is
 *    canonical. Instead every `user`/`assistant` node is taken and sorted by `create_time`, so a
 *    regenerated branch appears twice — acceptable, because the ledger hash and the merge gate
 *    absorb the duplicate, whereas a wrong trunk silently deletes half the user's history.
 *
 * 2. Only USER turns are emitted. The assistant's text is not the user's judgement, and this
 *    plugin's hard rule is that a memory is something the user stood behind. Assistant nodes are
 *    still walked and sorted because they carry the timestamps that order the user's turns.
 */

import { createHash } from 'node:crypto'

import type { SourcePlatform } from '../../constants.js'
import { isDirectory, isFile, listFiles } from '../fs.js'
import { readJsonArray } from '../json.js'
import {
  emptyScan,
  type ImportItem,
  type Scan,
  type ScanOptions,
  type ScanResult,
  type SourceInput,
} from '../types.js'

/**
 * `conversations.json`, plus the `conversations-<n>.json` shards a large export is split into.
 *
 * Anchored on purpose: the same directory holds `chat.html`, `message_feedback.json`,
 * `shared_conversations.json` and the user's uploaded files, and any of those read as a
 * conversation array would produce items attributed to the wrong file.
 */
const CONVERSATIONS_FILE = /^conversations(-\d+)?\.json$/iu

/** Platform every item from this source is filed under. */
const SOURCE: SourcePlatform = 'chatgpt'

/** Label shown in the import report. */
const LABEL = 'ChatGPT export'

/** Bytes allowed for one conversation. A long one with pasted code reaches a few MB. */
const MAX_ELEMENT_BYTES = 32 * 1024 * 1024

/**
 * Largest `create_time` still plausible as Unix SECONDS (~year 5138).
 *
 * @param seconds - the raw value from the export.
 * @returns true when it is a number in a range a conversation could actually fall in.
 */
function isPlausibleSeconds(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0 && seconds < 1e11
}

/**
 * Sort key for a message's creation time.
 *
 * @param value - raw `create_time` from the export.
 * @returns the numeric seconds, or -1 when the field is missing or unparseable.
 */
function secondsOf(value: unknown): number {
  if (typeof value === 'number' && isPlausibleSeconds(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (isPlausibleSeconds(parsed)) return parsed
  }
  // -1 rather than 0: an unparseable time sorts before a real one instead of tying with the epoch.
  return -1
}

/**
 * Unix seconds → ISO-8601.
 *
 * Absent and unparseable are both `undefined`, never a guessed date: an imported memory is read
 * back months later with its date shown, and a fabricated one is worse than a missing one.
 *
 * @param seconds - Unix seconds, or -1.
 * @returns an ISO-8601 string, or undefined.
 */
function isoOf(seconds: number): string | undefined {
  if (!isPlausibleSeconds(seconds)) return undefined
  const ms = seconds * 1000
  // Date range is ±8.64e15 ms; the 1e11-second guard makes this unreachable, but a wrong `at` is
  // the kind of thing that only shows up once a real export has an unhinged timestamp in it.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Short hex digest, for the two places this source has to invent a stable id.
 *
 * @param input - text to hash.
 * @param length - hex characters to keep.
 * @returns the digest prefix.
 */
function sha(input: string, length: number): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length)
}

/**
 * Message text out of `message.content.parts`.
 *
 * Multimodal turns carry objects in `parts` (image pointers, tool payloads); only non-empty strings
 * are text the user typed, so anything else is dropped rather than stringified.
 *
 * @param message - one `mapping` node's `message`.
 * @returns the joined text, or an empty string.
 */
function textOf(message: Record<string, unknown>): string {
  const content = message['content']
  if (content === null || typeof content !== 'object') return ''
  const parts = (content as Record<string, unknown>)['parts']
  if (!Array.isArray(parts)) return ''
  const strings: string[] = []
  for (const part of parts) {
    if (typeof part === 'string' && part.trim() !== '') strings.push(part)
  }
  return strings.join('\n').trim()
}

/** One user or assistant turn pulled out of a conversation's `mapping`. */
interface Turn {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at?: string
  readonly sort: number
}

/**
 * Flatten one conversation's `mapping` into time-ordered turns.
 *
 * @param conversation - one element of the export.
 * @returns every user/assistant turn with non-empty text, oldest first.
 */
function turnsOf(conversation: Record<string, unknown>): readonly Turn[] {
  const mapping = conversation['mapping']
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) return []
  // Fall back to the conversation's own timestamp when a node has none: regenerated branches carry
  // `create_time: null`, and without this they would all pile up in source order at the front.
  const conversationSeconds = secondsOf(conversation['create_time'])
  const turns: Turn[] = []
  for (const node of Object.values(mapping as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    const message = record['message']
    if (message === null || typeof message !== 'object') continue
    const inner = message as Record<string, unknown>
    const author = inner['author']
    const role = author !== null && typeof author === 'object' ? (author as Record<string, unknown>)['role'] : undefined
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(inner)
    if (text === '') continue
    const seconds = secondsOf(inner['create_time'])
    const sort = seconds > 0 ? seconds : conversationSeconds
    const id = typeof inner['id'] === 'string' && inner['id'] !== '' ? inner['id'] : ''
    const at = isoOf(sort)
    turns.push({
      id: id === '' ? sha(text, 16) : id,
      role,
      text,
      sort,
      ...(at === undefined ? {} : { at }),
    })
  }
  // A stable secondary key keeps two turns that share a timestamp in the order the mapping yielded
  // them, which for a linear conversation IS chronological order.
  return turns
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => a.turn.sort - b.turn.sort || a.index - b.index)
    .map((entry) => entry.turn)
}

/**
 * Items one conversation contributes.
 *
 * @param conversation - one element of the export.
 * @param file - path of the export file, for the uri.
 * @returns the user turns, and how many recognised turns were dropped.
 */
function itemsOf(conversation: Record<string, unknown>, file: string): { items: readonly ImportItem[]; skipped: number } {
  const rawId = conversation['conversation_id']
  const fallbackId = conversation['id']
  const title = typeof conversation['title'] === 'string' ? conversation['title'].trim() : ''
  const convId =
    (typeof rawId === 'string' && rawId !== '' ? rawId : '') ||
    (typeof fallbackId === 'string' && fallbackId !== '' ? fallbackId : '') ||
    sha(`${title}|${String(conversation['create_time'] ?? '')}`, 16)
  // The title is what makes a report readable; the id is the fallback, because a conversation can
  // legitimately be untitled and `conversations.json#<uuid>` still tells the user where it came from.
  const label = title === '' ? convId : title
  const items: ImportItem[] = []
  let skipped = 0
  for (const turn of turnsOf(conversation)) {
    if (turn.role !== 'user') {
      // Deliberately dropped, and deliberately counted: a report where 400 assistant turns vanish
      // silently reads like a parser bug, while `skipped: 400` reads like the policy it is.
      skipped += 1
      continue
    }
    items.push({
      text: turn.text,
      uri: `${file}#${label}`,
      itemId: sha(`chatgpt|${convId}|${turn.id}`, 24),
      tags: ['chatgpt'],
      kind: 'utterance',
      ...(turn.at === undefined ? {} : { at: turn.at }),
    })
  }
  return { items, skipped }
}

/** What one export file contributed. */
interface FileScan {
  readonly items: readonly ImportItem[]
  readonly skipped: number
  readonly errors: readonly string[]
  /** True when the caller should not open another file. */
  readonly stop: boolean
  /** True when a cap, rather than the end of the data, stopped this file. */
  readonly truncated: boolean
}

/**
 * Read one `conversations*.json`.
 *
 * Streaming, because a real export's `conversations.json` is routinely hundreds of megabytes and
 * `JSON.parse` on that size sits next to V8's maximum string length.
 *
 * @param path - the file to read.
 * @param options - caps.
 * @param room - how many more items the scan may collect.
 * @returns what it found, and whether reading should continue.
 */
function scanFile(path: string, options: ScanOptions, room: number): FileScan {
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
    const conversation = itemsOf(step.value as Record<string, unknown>, path)
    skipped += conversation.skipped
    // `room` was checked before the conversation was parsed, so a single conversation can overshoot
    // it by its own length. Trimming here is what keeps `maxItems` a real cap rather than a hint.
    const remaining = room - items.length
    for (const item of conversation.items.slice(0, Math.max(remaining, 0))) items.push(item)
    if (conversation.items.length > remaining) {
      truncated = true
      break
    }
  }
  return { items, skipped, errors, stop: truncated || errors.length > 0, truncated }
}

/**
 * Every `conversations*.json` under a directory, newest first.
 *
 * @param dir - directory the user pointed at.
 * @returns the matching file paths.
 */
function conversationFiles(dir: string): readonly string[] {
  return listFiles(dir, '.json')
    .filter((entry) => CONVERSATIONS_FILE.test(entry.name))
    .map((entry) => entry.path)
}

/**
 * Scan a ChatGPT export.
 *
 * Accepts one export file, or a directory holding the whole sharded export. Never throws: every
 * unusable path comes back as an `emptyScan` with a sentence the report can print.
 *
 * @param input - file or directory the user named.
 * @param options - item, file and byte caps.
 * @returns the user turns found, plus what could not be read.
 */
export const scanChatGpt: Scan = (input: SourceInput, options: ScanOptions): ScanResult => {
  const path = input.path
  if (!isDirectory(path) && !isFile(path)) {
    return emptyScan(SOURCE, LABEL, [`${path} does not exist`])
  }
  let files: readonly string[]
  if (input.directory) {
    files = conversationFiles(path)
    if (files.length === 0) {
      return emptyScan(SOURCE, LABEL, [`no conversations*.json in ${path} — is this a ChatGPT export?`])
    }
  } else {
    // A named file is honoured whatever it is called: the user's export may have been renamed in
    // transit, and refusing it on the file name would be pedantry with no safety value.
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
    const scan = scanFile(file, options, room)
    for (const item of scan.items) items.push(item)
    skipped += scan.skipped
    for (const error of scan.errors) errors.push(error)
    if (scan.truncated) truncated = true
    if (scan.stop) break
  }
  return { source: SOURCE, label: LABEL, items, files: opened, skipped, errors, truncated }
}

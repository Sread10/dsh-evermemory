/**
 * The catch-all source: plain Markdown, plain text, JSON Lines and JSON.
 *
 * Three jobs, and they share one file because they share one rule — take the unit the author
 * already delimited and do not look inside it. Markdown gives headings or paragraphs, JSON Lines
 * gives lines, JSON gives array elements. Nothing here runs a cue pattern: a file the user chose to
 * import is material they consider worth keeping, and mining it for "must"/"never" would store a
 * fraction of what they handed over while calling the rest noise.
 *
 * It also reads this plugin's own export, which is what makes the round trip meaningful: export to
 * JSON Lines, import it into another machine, and every entry arrives as one item with its title,
 * tags and timestamp intact.
 */

import { isMemoryScope } from '../../distill/judge.js'
import { exists, isDirectory, listFiles, readJson, readText } from '../fs.js'
import { readJsonArray } from '../json.js'
import { emptyScan, type ImportItem, type ScanOptions, type ScanResult, type SourceInput } from '../types.js'
import { headline, normaliseBody, paragraphs } from '../text.js'

/** Marker written by this plugin's own JSON Lines export. */
export const EXPORT_MARKER = 'evermemory'

/** Fields that might hold an entry's text, most specific first. */
const TEXT_KEYS = ['text', 'content', 'memory', 'note', 'body', 'value'] as const

/** Fields that might hold a title. */
const TITLE_KEYS = ['title', 'name', 'subject'] as const

/**
 * Read whatever the user pointed at.
 *
 * @param input - file or directory.
 * @param options - caps.
 * @returns the items found, plus anything that could not be read.
 */
export function scanGeneric(input: SourceInput, options: ScanOptions): ScanResult {
  if (input.directory) return scanDirectory(input, options)
  const name = input.path.toLowerCase()
  if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) return scanJsonLines(input.path, options)
  if (name.endsWith('.json')) return scanJson(input.path, options)
  return scanMarkdownFile(input.path, options)
}

/** Read every Markdown and text file under a directory. */
function scanDirectory(input: SourceInput, options: ScanOptions): ScanResult {
  const files = [...listFiles(input.path, '.md'), ...listFiles(input.path, '.txt'), ...listFiles(input.path, '.markdown')]
  if (files.length === 0) return emptyScan(null, 'Markdown files', [`no .md or .txt files under ${input.path}`])
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let truncated = false
  let opened = 0
  for (const file of files) {
    if (opened >= options.maxFiles) {
      truncated = true
      break
    }
    const result = scanMarkdownFile(file.path, { ...options, maxItems: options.maxItems - items.length })
    opened += 1
    items.push(...result.items)
    errors.push(...result.errors)
    skipped += result.skipped
    if (items.length >= options.maxItems) {
      truncated = true
      break
    }
  }
  return { source: null, label: 'Markdown files', items, files: opened, skipped, errors, truncated }
}

/**
 * Split a Markdown file into entries.
 *
 * Headings win when the file has more than one, because an author who wrote headings already said
 * where the boundaries are; otherwise blank lines do, because that is the only convention every
 * dialect of Markdown agrees on.
 *
 * @param path - file to read.
 * @param options - caps.
 * @returns the items found.
 */
function scanMarkdownFile(path: string, options: ScanOptions): ScanResult {
  const read = readText(path, options.maxBytes)
  if (!read.ok) return emptyScan(null, 'Markdown', [read.error])
  const text = read.text
  const errors = read.truncated ? [`${path} is larger than the import limit; the beginning was read`] : []
  const sections = splitMarkdown(text)
  const items: ImportItem[] = []
  let skipped = 0
  for (const [index, section] of sections.entries()) {
    if (items.length >= options.maxItems) break
    const body = normaliseBody(section.body)
    if (body === '') {
      skipped += 1
      continue
    }
    items.push({
      text: body,
      uri: sections.length > 1 ? `${path}#${section.title === '' ? index + 1 : section.title}` : path,
      itemId: `file|${path}|${index}`,
      ...(section.title === '' ? {} : { title: section.title }),
      kind: 'entry',
      tags: ['file'],
    })
  }
  return {
    source: null,
    label: 'Markdown',
    items,
    files: 1,
    skipped,
    errors,
    truncated: read.truncated || items.length >= options.maxItems,
  }
}

/** Split Markdown into `{title, body}` sections. */
function splitMarkdown(text: string): readonly { readonly title: string; readonly body: string }[] {
  const lines = text.split(/\r?\n/u)
  const headingIndexes: number[] = []
  for (const [index, line] of lines.entries()) {
    if (/^#{1,3} /u.test(line)) headingIndexes.push(index)
  }
  if (headingIndexes.length > 1) {
    const sections: { title: string; body: string }[] = []
    for (const [position, start] of headingIndexes.entries()) {
      const end = headingIndexes[position + 1] ?? lines.length
      const title = (lines[start] ?? '').replace(/^#{1,3}\s*/u, '').trim()
      sections.push({ title, body: lines.slice(start + 1, end).join('\n') })
    }
    const preamble = lines.slice(0, headingIndexes[0]).join('\n')
    if (preamble.trim() !== '') sections.unshift({ title: '', body: preamble })
    return sections
  }
  return paragraphs(text).map((part) => ({ title: headline(part), body: part }))
}

/** Read one JSON Lines file. */
function scanJsonLines(path: string, options: ScanOptions): ScanResult {
  const read = readText(path, options.maxBytes)
  if (!read.ok) return emptyScan(null, 'JSON Lines', [read.error])
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let platform: 'evermemory' | null = null
  let lineNumber = 0
  let truncated = read.truncated

  for (const rawLine of read.text.split(/\r?\n/u)) {
    lineNumber += 1
    const line = rawLine.trim()
    if (line === '') continue
    if (items.length >= options.maxItems) {
      truncated = true
      break
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      skipped += 1
      continue
    }
    if (isRecord(parsed) && EXPORT_MARKER in parsed) {
      platform = 'evermemory'
      continue
    }
    const item = toItem(parsed, `${path}:${lineNumber}`)
    if (item === undefined) {
      skipped += 1
      continue
    }
    items.push(item)
  }

  if (items.length === 0 && skipped === 0 && !truncated) errors.push(`${path} had no entries`)
  return {
    source: platform,
    label: platform === 'evermemory' ? 'evermemory export' : 'JSON Lines',
    items,
    files: 1,
    skipped,
    errors,
    truncated,
  }
}

/** Read one JSON file: an array of entries, a wrapped array, or a single entry. */
function scanJson(path: string, options: ScanOptions): ScanResult {
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let truncated = false
  let platform: 'evermemory' | null = null

  const small = readJson(path, 4 * 1024 * 1024)
  if (small.ok) {
    const collected = collect(small.value, path, options, items.length)
    items.push(...collected.items)
    skipped += collected.skipped
    platform = collected.platform
    errors.push(...collected.errors)
  } else {
    // Too big to hold: stream the array instead. The wrapper key is decided by `readJsonArray`.
    for (const step of readJsonArray(path, { maxBytes: options.maxBytes, maxElementBytes: 16 * 1024 * 1024 })) {
      if (!step.ok) {
        errors.push(step.error)
        break
      }
      if (items.length >= options.maxItems) {
        truncated = true
        break
      }
      const item = toItem(step.value, path)
      if (item === undefined) {
        skipped += 1
        continue
      }
      items.push(item)
    }
  }

  if (items.length === 0 && errors.length === 0) errors.push(`${path} had no entries`)
  return {
    source: platform,
    label: platform === 'evermemory' ? 'evermemory export' : 'JSON',
    items,
    files: 1,
    skipped,
    errors,
    truncated,
  }
}

/** Turn a parsed JSON value into items. */
function collect(
  value: unknown,
  path: string,
  options: ScanOptions,
  already: number,
): { items: ImportItem[]; skipped: number; platform: 'evermemory' | null; errors: string[] } {
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let platform: 'evermemory' | null = null

  let list: unknown[]
  if (Array.isArray(value)) list = value
  else if (isRecord(value)) {
    if (EXPORT_MARKER in value) platform = 'evermemory'
    const wrapped = ['memories', 'items', 'entries', 'data'].map((key) => value[key]).find((candidate) => Array.isArray(candidate))
    if (wrapped !== undefined) list = wrapped as unknown[]
    else list = [value]
  } else {
    return { items, skipped, platform, errors: [`${path} is not an array or an object`] }
  }

  for (const element of list) {
    if (already + items.length >= options.maxItems) break
    const item = toItem(element, path)
    if (item === undefined) {
      skipped += 1
      continue
    }
    items.push(item)
  }
  return { items, skipped, platform, errors }
}

/** Turn one parsed element into an item, or nothing when it holds no text. */
function toItem(value: unknown, uri: string): ImportItem | undefined {
  if (typeof value === 'string') {
    const text = normaliseBody(value)
    return text === '' ? undefined : { text, uri, kind: 'entry' }
  }
  if (!isRecord(value)) return undefined

  let text = ''
  for (const key of TEXT_KEYS) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      text = candidate
      break
    }
  }
  if (text === '') return undefined
  const body = normaliseBody(text)

  let title: string | undefined
  for (const key of TITLE_KEYS) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      title = candidate.trim()
      break
    }
  }

  const tags = Array.isArray(value['tags']) ? value['tags'].filter((tag): tag is string => typeof tag === 'string') : []
  const scope = isMemoryScope(value['scope']) ? value['scope'] : undefined
  const at = typeof value['at'] === 'string' ? value['at'] : typeof value['createdAt'] === 'string' ? value['createdAt'] : undefined
  const id = typeof value['id'] === 'string' || typeof value['id'] === 'number' ? String(value['id']) : undefined

  return {
    text: body,
    uri,
    kind: 'entry',
    ...(title === undefined ? {} : { title }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(scope === undefined ? {} : { scope }),
    ...(at === undefined ? {} : { at }),
    ...(id === undefined ? {} : { itemId: `file|${id}` }),
  }
}

/** Narrow an unknown to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Does a path look like something this source should read?
 *
 * @param path - path to test.
 * @returns true for Markdown, text, JSON or JSON Lines, including a directory holding them.
 */
export function looksGeneric(path: string): boolean {
  if (isDirectory(path)) return true
  if (!exists(path)) return false
  return /\.(?:md|markdown|txt|json|jsonl|ndjson)$/iu.test(path)
}

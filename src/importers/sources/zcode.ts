/**
 * Import source: the ZCode memory store (`~/.zcode/cli/memories`).
 *
 * Layout, one directory per project:
 *
 *     projects/<project>/memory/<name>.md     one memory per file, YAML frontmatter + body
 *     projects/<project>/topics/<name>.md     same shape, a different bucket
 *     projects/<project>/MEMORY.md            a regenerated index — NOT a memory
 *     projects/<project>/memory_summary.md    a regenerated summary — NOT a memory
 *
 * The two regenerated files are the trap in this format. They are Markdown in the same directories
 * as the memories, they contain the same sentences, and importing them would file every memory
 * twice under a name nobody wrote. They are skipped by name.
 *
 * The body is kept VERBATIM (only trimmed). A ZCode memory is already a memory — the user or their
 * agent wrote it as one — so running the code-fence stripper over it would delete half of a
 * technical note for no benefit, since nothing downstream treats its wording as a cue.
 */

import { basename, join } from 'node:path'

import type { SourcePlatform } from '../../constants.js'
import { isDirectory, isFile, listDir, listFiles, readText } from '../fs.js'
import {
  emptyScan,
  type ImportItem,
  type Scan,
  type ScanOptions,
  type ScanResult,
  type SourceInput,
} from '../types.js'

/** Platform every item from this source is filed under. */
const SOURCE: SourcePlatform = 'zcode'

/** Label shown in the import report. */
const LABEL = 'ZCode memories'

/** ZCode's own vocabulary for what kind of memory a file holds. */
const MEMORY_TYPES = ['user', 'feedback', 'reference', 'project', 'other'] as const
type MemoryType = (typeof MEMORY_TYPES)[number]

/** Generated files that live beside the memories and must not be imported as one. */
const GENERATED_FILES = new Set(['MEMORY.md', 'memory_summary.md'])

/** Buckets under one project directory that hold memory files. */
const BUCKETS = ['memory', 'topics'] as const

/** Project key used when the user points straight at a memory directory with no project above it. */
const ROOT_PROJECT = 'root'

/**
 * A leading frontmatter block.
 *
 * The closing delimiter is required, so a file that merely starts with a `---` horizontal rule is
 * not mistaken for frontmatter — a mistake that would delete the first paragraph of the body.
 */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

/** One parsed memory file. */
interface ParsedMemory {
  readonly name: string
  readonly type: MemoryType
  readonly body: string
  readonly at?: string
}

/**
 * Strip one layer of matching quotes from a frontmatter value.
 *
 * @param value - the raw value.
 * @returns the unquoted value.
 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')
    }
  }
  return trimmed
}

/**
 * Parse a `key: value` frontmatter block, flat or nested.
 *
 * Tolerant on purpose, and the tolerance is a documented requirement rather than laziness: ZCode
 * writes flat keys, a `metadata:` block of nested keys is also in circulation, and a hand-edited
 * file may have neither. A nested `type:` is read because it is the same fact under a different
 * parent, while a nested `name:` is deliberately NOT promoted — a nested `name` is usually the
 * author's display name, and using it as the memory's title would mislabel the file.
 *
 * @param text - the whole file.
 * @param fallbackName - the filename without `.md`.
 * @returns the memory's name, type, body and optional timestamp.
 */
function parseMemory(text: string, fallbackName: string): ParsedMemory {
  const match = FRONTMATTER.exec(text)
  if (match === null) {
    // No frontmatter at all: the whole file is the body and the filename is the name.
    return { name: fallbackName, type: 'other', body: text.trim() }
  }
  const fields = new Map<string, string>()
  const nested = new Map<string, string>()
  // A `metadata:` key with no inline value opens a nested block; every field after it belongs there.
  // The flag is what keeps `type:` inside that block from being read as the memory's own type.
  let inMetadata = false
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const pair = /^([ \t]*)([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/u.exec(line)
    if (pair === null) {
      // A continuation line of a folded scalar (`description: >`), or a list item. Neither carries a
      // field this source uses, so it is dropped rather than guessed at.
      continue
    }
    const indent = pair[1] ?? ''
    const key = pair[2]
    if (key === undefined) continue
    const value = unquote(pair[3] ?? '')
    if (indent === '' && key === 'metadata' && value === '') {
      inMetadata = true
      continue
    }
    if (indent === '' && key === 'metadata') {
      // `metadata: {type: feedback}` on one line. The braces are tolerated and the type is read out
      // of it, because that inline form is what a machine-written file looks like.
      const inlineType = /(?:^|[,{]\s*)type\s*:\s*([^,}]+)/u.exec(value)
      if (inlineType?.[1] !== undefined) nested.set('type', unquote(inlineType[1]))
      continue
    }
    if (indent !== '' || inMetadata) nested.set(key, value)
    else fields.set(key, value)
  }
  const name = (fields.get('name') ?? '').trim()
  const rawType = (fields.get('type') ?? nested.get('type') ?? 'other').trim()
  const type: MemoryType = MEMORY_TYPES.some((candidate) => candidate === rawType)
    ? (rawType as MemoryType)
    : 'other'
  // Long-form timestamps are the only ones ZCode writes; anything else is ignored rather than parsed
  // leniently, because a wrong `at` is worse than a missing one on an imported memory.
  const stamp = (fields.get('updatedAt') ?? fields.get('createdAt') ?? '').trim()
  const at = /^\d{4}-\d{2}-\d{2}T/u.test(stamp) ? stamp : undefined
  return {
    name: name === '' ? fallbackName : name,
    type,
    body: text.slice(match[0].length).trim(),
    ...(at === undefined ? {} : { at }),
  }
}

/**
 * Map a ZCode project directory name to the label people recognise.
 *
 * ZCode appends `-<16 hex>` to a project directory, so `hrouter-beb03a33e80b027c` is the project
 * `hrouter`. The suffix is stripped for the tag and the label; leaving it on would put a random hash
 * in every memory's tags.
 *
 * @param name - the directory name.
 * @returns the friendly project name.
 */
function projectLabel(name: string): string {
  const match = /^(.+?)-[0-9a-fA-F]{16}$/u.exec(name)
  return match?.[1] === undefined ? name : match[1]
}

/**
 * Items one memory file contributes.
 *
 * @param file - path to the `.md` file.
 * @param bucket - `memory` or `topics`.
 * @param project - the project directory name.
 * @param options - caps.
 * @returns the item, or undefined when the file is empty or unreadable.
 */
function itemOf(
  file: string,
  bucket: string,
  project: string,
  options: ScanOptions,
): { readonly item: ImportItem } | { readonly error: string } | undefined {
  const read = readText(file, options.maxBytes)
  if (!read.ok) return { error: read.error }
  const fallbackName = basename(file).replace(/\.md$/iu, '')
  const memory = parseMemory(read.text, fallbackName)
  // An empty body is a name with nothing behind it. Importing it would create a memory whose text is
  // blank, and the runner has no other way to tell that this file had nothing in it.
  if (memory.body === '') return undefined
  const label = projectLabel(project)
  return {
    item: {
      text: memory.body,
      uri: `${file}#${bucket}`,
      itemId: `zcode|${label}|${memory.name}`,
      title: memory.name,
      tags: ['zcode', label, memory.type],
      kind: 'entry',
      // No `scope`. The ZCode project directory cannot be mapped onto one of this plugin's project
      // keys — the run files an item into the CALLING session's project, so guessing here would put
      // another repository's conventions into this one. The project name travels in the tags, and
      // the run decides the layer.
      ...(memory.at === undefined ? {} : { at: memory.at }),
    },
  }
}

/** One memory file to read, with where it sits in the store. */
interface MemoryFile {
  readonly file: string
  /** `memory` or `topics`, for the uri fragment. */
  readonly bucket: string
  /** Project directory name, still carrying ZCode's hash suffix. */
  readonly project: string
}

/** Buckets under one project directory, by bucket name. */
function bucketsOf(dir: string): readonly string[] {
  const found: string[] = []
  for (const bucket of BUCKETS) {
    if (isDirectory(join(dir, bucket))) found.push(bucket)
  }
  return found
}

/**
 * Work out which memory files the input names.
 *
 * Three accepted inputs, because the user may have copied a whole store, one project, or one file:
 * the memories root, one project directory, or one `.md` file. Files are collected up front so the
 * cap loop below is a single pass over one list.
 *
 * @param path - the input path.
 * @returns files to read, or an error sentence.
 */
function resolveFiles(path: string): { readonly files: readonly MemoryFile[] } | { readonly error: string } {
  if (isFile(path)) {
    return { files: [{ file: path, bucket: basename(path).replace(/\.md$/iu, ''), project: ROOT_PROJECT }] }
  }
  const collect = (dir: string, project: string, buckets: readonly string[]): readonly MemoryFile[] =>
    buckets.flatMap((bucket) =>
      listFiles(join(dir, bucket), '.md').map((entry) => ({ file: entry.path, bucket, project })),
    )
  const projectsRoot = join(path, 'projects')
  if (isDirectory(projectsRoot)) {
    const files: MemoryFile[] = []
    for (const entry of listDir(projectsRoot)) {
      if (!entry.directory) continue
      files.push(...collect(entry.path, entry.name, bucketsOf(entry.path)))
    }
    if (files.length === 0) return { error: `no memory/*.md or topics/*.md under ${projectsRoot}` }
    return { files }
  }
  const buckets = bucketsOf(path)
  if (buckets.length > 0) return { files: collect(path, basename(path), buckets) }
  return { error: `${path} is not a ZCode memory store (no projects/<project>/memory directory)` }
}

/**
 * Scan a ZCode memory store.
 *
 * @param input - the store root, one project directory, or one `.md` memory file.
 * @param options - item, file and byte caps.
 * @returns one entry per memory file.
 */
export const scanZCode: Scan = (input: SourceInput, options: ScanOptions): ScanResult => {
  const path = input.path
  if (!isDirectory(path) && !isFile(path)) {
    return emptyScan(SOURCE, LABEL, [`${path} does not exist`])
  }
  const resolved = resolveFiles(path)
  if ('error' in resolved) return emptyScan(SOURCE, LABEL, [resolved.error])
  const items: ImportItem[] = []
  const errors: string[] = []
  let skipped = 0
  let opened = 0
  let truncated = false
  for (const entry of resolved.files) {
    if (GENERATED_FILES.has(basename(entry.file))) {
      // Reported as skipped rather than ignored: a user who wonders why `MEMORY.md` was not imported
      // should find the answer in the report instead of in the source.
      skipped += 1
      continue
    }
    if (opened >= options.maxFiles || items.length >= options.maxItems) {
      truncated = true
      break
    }
    opened += 1
    const found = itemOf(entry.file, entry.bucket, entry.project, options)
    if (found === undefined) {
      skipped += 1
      continue
    }
    if ('error' in found) {
      errors.push(found.error)
      continue
    }
    items.push(found.item)
  }
  return { source: SOURCE, label: LABEL, items, files: opened, skipped, errors, truncated }
}

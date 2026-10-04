/**
 * Import source: the WorkBuddy / CodeBuddy / dsh-harness file memory store.
 *
 * One store, three generations of it. WorkBuddy wrote `.workbuddy/memory/`, CodeBuddy writes
 * `.codebuddy/memory/`, and the harness itself writes `.deepseek-harness/MEMORY.md` beside
 * `.deepseek-harness/memory/YYYY-MM-DD.md`. A project used with more than one of them holds the SAME
 * memories in two or three places, so the read order is fixed —
 * `~/.deepseek-harness` beats `.workbuddy` beats `.codebuddy` — and the first copy of a piece of
 * content wins while every later copy is counted as skipped. Importing all three would file the same
 * memory two or three times and leave the user to notice only after the merge gate ran.
 *
 * Two file shapes, decided by FILENAME rather than by a flag inside the file:
 *
 * - `memory.md` and `<workspace-id>_memory.md` are SECTIONS documents: one entry per heading, or per
 *   bold label, because that is how the format stores a list of distinct facts in one file. The real
 *   store writes `<workspace-id>_memory.md`, not `memory.md`, so both names are accepted.
 * - Every other `.md` is ONE ENTRY, headings included. `YYYY-MM-DD.md` is a daily log — one day is one
 *   narrative, and splitting it at whatever headings happened to be written would shatter it into
 *   fragments the distiller then judges out of context.
 *
 * The real sections document carries a trailer that is NOT a memory and must never reach the
 * distiller:
 *
 * ```text
 * <!-- RAW_JSON_START
 * { "uid": "…", "memoryBlock": "<the whole memory block above, JSON-escaped>", … }
 * RAW_JSON_END -->
 * ```
 *
 * It is the same text as the block above it, escaped. Importing it doubles every memory in the file,
 * and the doubled file then exceeds the runner's per-file character budget, at which point the whole
 * file is rejected as oversized and the user's entire WorkBuddy memory imports as zero rows. So the
 * trailer is removed before anything else looks at the text.
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { SourcePlatform } from '../../constants.js'
import { isDirectory, isFile, listFiles, readText } from '../fs.js'
import {
  emptyScan,
  type ImportItem,
  type Scan,
  type ScanOptions,
  type ScanResult,
  type SourceInput,
} from '../types.js'

/** Platform every item from this source is filed under. */
const SOURCE: SourcePlatform = 'workbuddy'

/** Label shown in the import report. */
const LABEL = 'WorkBuddy memories'

/** Directory holding the user-level memory, shared by every project. */
const USER_DIR = '.deepseek-harness'

/** Directory markers that identify a project that has this store. */
const MARKERS = [USER_DIR, '.workbuddy', '.codebuddy'] as const

/**
 * How many ancestors to probe when the caller hands us a directory inside a project.
 *
 * The deepest layout worth recognising is a monorepo package
 * (`<repo>/packages/<app>/.workbuddy/memory`, three levels below the project root). Bounding the walk
 * this tightly has a second effect that matters: a scan started in the system temporary directory
 * cannot wander up into the user's home and import stores the caller never mentioned.
 */
const MAX_WALK_UP = 4

/**
 * The one file name shape whose contents are a list of sections rather than a single memory.
 *
 * The second alternative is the shape the real store uses: one file per workspace, named after the
 * workspace id (`2fe0877c-0888-4701-b8ab-024c01741d89_memory.md`). A file whose name merely ENDS in
 * `memory.md` without the underscore (`memory_summary.md`) is not matched, which is deliberate.
 */
const MEMORY_FILE = /^(?:memory|.+_memory)\.md$/iu

/** Heading that starts a section. Deeper than `###` and the file is prose, not a list of facts. */
const SECTION_HEADING = /^#{1,3}[ \t]+(.+?)[ \t]*$/u

/**
 * A line that is nothing but bold text, which the real sections document uses as its label.
 *
 * Headings and bold labels are both accepted because the store changed from one to the other, and a
 * file written by either generation has to import the same way.
 */
const BOLD_LABEL = /^\*\*(.+?)\*\*$/u

/** A Markdown list item: `- `, `* `, `+ `, `1. ` or `1) `, with its indentation. */
const BULLET = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/u

/**
 * The `RAW_JSON_START … RAW_JSON_END` comment, which duplicates the whole file.
 *
 * @see the file comment for why this has to be removed rather than parsed.
 */
const RAW_JSON_BLOCK = /<!--[ \t]*RAW_JSON_START[\s\S]*?RAW_JSON_END[ \t]*-->/gu

/** Marker used to find a trailer that lost its closing tag. */
const RAW_JSON_START = 'RAW_JSON_START'

/**
 * Whole lines of file scaffolding, which describe the file rather than record a memory.
 *
 * This is a list of known shapes and not a general rule such as "drop every line starting with `>`",
 * because a `>` line inside a memory is a quotation the user wrote down and a `:` line is ordinary
 * prose — only these exact header keys are metadata the store writes itself.
 */
const SCAFFOLD_LINES: readonly RegExp[] = [
  /^[ \t]*>[ \t]*last updated[ \t]*:/iu,
  /^[ \t]*>[ \t]*version[ \t]*:/iu,
  // The two headings the store wraps its content in; the content between them is what matters.
  /^[ \t]*#{1,6}[ \t]+user memory profile[ \t]*$/iu,
  /^[ \t]*#{1,6}[ \t]+memory block[ \t]*$/iu,
]

/** `YYYY-MM-DD.md`, the daily log's name. */
const DAILY_LOG = /^(\d{4})-(\d{2})-(\d{2})\.md$/u

/**
 * A horizontal rule: a line of three or more `-`, `*` or `_`.
 *
 * A sections document uses one to separate its block from the trailer, and in a file that is already
 * split into entries a separator line belongs to none of them. Only sections documents lose it — in a
 * daily log the same line is part of the day's narrative.
 */
const RULE_LINE = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/u

/** How much of a label's own text survives before the summary that makes it distinct. */
const TITLE_CHARS = 40

/**
 * Longest label worth showing in a report.
 *
 * The same cap the claude.ai memories reader uses, for the same measured reason: a shared label makes
 * the dedup gate treat unrelated entries as one topic.
 */
const LABEL_CHARS = 60

/**
 * The tag kind a marker directory implies.
 *
 * `dsh` rather than `workbuddy` for the harness's own store: the platform is still WorkBuddy — that
 * is the family this importer exists for — but the tag has to say which generation of the store the
 * memory actually came from, because that is what the user recognises.
 *
 * @param marker - one of `MARKERS`.
 * @returns the kind string.
 */
function kindOfMarker(marker: string): string {
  if (marker === '.workbuddy') return 'workbuddy'
  if (marker === '.codebuddy') return 'codebuddy'
  return 'dsh'
}

/**
 * The kind a bare file path implies, so a file the caller named directly still carries provenance.
 *
 * @param file - absolute path to a `.md` file.
 * @returns the kind string.
 */
function kindOfPath(file: string): string {
  const parts = file.split(/[\\/]+/u)
  if (parts.includes('.codebuddy')) return 'codebuddy'
  if (parts.includes('.workbuddy')) return 'workbuddy'
  return 'dsh'
}

/**
 * Is this directory the user-level store, shared by every project?
 *
 * Windows paths differ only by case often enough that a literal comparison would mislabel the user's
 * own home file as a project file; the comparison is therefore case-insensitive there and exact
 * everywhere else.
 *
 * @param dir - a marker directory.
 * @returns true when its parent is the home directory.
 */
function isHomeStore(dir: string): boolean {
  const parent = dirname(dir)
  const home = homedir()
  if (process.platform === 'win32') return parent.toLowerCase() === home.toLowerCase()
  return parent === home
}

/** One file to read, with the provenance its items inherit. */
interface Candidate {
  readonly file: string
  /** `workbuddy`, `codebuddy` or `dsh` — the first tag on every item from this file, and the itemId prefix. */
  readonly kind: string
  /** True for `MEMORY.md`-style files, false for daily logs and single-memory files. */
  readonly sectioned: boolean
  /** Extra tags, e.g. `daily-log`. */
  readonly tags: readonly string[]
  /** Explicit title, used by daily logs, whose name IS the date. */
  readonly title?: string
}

/**
 * Short hex digest, used as the duplicate key.
 *
 * A hash rather than the text itself: the dedup set holds every imported body, and a year of daily
 * logs is megabytes of text that has no reason to be resident twice.
 *
 * @param input - normalised text.
 * @returns a 32-character digest.
 */
function digest(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Normalise text for duplicate detection.
 *
 * Whitespace is collapsed so a file that ends with a newline and the same file that does not count
 * as one memory. The comparison key is never stored — the item keeps its own line breaks.
 *
 * @param text - body text.
 * @returns the comparison key.
 */
function compareKey(text: string): string {
  return digest(text.replace(/\s+/gu, ' ').trim())
}

/**
 * Is this file name a daily log?
 *
 * @param name - the file's base name.
 * @returns true when it is `YYYY-MM-DD.md`.
 */
function isDailyLog(name: string): boolean {
  return DAILY_LOG.test(name)
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
 * Build the title for one item of a labelled section: `${label} · ${summary}`, capped.
 *
 * WHY the label alone is not enough: a list section produces one item per bullet, and four items
 * sharing one label are four entries the merge gate reads as one topic. The claude.ai reader was
 * measured at 169 mutual conflicts from twenty entries that shared a template label; this is the same
 * defect and the same fix.
 *
 * @param label - the section's heading or bold label.
 * @param body - the item's text.
 * @returns a title of at most {@link LABEL_CHARS} characters.
 */
function labelOf(label: string, body: string): string {
  const shortLabel = [...label].slice(0, TITLE_CHARS).join('')
  const summary = firstLineOf(body)
  const merged = summary === '' ? shortLabel : `${shortLabel} · ${summary}`
  if ([...merged].length <= LABEL_CHARS) return merged
  // Cut by code point, not by UTF-16 unit: this store is written in Chinese, and a cut between the
  // two halves of a surrogate pair renders as a replacement character in the report.
  return `${[...merged].slice(0, LABEL_CHARS).join('')}…`
}

/**
 * Remove the machine-written `RAW_JSON_START … RAW_JSON_END` trailer.
 *
 * @see the file comment: this block repeats the whole memory block, escaped.
 *
 * @param text - the file's text.
 * @returns the text with every trailer removed.
 */
function stripRawTrailer(text: string): string {
  const withoutBlocks = text.replace(RAW_JSON_BLOCK, '')
  const orphan = withoutBlocks.indexOf(RAW_JSON_START)
  if (orphan === -1) return withoutBlocks
  // A trailer whose closing tag never reached the disk (an interrupted write) still holds the escaped
  // copy of everything above it. Nothing after that marker is hand-written, so all of it goes.
  const lineStart = withoutBlocks.lastIndexOf('\n', orphan)
  return lineStart === -1 ? '' : withoutBlocks.slice(0, lineStart)
}

/**
 * Remove the store's own scaffolding lines.
 *
 * @param text - the file's text.
 * @param sectioned - true when the file is a sections document, which is what makes a horizontal rule
 *   a separator rather than text.
 * @returns the text without header metadata lines, wrapper headings or separator rules.
 */
function stripScaffold(text: string, sectioned: boolean): string {
  return text
    .split('\n')
    .filter((line) => !SCAFFOLD_LINES.some((pattern) => pattern.test(line)))
    .filter((line) => !(sectioned && RULE_LINE.test(line)))
    .join('\n')
}

/**
 * Title of a whole-file entry: the first heading, else the file name.
 *
 * @param text - the file's text.
 * @param file - its path.
 * @returns a human label for the entry.
 */
function wholeTitleOf(text: string, file: string): string {
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}[ \t]+(.+?)[ \t]*$/u.exec(line.trim())
    if (heading?.[1] !== undefined) return heading[1]
  }
  return basename(file).replace(/\.md$/iu, '')
}

/**
 * Remove a leading YAML frontmatter block.
 *
 * Requiring the closing `---` is what keeps a file whose first line is a horizontal rule from losing
 * its opening paragraph. An unclosed block is left alone rather than guessed at.
 *
 * @param text - the file's text.
 * @returns the body, and whether a block was actually removed.
 */
function stripFrontmatter(text: string): { readonly body: string; readonly had: boolean } {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text)
  if (match === null) return { body: text, had: false }
  return { body: text.slice(match[0].length), had: true }
}

/** One labelled part of a sections document. */
interface Section {
  /** The heading or bold label, when the section had one. */
  readonly label?: string
  /** Body text below the label. The label line itself is not repeated here. */
  readonly body: string
}

/** One item's worth of text inside a section, with the title it should be filed under. */
interface Part {
  readonly text: string
  readonly title: string
}

/**
 * Split a sections document at `^#{1,3} ` headings and at lines that are nothing but `**bold**`.
 *
 * Text before the first label becomes a section of its own rather than being dropped: a preamble is
 * written deliberately, and the one entry it costs is cheaper than silently losing it. The preamble of
 * a real store file is scaffolding, and {@link stripScaffold} leaves it empty, so it disappears.
 *
 * @param text - the file body.
 * @returns one section per label, in reading order.
 */
function splitSections(text: string): readonly Section[] {
  const sections: Section[] = []
  let label: string | undefined
  let buffer: string[] = []
  const flush = (): void => {
    const body = buffer.join('\n').trim()
    if (body === '') return
    sections.push({ body, ...(label === undefined ? {} : { label }) })
  }
  for (const line of text.split('\n')) {
    const found = SECTION_HEADING.exec(line)?.[1] ?? BOLD_LABEL.exec(line.trim())?.[1]
    if (found !== undefined) {
      flush()
      label = found
      // The label line is NOT kept in the body. It already travels in the item's title, and a list
      // section becomes one item per bullet — keeping it here would attach the label to the first
      // bullet only, so that one item would read differently from its siblings.
      buffer = []
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/**
 * True when an item says nothing beyond the label it was filed under.
 *
 * A template answers its own bullets instead of filling them: `- **Name:**` has no value at all, and
 * `- **Pronouns:** _(optional)_` has only the instruction to fill it in. Such an item is noise — it is a
 * statement in form, so the distiller keeps it and the index grows a line that tells the model nothing
 * it can act on. The check strips markup, removes a parenthesised placeholder, drops one leading label,
 * and asks whether anything is left.
 *
 * @param text - one item's text.
 * @returns true when only a label and a placeholder remain.
 */
function isPlaceholder(text: string): boolean {
  const body = text
    .replace(/\*\*|__|`|~~/gu, '')
    .replace(/[_*]{1,2}\([^)]*\)[_*]{1,2}/gu, '')
    .replace(/^[-*>#\s]*[^:：\n]{0,40}[:：][\s]*/u, '')
    .trim()
  return body === '' || /^\(?\s*(?:optional|required|todo|tbd|n\/a|待定|可选)\s*\)?$/iu.test(body)
}

/**
 * Split one section into the items it holds.
 *
 * A section that is a list becomes ONE ITEM PER BULLET: in the real store the bullets under one label
 * are separate standing requests, and joining them would hand the distiller a single
 * seven-hundred-character blob it cannot judge as one fact. A prose section stays ONE item — splitting
 * prose at its own line breaks would cut sentences in half.
 *
 * @param section - one labelled section.
 * @param fallbackTitle - title to use when neither the section nor the text offers one.
 * @returns one part per item, in file order.
 */
function partsOf(section: Section, fallbackTitle: string): readonly Part[] {
  const lines = section.body.split('\n')
  const indents: number[] = []
  for (const line of lines) {
    const match = BULLET.exec(line)
    if (match !== null) indents.push((match[1] ?? '').length)
  }
  const label = section.label
  if (indents.length === 0) {
    if (isPlaceholder(section.body)) return []
    return [{ text: section.body, title: label ?? fallbackTitle }]
  }
  // The shallowest bullet is the section's top level; anything deeper is that bullet's own sub-list and
  // stays with it, because a sub-item torn away from its parent loses the request it belongs to.
  const top = Math.min(...indents)
  const groups: string[][] = []
  let pending: string[] = []
  for (const line of lines) {
    const match = BULLET.exec(line)
    const depth = match === null ? -1 : (match[1] ?? '').length
    if (depth === top) {
      // The list marker is the list's syntax, not the memory's text: the item IS the list element now,
      // so the marker of the top-level bullet is dropped while deeper markers are left alone.
      groups.push([...pending, match?.[2] ?? line])
      pending = []
      continue
    }
    const current = groups[groups.length - 1]
    if (current === undefined) {
      if (line.trim() !== '') pending.push(line)
      continue
    }
    current.push(line)
  }
  const parts: Part[] = []
  for (const group of groups) {
    const text = group.join('\n').trim()
    if (text === '' || isPlaceholder(text)) continue
    const summary = firstLineOf(text)
    parts.push({
      text,
      title: label === undefined ? (summary === '' ? fallbackTitle : summary) : labelOf(label, text),
    })
  }
  return parts
}

/** A store directory found on disk, with the provenance its files inherit. */
interface Store {
  readonly dir: string
  readonly kind: string
  /** True for the user-level `.deepseek-harness`, whose memories outrank a project's. */
  readonly user: boolean
}

/**
 * Every marker directory on the way up from a directory, grouped by generation.
 *
 * The order is deliberate: the harness's own store is listed before the two buddy generations at
 * EVERY level, not just within one project, so `.deepseek-harness` beats `.workbuddy` beats
 * `.codebuddy` globally — the documented read order. Within one generation the nearest ancestor wins,
 * because a package's conventions are more specific than the repository's.
 *
 * @param start - directory to start from.
 * @returns store directories, in the order duplicates are resolved by.
 */
function markerStores(start: string): readonly Store[] {
  const stores: Store[] = []
  for (const marker of MARKERS) {
    let current = start
    for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
      const dir = join(current, marker)
      if (isDirectory(dir)) {
        stores.push({ dir, kind: kindOfMarker(marker), user: marker === USER_DIR && isHomeStore(dir) })
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return stores
}

/**
 * Every source this scan should read, in the order duplicates are resolved by.
 *
 * Which files are sections documents is decided by NAME, because that is what the store itself uses to
 * tell the two apart: `MEMORY.md` and `<workspace-id>_memory.md` are lists of facts, everything else is
 * one memory (a daily log, or a single note).
 *
 * @param input - what the user pointed at.
 * @returns sources, most authoritative first.
 */
function planSources(input: SourceInput): readonly Candidate[] {
  const path = input.path
  if (isFile(path)) return [candidateOf(path, kindOfPath(path))]
  const sources: Candidate[] = []
  // The marker routes come first because they carry provenance — which generation of the store the
  // file came from, and whether it is the user-level file. The routes below are fallbacks.
  for (const store of markerStores(path)) {
    const baseTags = store.user ? [store.kind, 'user'] : [store.kind]
    // `MEMORY.md` at the root of a store is the user's own long-term file in every generation, not only
    // in the harness: on a real machine `~/.workbuddy/MEMORY.md` holds the user's standing preferences.
    // Reading it here rather than through the directory fallback is what gives it its provenance tags.
    const memory = join(store.dir, 'MEMORY.md')
    if (isFile(memory)) sources.push({ file: memory, kind: store.kind, sectioned: true, tags: baseTags })
    // The buddy generations keep their memories under `memory/`; `.deepseek-harness` keeps the user
    // file at the store root and its daily logs under `memory/`, so both are read here.
    for (const file of listFiles(join(store.dir, 'memory'), '.md')) {
      sources.push(candidateOf(file.path, store.kind, baseTags))
    }
  }
  // A directory that IS a memory directory: either it is named `memory`, or it holds a file only the
  // store writes there. This is what lets the caller point straight at `~/.workbuddy/memory`, and what
  // makes a store that was copied, unzipped or renamed still readable.
  //
  // Only MEMORY DOCUMENTS are taken from such a directory, not every Markdown file in it. The store root
  // also holds the workspace's persona files — `BOOTSTRAP.md`, `IDENTITY.md`, `SOUL.md` and `USER.md`,
  // whose own text calls them "the source of truth for future runs" — and they are fill-in-the-blank
  // templates, not memories: measured on a real store, importing them turned `- **Name:**` and
  // `_(pick something you like)_` into stored rows, 50 items out of one empty template. They do not
  // belong in the identity layer either, which is reserved for the file a user hand-edits.
  const holders = listFiles(path, '.md')
  const isMemoryDir = basename(path).toLowerCase() === 'memory'
  if (isMemoryDir || holders.some((file) => MEMORY_FILE.test(file.name))) {
    for (const file of holders) {
      if (!isMemoryDir && !MEMORY_FILE.test(file.name) && !isDailyLog(file.name)) continue
      sources.push(candidateOf(file.path, kindOfPath(path)))
    }
  }
  // One file can be reached through two routes (a marker store and the directory rule, or two roots on
  // the way up). The plan keeps the first mention, so the scan can trust each path to appear once.
  const seen = new Set<string>()
  return sources.filter((candidate) => {
    if (seen.has(candidate.file)) return false
    seen.add(candidate.file)
    return true
  })
}

/**
 * Describe one file for the scan.
 *
 * @param file - absolute path.
 * @param kind - tag kind the file's location implies.
 * @param baseTags - tags to start from, when the location already decided them.
 * @returns the candidate.
 */
function candidateOf(file: string, kind: string, baseTags?: readonly string[]): Candidate {
  const name = basename(file)
  const daily = isDailyLog(name)
  const tags = baseTags === undefined ? [kind] : [...baseTags]
  if (daily) tags.push('daily-log')
  return {
    file,
    kind,
    sectioned: MEMORY_FILE.test(name),
    tags,
    // A daily log's name IS its title: the date is the only thing that distinguishes one from the
    // next, and the first heading inside it is usually a sub-topic.
    ...(daily ? { title: name.replace(/\.md$/iu, '') } : {}),
  }
}

/** What one file contributed. */
interface FileScan {
  readonly items: readonly ImportItem[]
  /** Entries dropped because the same content was already imported. */
  readonly duplicates: number
  readonly skipped: number
  readonly errors: readonly string[]
  /** True when the item cap stopped this file mid-way. */
  readonly truncated: boolean
}

/**
 * Read one memory file.
 *
 * @param candidate - the file and its provenance.
 * @param options - caps.
 * @param seen - comparison keys already imported, mutated as entries are accepted.
 * @param room - how many more items the scan may collect.
 * @returns what the file contributed.
 */
function scanFile(
  candidate: Candidate,
  options: ScanOptions,
  seen: Set<string>,
  room: number,
): FileScan {
  const items: ImportItem[] = []
  const errors: string[] = []
  let duplicates = 0
  let skipped = 0
  let truncated = false
  const read = readText(candidate.file, options.maxBytes)
  if (!read.ok) return { items, duplicates, skipped, errors: [read.error], truncated }
  const stripped = stripFrontmatter(read.text)
  if (stripped.had && stripped.body.trim() === '') {
    // Frontmatter and nothing else: a file with metadata about a memory that was never written.
    return { items, duplicates, skipped: skipped + 1, errors, truncated }
  }
  // The trailer and the scaffolding go before anything else reads the text: the trailer repeats the
  // whole file escaped, and the header lines are metadata. Removing them first also keeps a file that
  // is nothing but a trailer from being imported as one long entry.
  const wholeText = stripScaffold(stripRawTrailer(stripped.body), candidate.sectioned).trim()
  if (wholeText === '') return { items, duplicates, skipped: skipped + 1, errors, truncated }
  const sections = candidate.sectioned ? splitSections(wholeText) : [{ body: wholeText }]
  const fallbackTitle = wholeTitleOf(wholeText, candidate.file)
  let taken = 0
  let index = 0
  for (const part of sections.flatMap((section) => partsOf(section, fallbackTitle))) {
    const key = compareKey(part.text)
    if (seen.has(key)) {
      // The three directories are three generations of one store, so identical content in two of them
      // is one memory, not two. Counted, because the user should be able to see that the import
      // recognised the duplicate rather than losing it.
      duplicates += 1
      continue
    }
    if (taken >= room) {
      truncated = true
      break
    }
    taken += 1
    seen.add(key)
    items.push({
      text: part.text,
      uri: `${candidate.file}#${index}`,
      itemId: `${candidate.kind}|${candidate.file}|${index}`,
      title: candidate.title ?? part.title,
      tags: candidate.tags,
      kind: 'entry',
    })
    index += 1
  }
  if (read.truncated) {
    errors.push(`${candidate.file} is larger than ${options.maxBytes} bytes and was read only in part`)
    truncated = true
  }
  return { items, duplicates, skipped, errors, truncated }
}

/**
 * Scan a WorkBuddy / CodeBuddy / harness memory store.
 *
 * @param input - a project root, a memory directory, a whole `.md` file, or `~/.deepseek-harness`.
 * @param options - item, file and byte caps.
 * @returns one entry per section, per bullet, or per daily log.
 */
export const scanWorkBuddy: Scan = (input: SourceInput, options: ScanOptions): ScanResult => {
  const path = input.path
  // A path that does not exist is reported rather than scanned: silently reporting zero memories for
  // a typo is the one failure mode a user cannot debug.
  if (!isDirectory(path) && !isFile(path)) {
    return emptyScan(SOURCE, LABEL, [`${path} does not exist`])
  }
  const plan = planSources(input)
  if (plan.length === 0) {
    return emptyScan(SOURCE, LABEL, [
      `no memories under ${path} — expected .deepseek-harness/MEMORY.md, .workbuddy/memory or .codebuddy/memory`,
    ])
  }
  // A user-level scan may legitimately find both the home file and a project's; the home one is
  // first in the plan, which is the read order this source promises.
  const items: ImportItem[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  let duplicates = 0
  let skipped = 0
  let opened = 0
  let truncated = false
  for (const candidate of plan) {
    if (opened >= options.maxFiles || items.length >= options.maxItems) {
      truncated = true
      break
    }
    opened += 1
    const scan = scanFile(candidate, options, seen, Math.max(options.maxItems - items.length, 0))
    for (const item of scan.items) items.push(item)
    for (const error of scan.errors) errors.push(error)
    duplicates += scan.duplicates
    skipped += scan.skipped
    if (scan.truncated) truncated = true
  }
  // Duplicates are counted as skipped: from the user's side the file WAS recognised, and the reason
  // it produced no new memory is the only thing the report needs to explain.
  return { source: SOURCE, label: LABEL, items, files: opened, skipped: skipped + duplicates, errors, truncated }
}

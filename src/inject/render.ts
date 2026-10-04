/**
 * Text rendering for the two memory channels.
 *
 * Everything here is written for a model reading a system prompt, not for a user reading a
 * panel, which drives three choices:
 *
 *   - The scope of each entry is stated inline. A model that cannot tell a project convention
 *     from a global preference will apply it in the wrong repository.
 *   - The entry id is carried in the card, where the body is present, so a later correction can
 *     name a specific row. The index omits it: an index line already competes for a small
 *     budget and the id adds nothing until the body is in view.
 *   - Titles are shortened at a word or clause boundary, with the truncation visible. A title
 *     silently cut in half reads as a complete but oddly worded memory.
 */

import type { MemoryScope } from '../constants.js'
import type { MemoryRecord } from '../storage/repository.js'
import { clampChars } from './budget.js'

/** Short scope labels. Kept to one token each so the index stays narrow. */
export const SCOPE_LABEL: Record<MemoryScope, string> = {
  identity: '身份',
  global: '全局',
  project: '项目',
  daily: '日志',
}

/** Appended to a line whose title had to be shortened. */
export const TITLE_MARKER = '…'

/** Longest derived title before it is cut. Titles the user wrote are never cut. */
export const TITLE_MAX_CHARS = 48

/**
 * One index line's worth of a record.
 *
 * Deliberately not a `MemoryRecord`: the index is built from a store that may hold thousands of
 * rows, and carrying full bodies into the renderer is how an index quietly becomes a dump.
 */
export interface IndexEntry {
  readonly id: number
  readonly scope: MemoryScope
  readonly title: string
  readonly tags: readonly string[]
  /** The entry is a standing constraint rather than background knowledge. */
  readonly pinned?: boolean
}

/** One card, i.e. an index entry whose body has been retrieved. */
export interface CardEntry extends IndexEntry {
  readonly text: string
}

/** Header for the resident index. Names the count so the model can judge coverage. */
export function indexHeader(count: number): string {
  return `[记忆索引 · ${count} 条]`
}

/** Header for the retrieved bodies. States the ordering, which is by relevance. */
export function cardHeader(count: number): string {
  return `[相关记忆 · ${count} 条 · 按相关度]`
}

/** Header for the hard constraints. */
export function constraintHeader(count: number): string {
  return `[必须遵守的记忆约束 · ${count} 条]`
}

/**
 * The line a standing constraint carries.
 *
 * Stated as an obligation rather than as a reminder, because these entries are the ones a user
 * pinned after being ignored once.
 */
export const CONSTRAINT_PREFIX = '- 必须：'

/**
 * A leading list bullet or heading mark.
 *
 * Stripped before deriving a title so an index line reads `[项目] 用 pnpm` rather than
 * `[项目] - 用 pnpm`. The budget is why this matters: the mark is paid for on every turn the
 * entry stays in the index, and it carries no meaning the scope label has not already given.
 */
export const LEADING_MARK = /^(?:[-*•·>]+|\d+[.)、]|#{1,6})\s*/u

/** Take the first clause of a body, for use as a derived title. */
export function deriveTitle(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? ''
  const clause = firstLine.split(/[。！？!?；;]/, 1)[0] ?? firstLine
  const trimmed = clause.replace(LEADING_MARK, '').trim()
  return trimmed === '' ? text.replace(LEADING_MARK, '').trim() : trimmed
}

/** Shorten a derived title, marking the cut. A user-written title is returned unchanged. */
export function shortTitle(title: string, max = TITLE_MAX_CHARS): string {
  const text = title.trim()
  const chars = [...text]
  if (chars.length <= max) return text
  const head = chars.slice(0, max).join('')
  const lastBreak = Math.max(head.lastIndexOf(' '), head.lastIndexOf('，'))
  const cut = lastBreak > max / 2 ? head.slice(0, lastBreak) : head
  return `${cut.trimEnd()}${TITLE_MARKER}`
}

/** Title shown for a record: what the user wrote, else derived from the body. */
export function titleOf(record: Pick<MemoryRecord, 'title' | 'text'>): string {
  const written = record.title.trim()
  return written === '' ? shortTitle(deriveTitle(record.text)) : written
}

/** Turn a record into its index form, dropping the body. */
export function toIndexEntry(record: MemoryRecord): IndexEntry {
  return {
    id: record.id,
    scope: record.scope,
    title: titleOf(record),
    tags: record.tags,
    // `record.pinned` is a boolean — the repository maps the column's 0/1 — so this must test
    // for `true` rather than compare against zero. `false !== 0` is TRUE in JavaScript, and the
    // version of this line that compared against `0` marked every entry as pinned, which tells
    // the model that background knowledge is a standing rule.
    pinned: record.pinned === true,
  }
}

/** Turn a record into its card form, keeping the body. */
export function toCardEntry(record: MemoryRecord): CardEntry {
  return { ...toIndexEntry(record), text: record.text }
}

/**
 * `- [项目] 用 pnpm 而不是 npm · #42`
 *
 * The id is present for the same reason the card carries it, only more so: in the index it is the
 * ONLY way to name a specific memory without restating it, which turns "更正第 42 条" into a cheap
 * update instead of a fresh insert that leaves the old belief alive beside the new one. It costs
 * about four characters per line against a 900-character budget.
 */
export function renderIndexLine(entry: IndexEntry): string {
  const pin = entry.pinned === true ? '★' : ''
  const tags = entry.tags.length === 0 ? '' : ` #${entry.tags.slice(0, 3).join(' #')}`
  return `- ${pin}[${SCOPE_LABEL[entry.scope]}] ${entry.title}${tags} · #${entry.id}`
}

/**
 * The card block: one entry per memory, body included.
 *
 * Each entry names its own scope and id. The id is what makes the next conversational
 * correction cheap — the model can say "更正第 42 条" instead of restating the whole belief,
 * and the tool call that follows is an update rather than a fresh insert.
 */
export function renderCardLine(entry: CardEntry): string {
  const tags = entry.tags.length === 0 ? '' : ` (${entry.tags.slice(0, 4).join(', ')})`
  const body = entry.text.trim()
  return `### [${SCOPE_LABEL[entry.scope]}] ${entry.title}${tags} — #${entry.id}\n${body}`
}

/**
 * One index block.
 *
 * `excludeIds` drops entries already shown in full as cards this session. Showing a memory's
 * title in the index and its body in the card is duplication that costs budget twice and adds
 * nothing: the card is already in context and has not been evicted.
 */
export function renderIndex(
  entries: readonly IndexEntry[],
  options: { excludeIds?: ReadonlySet<number> } = {},
): string {
  const exclude = options.excludeIds ?? new Set<number>()
  const kept = entries.filter((entry) => !exclude.has(entry.id))
  if (kept.length === 0) return ''
  return [indexHeader(kept.length), ...kept.map(renderIndexLine)].join('\n')
}

/** One card block. */
export function renderCards(entries: readonly CardEntry[]): string {
  if (entries.length === 0) return ''
  return [cardHeader(entries.length), ...entries.map(renderCardLine)].join('\n\n')
}

/**
 * The hard-constraint block.
 *
 * Bodies only, no ids and no tags. This block is read before the model has decided what to do,
 * so anything that is not an instruction is a tax on the decision it exists to constrain.
 */
export function renderConstraints(entries: readonly CardEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((entry) => `${CONSTRAINT_PREFIX}${entry.text.trim()}`)
  return [constraintHeader(entries.length), ...lines].join('\n')
}

/**
 * Clamp a card body that is longer than a sane single entry.
 *
 * A memory longer than `maxChars` is almost always pasted content rather than a preference, and
 * letting one such row consume the whole card budget would leave the other relevant memories
 * out. The cut is marked, so the model knows to retrieve the rest rather than assume it has all.
 */
export function clampCardBody(entry: CardEntry, maxChars: number): CardEntry {
  const text = clampChars(entry.text.trim(), maxChars)
  return text === entry.text ? entry : { ...entry, text }
}

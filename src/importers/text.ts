/**
 * Text helpers shared by the import sources and the import runner.
 *
 * The rule these exist to enforce is that an imported entry keeps its text. `distill` is free to
 * mine sentences out of a message, but a ZCode memory or a `memories.md` section is already the
 * unit somebody chose, and re-splitting it would hand the user back fragments of their own notes.
 */

import { createHash } from 'node:crypto'

import type { SourcePlatform } from '../constants.js'
import { collapse } from '../distill/hygiene.js'
import type { ImportItem } from './types.js'

/**
 * Clean up a multi-line body without reflowing it.
 *
 * Paragraph structure is information — a note whose second paragraph is the caveat is not the same
 * note without it — so this trims each line, drops horizontal rules, and collapses runs of blank
 * lines, but never joins two lines into one.
 *
 * @param text - raw body text.
 * @returns the body, trimmed.
 */
export function normaliseBody(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n').map((line) => line.replace(/[ \t]+$/u, ''))
  const kept: string[] = []
  for (const line of lines) {
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/**
 * Take a short, single-line label from a body.
 *
 * Used when a source has no title of its own. The first line is the best guess available: it is
 * what the author wrote first, and unlike a generated template it is different for every entry —
 * which matters, because a shared prefix makes unrelated entries look like one topic to the merge
 * gate.
 *
 * @param text - body text.
 * @param max - maximum label length in code points.
 * @returns the label, or an empty string when there is nothing to take.
 */
export function headline(text: string, max = 80): string {
  const first = collapse(text.split('\n', 1)[0] ?? '').replace(/^[-*>#\s]+/u, '')
  if (first === '') return ''
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}

/**
 * Build the ledger hash for one item.
 *
 * The hash answers "has this material been through the importer before", so it must be stable
 * across re-exports of the same data: a source-supplied identity (a conversation id, a file name)
 * is used when there is one, and the text itself otherwise. The platform is part of the key so a
 * statement found in two products is recorded twice — the merge gate is what decides the two are
 * one memory, and the ledger must not pre-empt that judgement.
 *
 * @param platform - owning platform, or null for a plain file.
 * @param item - the item.
 * @returns 32 hex characters.
 */
export function itemHash(platform: SourcePlatform | null, item: ImportItem): string {
  const identity = item.itemId !== undefined && item.itemId !== '' ? item.itemId : collapse(item.text)
  return createHash('sha256').update(`${platform ?? 'file'}\u0000${identity}`, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Split a text file into paragraphs on blank lines.
 *
 * Plain Markdown and `.txt` imports use this: a blank line is the only section marker every dialect
 * agrees on, and guessing headings would merge unrelated notes.
 *
 * @param text - file text.
 * @returns non-empty paragraphs.
 */
export function paragraphs(text: string): readonly string[] {
  return text
    .split(/\n\s*\n/u)
    .map((part) => normaliseBody(part))
    .filter((part) => part !== '')
}

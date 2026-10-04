/**
 * Text hygiene for anything the user wrote.
 *
 * These three filters exist because a user message is not prose. It carries pasted source files,
 * quoted attachments and Markdown structure, and every one of those is a machine for producing
 * false memories: a pasted linter config is full of `must` and `never`, and a pasted Chinese
 * document is full of 一律 and 必须, none of which is a judgement the user made.
 *
 * Measured on real exports by the prior-art importer this was ported from: skipping the pasted
 * document was the single largest reduction in noise, and the attachment cut removed two thirds
 * of the sentences it would otherwise have stored.
 */

/** Marker claude.ai inserts before the text of an uploaded file. */
export const ATTACHMENT_MARKER = '[上传附件正文]'

/** Fenced code block, ```` ``` ````-delimited. */
const FENCED = /```[\s\S]*?```/gu

/** Inline code span. */
const INLINE = /`[^`\n]*`/gu

/**
 * Remove fenced code blocks from a message.
 *
 * A transcript of a coding session is mostly code, and a cue word inside code is a statement about
 * the language or the linter — not a preference of the person who pasted it. Removing it before
 * splitting also protects the splitter itself: a pasted TypeScript file is full of `;`, `,` and
 * `.`, every one of which is a clause delimiter here, so without this one paste becomes hundreds
 * of fragments and one of them will eventually look like a rule.
 *
 * Inline code spans are deliberately LEFT ALONE here. Users name commands in backticks — "we use
 * `pnpm`, never `npm`" — and stripping those spans would store "we use , never": a memory that is
 * not merely lossy but wrong.
 *
 * @param text - raw message text.
 * @returns the same text with fenced blocks replaced by a space.
 */
export function stripFenced(text: string): string {
  return text.replace(FENCED, ' ')
}

/**
 * Remove inline code spans as well.
 *
 * For sources that are mostly machine output, where a backticked span really is code rather than a
 * command the user is naming. The live-session path does not use this.
 *
 * @param text - text to clean.
 * @returns the text with code spans and blocks replaced by spaces.
 */
export function stripCodeSpans(text: string): string {
  return stripFenced(text).replace(INLINE, ' ')
}

/**
 * Keep only what the user typed, dropping an attached document's text.
 *
 * @param text - raw message text.
 * @returns the text before the attachment marker.
 */
export function stripAttachment(text: string): string {
  const index = text.indexOf(ATTACHMENT_MARKER)
  return index === -1 ? text : text.slice(0, index)
}

/**
 * Does this look like a pasted document rather than something the user typed?
 *
 * The test is structural, not semantic: a message where a third of the non-empty lines start with
 * list, quote, heading or table punctuation is a document somebody moved here, and its wording
 * belongs to whoever wrote the document.
 *
 * @param text - raw message text, code already removed.
 * @returns true when the whole message should be skipped.
 */
export function looksLikePaste(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 4) return false
  let structural = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^[-*>#|]/u.test(trimmed) || /^\d+[.)]/u.test(trimmed)) structural += 1
  }
  return structural / lines.length >= 0.3
}

/**
 * Squash a run of whitespace into single spaces.
 *
 * Used for comparison keys and ledger hashes, never for stored text: two entries that differ only
 * in line wrapping are the same statement, but the stored copy keeps its line breaks.
 *
 * @param text - text to collapse.
 * @returns one line.
 */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

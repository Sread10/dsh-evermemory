/**
 * `LIKE` matching, for queries the trigram tokenizer cannot see.
 *
 * `trigram` matches on three-character windows, so a one or two character fragment returns
 * zero rows with no error. This module covers that case, and only that case: measured on a
 * five-thousand-row corpus, `LIKE '%项目%'` took 1.8 ms against 0.2 ms for the equivalent
 * FTS match, so there is nothing to gain by routing longer queries here — and a full scan
 * cannot rank, while FTS can.
 *
 * `LIKE` is a full table scan with no index to use (measured: `SCAN memories`), which is
 * acceptable at a two-character query and would not be at a five-term one.
 */
import type { QueryFragment } from './tokenize.js'

/**
 * Escape character for `LIKE`.
 *
 * `!` rather than the conventional backslash, because the escape expression must be exactly
 * one character and a backslash written through a shell or a config file is the kind of value
 * that arrives doubled. `!` needs no escaping of its own in any layer this passes through.
 */
export const LIKE_ESCAPE = '!'

/** Build one `LIKE` pattern body, escaping what `LIKE` treats as a wildcard. */
export function escapeLike(text: string): string {
  return text
    .replaceAll(LIKE_ESCAPE, LIKE_ESCAPE + LIKE_ESCAPE)
    .replaceAll('%', `${LIKE_ESCAPE}%`)
    .replaceAll('_', `${LIKE_ESCAPE}_`)
}

/** Result of building a `LIKE` condition. */
export interface LikeQuery {
  /** SQL fragment with `?` placeholders, ready to be ANDed into a `WHERE`. */
  readonly condition: string
  /** Bind values, in placeholder order. */
  readonly params: readonly string[]
}

/**
 * Build a condition matching rows containing every fragment.
 *
 * Each fragment matches in either the body or the title, so a short query hits a title the
 * user remembers but never wrote in the body.
 *
 * @param fragments - fragments whose `kind` is `'like'`.
 * @returns the condition, or `undefined` when there is nothing to match.
 */
export function buildAllCondition(fragments: readonly QueryFragment[]): LikeQuery | undefined {
  const usable = fragments.filter((fragment) => fragment.kind === 'like' && fragment.text.length > 0)
  if (usable.length === 0) return undefined

  const clauses: string[] = []
  const params: string[] = []
  for (const fragment of usable) {
    const pattern = `%${escapeLike(fragment.text)}%`
    clauses.push(`(text LIKE ? ESCAPE '${LIKE_ESCAPE}' OR title LIKE ? ESCAPE '${LIKE_ESCAPE}')`)
    params.push(pattern, pattern)
  }
  return { condition: clauses.join(' AND '), params }
}

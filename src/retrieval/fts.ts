/**
 * Building the FTS5 `MATCH` argument.
 *
 * The argument is assembled here and never interpolated from user text, because passing raw
 * input to `MATCH` does not degrade — it throws, which fails the whole search rather than
 * returning fewer results. Measured against the real schema: `OR` throws
 * `fts5: syntax error near "OR"`, `*` throws `unknown special query:`, a lone `'` throws
 * `fts5: syntax error near "'"`, and `NEAR(` throws `fts5: syntax error near ""`. Those are
 * not adversarial inputs; "记住 OR 的用法" is an ordinary thing for a user to write.
 *
 * Quoting each fragment (doubling any internal quote, which FTS5 reads as an escaped quote)
 * makes every one of the above a literal phrase search. Measured that quoting does NOT change
 * the combinator: `MATCH '"cache" "policy"'` and `MATCH '"cache" OR "policy"'` behave as
 * documented, so adjacent quoted fragments keep implicit AND semantics.
 */
import type { QueryFragment } from './tokenize.js'

/** Result of building one FTS query. */
export interface FtsQuery {
  /** The argument to bind to `MATCH`. */
  readonly match: string
  /** Fragments that went into it, in source order. */
  readonly fragments: readonly string[]
}

/**
 * Quote one fragment as an FTS5 phrase.
 *
 * @param fragment - text with no surrounding punctuation.
 * @returns the fragment inside double quotes, with internal quotes doubled.
 */
export function quoteFtsFragment(fragment: string): string {
  return `"${fragment.replaceAll('"', '""')}"`
}

/**
 * Build the `MATCH` argument for a set of fragments.
 *
 * Adjacent quoted fragments are an implicit AND, which is what a user typing several words
 * expects. When that returns nothing the caller retries with {@link buildAnyQuery}, because
 * an AND that is too strict is indistinguishable from no match at all — and the store is
 * consulted precisely when the user believes a memory exists.
 *
 * @param fragments - fragments whose `kind` is `'fts'`.
 * @returns the query, or `undefined` when no fragment clears the trigram floor.
 */
export function buildAllQuery(fragments: readonly QueryFragment[]): FtsQuery | undefined {
  return build(fragments, 'AND')
}

/**
 * Build a `MATCH` argument with explicit `OR` between fragments.
 *
 * @param fragments - fragments whose `kind` is `'fts'`.
 * @returns the query, or `undefined` when no fragment clears the trigram floor.
 */
export function buildAnyQuery(fragments: readonly QueryFragment[]): FtsQuery | undefined {
  return build(fragments, 'OR')
}

/**
 * Shared builder for both combinators.
 *
 * @param fragments - candidate fragments.
 * @param combinator - `'AND'` or `'OR'`; the former is the implicit default and is omitted.
 * @returns the query, or `undefined` when nothing is usable.
 */
function build(fragments: readonly QueryFragment[], combinator: 'AND' | 'OR'): FtsQuery | undefined {
  const usable = fragments.filter((fragment) => fragment.kind === 'fts' && fragment.text.length > 0)
  if (usable.length === 0) return undefined
  const parts = usable.map((fragment) => quoteFtsFragment(fragment.text))
  return {
    match: parts.join(combinator === 'AND' ? ' ' : ' OR '),
    fragments: usable.map((fragment) => fragment.text),
  }
}

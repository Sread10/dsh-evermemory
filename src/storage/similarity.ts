/**
 * Text comparison for the merge decision.
 *
 * Every function here is pure and synchronous, and none of them calls a model. That is the
 * point: distillation is required to cost zero LLM calls, so the merge decision has to be
 * made from the text itself.
 *
 * The measure is character-bigram overlap rather than word overlap, because half the corpus
 * is Chinese and word segmentation would need a dictionary this plugin deliberately does not
 * ship. Bigrams need nothing and behave the same on both scripts — the same reasoning that
 * put the search index on `trigram`.
 */

/**
 * Fold text into a comparable form.
 *
 * Case and whitespace are presentation; punctuation is removed because a sentence rewritten
 * with different commas is the same memory. Full-width forms are folded to half-width so
 * that a Chinese full stop does not make two otherwise identical strings differ.
 *
 * @param text - raw text.
 * @returns the normalised form, possibly empty.
 */
export function normalizeForCompare(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    // Keep letters, digits and CJK; drop everything else. `\p{Script=Han}` is used rather
    // than a CJK range so the property is stated once instead of as four magic offsets.
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, '')
}

/**
 * Character bigrams of a normalised string.
 *
 * A single-character string yields one unigram so that very short text still compares;
 * otherwise a one-word memory would score zero against everything, including itself.
 *
 * @param normalized - output of {@link normalizeForCompare}.
 * @returns the distinct bigrams.
 */
export function bigrams(normalized: string): Set<string> {
  const out = new Set<string>()
  if (normalized.length === 0) return out
  if (normalized.length === 1) {
    out.add(normalized)
    return out
  }
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    out.add(normalized.slice(index, index + 2))
  }
  return out
}

/**
 * Jaccard similarity of two strings, on character bigrams.
 *
 * @param a - first text.
 * @param b - second text.
 * @returns a score in `[0, 1]`, where 1 means the two fold to the same bigram set.
 */
export function similarity(a: string, b: string): number {
  const left = bigrams(normalizeForCompare(a))
  const right = bigrams(normalizeForCompare(b))
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * How much of `needle` is present in `haystack`, ignoring what else `haystack` says.
 *
 * Jaccard punishes a short new fact that restates a long existing entry, which is exactly
 * the shape of most real duplicates ("prefers pnpm" arriving again as "prefers pnpm, and
 * dislikes npm workspaces"). Containment catches that where Jaccard will not.
 *
 * @param needle - the shorter text, typically the candidate.
 * @param haystack - the longer text, typically the stored entry.
 * @returns the fraction of `needle`'s bigrams found in `haystack`.
 */
export function containment(needle: string, haystack: string): number {
  const small = bigrams(normalizeForCompare(needle))
  const large = bigrams(normalizeForCompare(haystack))
  if (small.size === 0) return 0
  let shared = 0
  for (const gram of small) if (large.has(gram)) shared += 1
  return shared / small.size
}

/**
 * Terms whose presence inverts the meaning of a statement.
 *
 * Used only to flag a possible conflict for the user, never to decide one automatically.
 * Which of two contradicting memories is correct is not something a rule can know.
 *
 * Order matters: the multi-character forms are listed before their prefixes so that a
 * message can name the one it matched.
 */
export const NEGATIONS = ['不需要', '不要', '不用', '禁止', '避免', '别', '不', 'never', 'avoid', "don't", 'do not', 'not', 'no'] as const

/**
 * A statement reduced to what a rule can compare.
 *
 * Polarity and subject are separated because they answer different questions. Two texts with
 * the same polarity are a restatement; two with opposite polarity and the same subject are a
 * contradiction. Raw string similarity cannot tell those apart — measured on
 * "这个项目用 pnpm" against "这个项目不要用 pnpm，改用 npm", it reports 0.5, which is high
 * enough that a similarity-first rule absorbs a correction as a restatement and leaves the
 * superseded belief in place.
 */
export interface Statement {
  /** `true` when the text denies rather than asserts. */
  readonly negative: boolean
  /** The negation that was found, when there is one. */
  readonly marker: string | undefined
  /** Text with the negation removed, so the subject can be compared. */
  readonly affirmative: string
}

/**
 * Split a text into polarity and subject.
 *
 * @param text - raw text.
 * @returns the statement.
 */
export function readStatement(text: string): Statement {
  const lowered = text.normalize('NFKC').toLowerCase()
  const marker = NEGATIONS.find((word) => lowered.includes(word))
  return {
    negative: marker !== undefined,
    marker,
    // Every negation is stripped, not just the one that matched, so that "do not use X, no
    // exceptions" reduces to the same subject as "do not use X".
    affirmative: NEGATIONS.reduce((acc, word) => acc.split(word).join(''), lowered).replace(/\s+/g, ''),
  }
}

/**
 * Extract the words a statement asserts something about, for conflict comparison.
 *
 * @param text - raw text.
 * @returns the normalised token list with negations and stop words removed.
 */
export function contentTerms(text: string): string[] {
  const tokens = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{Script=Han}]+/u)
    .filter((token) => token !== '')
  const stop = new Set<string>(NEGATIONS)
  return tokens.filter((token) => !stop.has(token))
}

/**
 * Decide whether two texts look like they contradict each other.
 *
 * Reports a conflict, not a winner. The condition is deliberately narrow — opposite
 * polarity and a subject that survives the negation being removed — because a false positive
 * costs the user one confirmation prompt, while a false negative silently leaves two
 * contradicting memories in the store and the agent free to repeat the retired one.
 *
 * @param a - one text.
 * @param b - the other text.
 * @returns `true` when exactly one is negated and they are about the same thing.
 */
export function contradict(a: string, b: string): boolean {
  const left = readStatement(a)
  const right = readStatement(b)
  if (left.negative === right.negative) return false

  // Compare the subjects with the negations stripped. The earlier token-based version split
  // Chinese into runs with no spaces, so "这个项目不要用" and "这个项目用" shared no token
  // and the contradiction was missed entirely — the rule has to work on a script that does
  // not delimit words.
  const shorter = left.affirmative.length <= right.affirmative.length ? left.affirmative : right.affirmative
  const longer = shorter === left.affirmative ? right.affirmative : left.affirmative
  if (shorter.length === 0) return false
  if (longer.includes(shorter)) return true

  // Otherwise fall back to overlap, so that a rewording is still caught.
  const shared = containment(shorter, longer)
  return shared >= 0.6
}

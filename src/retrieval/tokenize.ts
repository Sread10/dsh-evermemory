/**
 * Query tokenization for retrieval.
 *
 * This module exists because of one measured property of SQLite's FTS5 `trigram` tokenizer:
 * it matches on three-character windows, and below three characters it returns nothing
 * *silently* — no error, no warning, just an empty result set. Measured against the real
 * schema: `"缓存"` → 0 rows, `"项目约定"` → 1 row, `"cache"` → 1 row.
 *
 * The consequence is that the routing decision cannot be "does the query contain CJK". It has
 * to be "how many characters does this fragment have", because Latin text hits the same floor.
 * That is also why adjacent CJK runs are fused before the length test: `项目 约定` is two
 * two-character fragments that would both miss, while `项目约定` is a four-character fragment
 * that hits. Latin words are never fused, because merging them would quietly AND unrelated
 * search terms into one phrase.
 *
 * Fusion has a second edge, and it is the one that matters for a whole sentence. A fragment is
 * matched as a PHRASE, so it only finds text that contains it verbatim — and Chinese is written
 * without spaces, so a user's question arrives as one long run. Measured against a store holding
 * `构建缓存\\n缓存放在 .cache 目录，CI 上要清空` and two similar entries: `装依赖该用哪个包管理器`,
 * `这个项目的缓存策略是什么`, `构建缓存应该怎么处理` and `提交前要不要跑测试` each matched
 * nothing, while every query carrying a Latin term (`pnpm 和 npm 该用哪个`, `CI 上要清空缓存吗？`)
 * matched — the Latin term is a second fragment, and the OR retry then has something to work with.
 * So a CJK run longer than a term is cut into overlapping {@link TRIGRAM_MIN_CHARS}-character
 * windows instead. Each window is short enough to appear inside a memory that is about the
 * subject, the AND query over all of them still means "this whole run", and the OR retry degrades
 * by how much of the run matched rather than to nothing.
 */

/** How a fragment will be matched. */
export type FragmentKind = 'fts' | 'like'

/** One searchable fragment of a user query. */
export interface QueryFragment {
  /** The fragment as it should be matched, stripped of surrounding noise. */
  readonly text: string
  /** `'fts'` when long enough for trigram, `'like'` when below the floor. */
  readonly kind: FragmentKind
  /** `true` when the user quoted the fragment, which raises its weight. */
  readonly quoted: boolean
}

/**
 * Minimum fragment length the trigram tokenizer can match.
 *
 * Measured, not assumed: one and two character queries return zero rows for CJK and for
 * Latin alike, so both fall through to `LIKE`.
 */
export const TRIGRAM_MIN_CHARS = 3

/** Longest fragment kept, to bound the work a single pathological query can cause. */
export const MAX_FRAGMENT_CHARS = 64

/** Most fragments honoured, for the same reason. */
export const MAX_FRAGMENTS = 8

/**
 * Longest CJK run searched as one phrase.
 *
 * A Chinese term is a handful of characters, so a run no longer than this is a term and is
 * searched verbatim — `项目约定` stays one fragment, as the tests pin. Longer is a sentence.
 */
export const CJK_TERM_CHARS = 4

/** Leading and trailing punctuation stripped from a fragment. */
const TRIM_CHARS = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu

/** Whether one code point is a word character, by Unicode property. */
function isWordChar(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character)
}

/** Whether one code point belongs to Han, Hiragana, Katakana or Hangul. */
function isCjkChar(character: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
}

/**
 * Split a query into runs of word characters, obeying double quotes.
 *
 * @param query - raw user text.
 * @returns each run with its quoted flag, in source order.
 */
function splitRuns(query: string): { text: string, quoted: boolean }[] {
  const runs: { text: string, quoted: boolean }[] = []
  let current = ''
  let quoted = false
  let inQuotes = false

  for (const character of query.normalize('NFKC')) {
    if (character === '"') {
      if (current.length > 0) runs.push({ text: current, quoted })
      current = ''
      inQuotes = !inQuotes
      quoted = inQuotes
      continue
    }
    if (isWordChar(character)) {
      current += character
      continue
    }
    if (current.length > 0) runs.push({ text: current, quoted })
    current = ''
    quoted = inQuotes
  }
  if (current.length > 0) runs.push({ text: current, quoted })
  return runs
}

/**
 * Fuse neighbouring CJK runs, and nothing else.
 *
 * Whispace and punctuation between two CJK runs are dropped rather than treated as a
 * separator: a Chinese query is as likely to be typed with spaces as without, and the
 * fragment has to clear the three-character floor either way. Latin neighbours stay apart so
 * that `pnpm cache` remains two search terms instead of one unmatchable phrase.
 *
 * @param runs - runs from {@link splitRuns}.
 * @returns the fused fragments.
 */
function fuseCjkRuns(runs: readonly { text: string, quoted: boolean }[]): { text: string, quoted: boolean }[] {
  const fused: { text: string, quoted: boolean }[] = []
  for (const run of runs) {
    const previous = fused.at(-1)
    const bothCjk = previous !== undefined
      && [...previous.text].every(isCjkChar)
      && [...run.text].every(isCjkChar)
    if (bothCjk) {
      fused[fused.length - 1] = { text: previous.text + run.text, quoted: previous.quoted || run.quoted }
    } else {
      fused.push({ ...run })
    }
  }
  return fused
}

/**
 * Cut an unquoted CJK run into searchable windows.
 *
 * A run at or below {@link CJK_TERM_CHARS} is already a term and is returned as it stands. A
 * longer one is every overlapping window of {@link TRIGRAM_MIN_CHARS} characters, in order — the
 * smallest unit the tokenizer can match at all, because there is no way to know which stretch of
 * a Chinese sentence is the searchable term without a segmenter this project does not have.
 *
 * Losing that information is affordable here because the retriever tries the AND form first and
 * only falls back to OR when nothing at all matched: a store that knows the subject still answers
 * exactly, and a store that knows only part of the question answers with that part instead of
 * with nothing. Ranking then prefers the row that satisfied more of the windows.
 *
 * @param text - one fused run.
 * @returns the fragments to search for.
 */
function cjkWindows(text: string): string[] {
  const characters = [...text]
  if (characters.length <= CJK_TERM_CHARS) return [text]
  const windows: string[] = []
  for (let start = 0; start + TRIGRAM_MIN_CHARS <= characters.length; start += 1) {
    windows.push(characters.slice(start, start + TRIGRAM_MIN_CHARS).join(''))
  }
  return windows
}

/**
 * Turn a user query into fragments with a decided match strategy each.
 *
 * @param query - raw user text, from a tool argument or a session message.
 * @returns fragments in source order, deduplicated, each capped to {@link MAX_FRAGMENT_CHARS}.
 */
export function tokenize(query: string): QueryFragment[] {
  const seen = new Set<string>()
  const fragments: QueryFragment[] = []

  for (const run of fuseCjkRuns(splitRuns(query))) {
    const text = run.text.replace(TRIM_CHARS, '').slice(0, MAX_FRAGMENT_CHARS)
    if (text.length === 0) continue
    // A quoted run is the user asking for that exact phrase, so it is never cut up. Everything
    // else that is CJK and longer than a term is a sentence, and a phrase query cannot match one.
    const searchable = run.quoted || ![...text].every(isCjkChar) ? [text] : cjkWindows(text)
    for (const fragmentText of searchable) {
      const key = fragmentText.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      fragments.push({
        text: fragmentText,
        kind: [...fragmentText].length >= TRIGRAM_MIN_CHARS ? 'fts' : 'like',
        quoted: run.quoted,
      })
      if (fragments.length >= MAX_FRAGMENTS) return fragments
    }
  }

  return fragments
}

/**
 * The fragments FTS can be asked about.
 *
 * @param fragments - output of {@link tokenize}.
 * @returns the subset whose length clears the trigram floor.
 */
export function ftsFragments(fragments: readonly QueryFragment[]): QueryFragment[] {
  return fragments.filter((fragment) => fragment.kind === 'fts')
}

/**
 * The fragments that must go through `LIKE`.
 *
 * @param fragments - output of {@link tokenize}.
 * @returns the subset below the trigram floor.
 */
export function likeFragments(fragments: readonly QueryFragment[]): QueryFragment[] {
  return fragments.filter((fragment) => fragment.kind === 'like')
}

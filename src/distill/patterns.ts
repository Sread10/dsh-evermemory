/**
 * Zero-LLM distillation: the pattern vocabulary.
 *
 * Constraint #8 says distillation runs without an LLM call, and constraint #1 says the
 * per-turn budget must not grow with the memory store. Together they force a rule pipeline:
 * deterministic patterns decide what is worth remembering, and the store grows at session
 * boundaries rather than per turn.
 *
 * Every pattern here is a *cue*, not a classifier. A cue only proposes a candidate; the
 * quality gate in `judge.ts` rejects the ones that are not self-contained, and the merge in
 * `storage/merge.ts` decides whether it is new knowledge. Keeping the three stages separate
 * is what makes each one testable on its own — a single "is this a memory" regex would be
 * untestable and would fail silently in both directions.
 */

/** What a cue tells us about a candidate. Determines its scope ceiling and importance floor. */
export type CueKind =
  | 'preference'    // "I prefer X", "always do Y"
  | 'prohibition'   // "never do Y", "don't use X"
  | 'correction'    // "no, it's X not Y" — usually becomes an UPDATE of an existing memory
  | 'identity'      // who the user is, how to address them
  | 'agreement'     // a conclusion the user settled on — often a project decision
  | 'fact'          // durable background the user volunteered

export interface Cue {
  readonly kind: CueKind
  /** Matched text, trimmed of surrounding punctuation. */
  readonly text: string
  /** The phrase that matched, for diagnostics and for tests to assert against. */
  readonly marker: string
}

/**
 * A cue pattern.
 *
 * `capture` names the group holding the memory text. `whole` keeps the entire match instead,
 * which is right when the marker is part of the meaning ("不要用 X" reads correctly as a
 * prohibition, while stripping the marker to "X" turns it into a preference for X).
 *
 * A `whole` pattern must therefore match to the END of the clause (`.*$`), not just the
 * marker. Matching only the marker captures the marker — "不要" instead of "不要用 npm" —
 * and the quality gate then rejects the two-character fragment as too short, so the sentence
 * is discarded rather than mis-stored. That failure is quiet: the store simply never learns
 * what the user forbade.
 */
export interface CuePattern {
  readonly kind: CueKind
  readonly re: RegExp
  readonly capture?: number
  readonly whole?: true
}

/**
 * Marker phrases, Chinese first.
 *
 * Order matters within `CUE_PATTERNS`: the first match wins, so the more specific and the
 * more consequential kinds are listed before the general ones. A sentence containing both
 * "记住" and "不要" is a prohibition, and reading it as a generic fact would store the wrong
 * half of it.
 */
const ZH_PREFERENCE = [
  '我(?:更)?(?:喜欢|偏好|倾向于|习惯)',
  '我(?:希望|想要|要求)',
  // The marker groups are greedy, not optional. With `都` optional the engine prefers to match
  // zero characters and lets the capture group take the rest, so "以后都用中文回答" captures
  // "用中文回答" — the standing-rule qualifier lands in the marker and is thrown away.
  '以后(?:都|请|要)',
  '接下来(?:都|请)',
  '默认(?:用|走|是)',
  '请(?:你)?(?:都|始终|一直)',
  '(?:都|统一|一律)(?:用|走|采用)',
  '尽量',
]

/**
 * A bare `用 X` / `走 X` directive, anchored to the start of the clause.
 *
 * Chinese marks a standing instruction with a verb and nothing else: "用 pnpm" is a policy,
 * not a description. Without this pattern a store accumulates prohibitions and forgets every
 * positive decision, which biases retrieval toward "don't" and away from "do".
 *
 * The anchor is what keeps the rule honest. Unanchored, the bare verb matches mid-sentence and
 * hijacks sentences that merely CONTAIN it — "我们这个项目目前用 pnpm" is a statement of fact
 * about the project, and capturing it as the directive "用 pnpm" would file a description in
 * the rules layer and score it as an instruction.
 *
 * The leading groups are deliberate too: cutting from the bare verb would turn "都用中文" into
 * "用中文". They read the same to a human but differ in force, and importance scoring exists to
 * preserve exactly that difference.
 *
 * The body is captured rather than kept whole: the bare verb is grammar, not content, and a
 * memory reading "用 pnpm" next to a dozen sibling preferences reads as a fragment.
 */
const ZH_DIRECTIVE = ['^(?:以后|接下来|今后|后续)?(?:都|统一|一律|尽量|默认)?(?:用|走|采用|使用)(.*)$']
const ZH_PROHIBITION = [
  '不要',
  '不需要',
  '不用',
  '别(?:再|去|要)?',
  '禁止',
  '避免',
  '不准',
  '不许',
  '千万不',
]

const ZH_CORRECTION = [
  '更正',
  '修正',
  '不是.{0,20}?而是',
  '不是.{0,20}?是',
  '搞错',
  '说错',
  '记错',
  '应该是',
]

/**
 * Correction words that are only an announcement, with the actual correction still to come.
 *
 * "更正一下，是 pnpm 不是 npm" splits at the comma, so the first clause is the word "更正一下"
 * and the substance is in the second. Stored on its own it is a memory that corrects nothing
 * and says nothing — strictly worse than no memory, because it occupies budget and reads like
 * a fact. The extractor uses this list to carry the neighbouring clause along.
 */
export const CORRECTION_LEAD_IN = /^(?:更正|修正|改(?:一下|正)?|勘误|纠正)(?:一下|下|一点|个)?$/u

const ZH_IDENTITY = [
  '我是',
  '我叫',
  '我的名字',
  '称呼我',
  '叫我',
  '我(?:的)?职业',
  '我(?:的)?身份',
  '我(?:的)?角色',
]

const ZH_AGREEMENT = [
  '就(?:这么|这样|按这个)',
  '确定(?:用|走|采用)',
  '决定(?:用|走|采用)',
  '选定',
  '敲定',
  '最终(?:选|用|决定)',
  '同意',
  '可以就这样',
]

const ZH_REMEMBER = ['记住', '记一下', '记下来', '帮我记', '收录', '备查']

const ZH_FACT = [
  '我们的?项目',
  '我们(?:团队|公司|组)',
  '我(?:们)?(?:用的?|使用的?)(?:是|技术栈)',
  '现状(?:是|为)',
  '目前(?:用|是)',
  '背景(?:是|为)',
]

/**
 * A fact's cue plus the statement it introduces.
 *
 * Facts are `whole`-captured, which is right for the short markers above ("现状是 X") but wrong
 * for the sentence-initial ones: "我们这个项目目前用 pnpm" would be stored in full, pronoun and
 * all. Kept as a capture pattern so the stored text starts at the statement rather than at the
 * user.
 */
const ZH_FACT_CAPTURE = ['(?:我们这个?项目|我们(?:团队|公司|组)|这个?项目|本?项目)(.*)$']

const ZH_SESSION_RECALL = [
  '我之前(?:说过|提过|讲过)',
  '我上次(?:说过|提过)',
  '你(?:还)?记得',
  '还记得吗',
]

const EN_PREFERENCE = [
  String.raw`\bi (?:prefer|like|want|need|would rather)\b`,
  String.raw`\balways\b`,
  String.raw`\bplease (?:always|use|prefer)\b`,
  String.raw`\bfrom now on\b`,
  String.raw`\bgoing forward\b`,
  String.raw`\bdefault to\b`,
  String.raw`\bwhenever\b`,
  String.raw`\btry to\b`,
]

const EN_PROHIBITION = [
  String.raw`\bnever\b`,
  String.raw`\bdon'?t\b`,
  String.raw`\bdo not\b`,
  String.raw`\bavoid\b`,
  String.raw`\bno need to\b`,
  String.raw`\bplease don'?t\b`,
]

/** The English counterpart of `ZH_DIRECTIVE`: an imperative standing policy. */
const EN_DIRECTIVE = [String.raw`\buse\b`]

const EN_CORRECTION = [
  String.raw`\bactually\b`,
  String.raw`\bcorrection\b`,
  String.raw`\bnot\b.{0,30}?\bbut\b`,
  String.raw`\bi (?:meant|said)\b`,
  String.raw`\bthat'?s wrong\b`,
  String.raw`\bupdate that\b`,
]

const EN_IDENTITY = [
  String.raw`\bmy name is\b`,
  String.raw`\bi am a\b`,
  String.raw`\bi'?m a\b`,
  String.raw`\bcall me\b`,
  String.raw`\bmy role\b`,
  String.raw`\bi work (?:as|on)\b`,
]

const EN_AGREEMENT = [
  String.raw`\blet'?s go with\b`,
  String.raw`\bwe'?ll use\b`,
  String.raw`\bdecided (?:on|to use)\b`,
  String.raw`\bsettled on\b`,
  String.raw`\bagreed\b`,
  String.raw`\bfinal answer\b`,
]

const EN_REMEMBER = [
  String.raw`\bremember (?:that|this)\b`,
  String.raw`\bnote that\b`,
  String.raw`\bkeep in mind\b`,
  String.raw`\bmake a note\b`,
  String.raw`\bfor the record\b`,
]

const EN_FACT = [
  String.raw`\bour project\b`,
  String.raw`\bour team\b`,
  String.raw`\bour stack\b`,
  String.raw`\bwe use\b`,
  String.raw`\bcurrently we\b`,
]

const EN_SESSION_RECALL = [
  String.raw`\bi (?:mentioned|said|told you)\b`,
  String.raw`\bdo you remember\b`,
  String.raw`\bas i said\b`,
]

/** Joins alternatives into one non-capturing group. */
function any(...alternatives: readonly string[]): string {
  return `(?:${alternatives.join('|')})`
}

const ZH_ANY = (parts: readonly string[]): string => any(...parts)
const EN_ANY = (parts: readonly string[]): string => any(...parts)

/**
 * Builds a cue pattern, extending a `whole` pattern to the end of the clause.
 *
 * The extension is not decoration. `whole` means "keep the marker, it is part of the meaning",
 * and a pattern that matches only the marker keeps only the marker — "不要" rather than
 * "不要用 npm". The result is not a wrong memory but a DISCARDED one: the quality gate sees a
 * two-character fragment and rejects it as too short, so the rule the user stated is never
 * learned and nothing in the log distinguishes that from the user having said nothing.
 */
function cue(kind: CueKind, source: string, flags: string, whole?: true, capture?: number): CuePattern {
  const body = whole === true ? `${source}.*$` : source
  return {
    kind,
    re: new RegExp(body, flags),
    ...(whole === true ? { whole } : {}),
    ...(capture === undefined ? {} : { capture }),
  }
}

/**
 * The pattern list, most consequential first.
 *
 * `whole: true` on prohibitions and corrections is deliberate. "不要用 npm" stored as "npm"
 * inverts the user's meaning, which is worse than storing nothing at all — and a memory store
 * that occasionally records the opposite of what was said is worse than no memory store.
 */
export const CUE_PATTERNS: readonly CuePattern[] = [
  // Corrections first: they must reach the merge as UPDATE proposals rather than as fresh
  // statements, because a correction merged as a new fact leaves the corrected fact alive.
  cue('correction', ZH_ANY(ZH_CORRECTION), 'u', true),
  cue('correction', EN_ANY(EN_CORRECTION), 'iu', true),

  // Prohibitions before preferences: "以后不要用 X" contains both markers.
  cue('prohibition', ZH_ANY(ZH_PROHIBITION), 'u', true),
  cue('prohibition', EN_ANY(EN_PROHIBITION), 'iu', true),

  cue('identity', ZH_ANY(ZH_IDENTITY), 'u', true),
  cue('identity', EN_ANY(EN_IDENTITY), 'iu', true),

  cue('preference', `(?:${ZH_ANY(ZH_REMEMBER)}|${ZH_ANY(ZH_PREFERENCE)})(.*)$`, 'u', undefined, 1),
  cue('preference', `(?:${EN_ANY(EN_REMEMBER)}|${EN_ANY(EN_PREFERENCE)})(.*)$`, 'iu', undefined, 1),

  // After the markers and before the fact patterns: "这个项目用 pnpm" is both fact-shaped and
  // directive-shaped, and the directive is the actionable half.
  cue('preference', ZH_ANY(ZH_DIRECTIVE), 'u', undefined, 1),
  cue('preference', EN_ANY(EN_DIRECTIVE), 'iu', true),

  cue('agreement', ZH_ANY(ZH_AGREEMENT), 'u', true),
  cue('agreement', EN_ANY(EN_AGREEMENT), 'iu', true),

  // A project-shaped subject introduces a fact, so the subject is stripped and the statement
  // after it is what gets stored. Listed before the shorter fact markers, which match mid-clause.
  cue('fact', ZH_ANY(ZH_FACT_CAPTURE), 'u', undefined, 1),
  cue('fact', ZH_ANY(ZH_FACT), 'u', true),
  cue('fact', EN_ANY(EN_FACT), 'iu', true),
]

/**
 * Phrases that mark a question about existing memory rather than a statement to store.
 *
 * "你还记得我说过什么吗" contains an identity-shaped opening and a factual-sounding body, so
 * without this list it distils into a memory of the user asking a question. The failure is
 * quiet and cumulative: every recall question deposits a useless entry.
 */
export const SESSION_RECALL_PATTERNS: readonly RegExp[] = [
  new RegExp(ZH_ANY(ZH_SESSION_RECALL), 'u'),
  new RegExp(EN_ANY(EN_SESSION_RECALL), 'iu'),
]

/**
 * Phrases that mark a statement as being about this conversation only.
 *
 * These must not reach the global or project layer. "对于这次改动" is a real instruction with
 * no cross-session value, and storing it produces a memory that is wrong the next time the
 * user asks for the same change.
 */
export const SESSION_SCOPED_PATTERNS: readonly RegExp[] = [
  /(?:这次|本次|这一次|当前这|这一轮|这个?(?:会话|对话|任务|改动|需求|文件|函数|报错|bug))/iu,
  /\b(?:this (?:time|session|task|change|file|function|error|bug|request)|for now|right now|in this (?:case|instance))\b/iu,
]

/**
 * Phrases that make a statement vague enough to be useless out of context.
 *
 * A memory is read back without the conversation that produced it, so "按之前说的那样" is not
 * a memory — it is a pointer to context that will not exist. The gate in `judge.ts` uses this
 * list to reject such candidates rather than to score them lower, because a low-scoring vague
 * memory still occupies budget on every turn it is retrieved.
 */
export const VAGUE_PATTERNS: readonly RegExp[] = [
  // Anchored at BOTH ends, which is not cosmetic: an unanchored `^(?:that|this|…)` rejected
  // "this project builds with pnpm, never npm" — the sentence simply opens with "this" — and that
  // is exactly the kind of statement the store exists for. A longer sentence that merely OPENS
  // with a pointer has content of its own; rejecting it costs the user a memory they asked to
  // keep, while accepting a pointer inside a longer sentence costs one slot in a pruned layer.
  /^(?:那样|这样|照旧|老样子|同上|如上|跟之前一样|一如既?往|按照?之前(?:说|提|讲)?的?(?:那样|那个|那些)?)[。.!！]?$/u,
  /^(?:之前(?:说|提|讲)的?(?:那样|那个|那些)|上次(?:说|提)的?)[。.!！]?$/u,
  /^(?:that|this|the same|as before|like before|same as (?:before|last time)|the usual|same thing|as discussed|as (?:we|i) discussed)\s*[.!]?$/iu,
]

/** Hedges that indicate the user is thinking aloud rather than stating something durable. */
export const HEDGE_PATTERNS: readonly RegExp[] = [
  /(?:可能|也许|大概|或许|说不定|我猜|应该是吧|不确定)/u,
  /\b(?:maybe|perhaps|probably|i guess|not sure|might be|i think)\b/iu,
]

/** Interrogative endings. A question is not a statement, even when it contains a cue. */
export const QUESTION_PATTERNS: readonly RegExp[] = [
  /[?？]\s*$/u,
  /(?:吗|呢|吧)\s*[?？]?\s*$/u,
  /^(?:什么|怎么|如何|为什么|哪里|哪个|谁|何时|是否)/u,
  /^(?:what|how|why|where|which|who|when|is |are |should |could |would )/iu,
]

/**
 * Splits a message into clause-like units before matching, discarding the delimiters.
 *
 * Matching against a whole message makes the captured text depend on message length: one
 * preference in a five-paragraph message would capture all five paragraphs. Splitting first
 * keeps a candidate to the clause that carries the cue.
 *
 * Three details are load-bearing, and getting any of them wrong loses candidates silently:
 *
 * - Commas and semicolons are delimiters, not just sentence endings. "不要用 npm，改用 pnpm"
 *   is two instructions; treating it as one clause makes the prohibition swallow the
 *   replacement and the stored rule is wrong in both halves.
 * - The delimiter is CONSUMED rather than kept by a lookbehind. A lookbehind leaves the
 *   trailing whitespace attached to the following clause ("one. two!" never splits at all,
 *   because the boundary sits before a space).
 * - A fragment that is nothing but delimiters is dropped. "。\n\n。b" would otherwise yield a
 *   bare "。" clause, and every pattern downstream has to defend against matching it.
 *
 * - Leading list markers are stripped for the same reason: "- 用 pnpm" and "1. 用 pnpm" are
 *   instructions, and a marker left in the text ends up inside the stored memory.
 */
const LIST_MARKER = /^(?:[-*•·>]|\d+[.)、])\s+/u

/**
 * The delimiter run. Consumed, never kept.
 *
 * The plain period is in the FIRST alternative, not a later one, and that placement is the whole
 * point. "1. use pnpm" splits on the period and its trailing whitespace; the marker stripper then
 * removes the "1. " from the front of the result and leaves a bare "1" behind — a fragment that
 * is nothing but a list number and that no downstream filter can reject without also rejecting a
 * real one-word memory. Only when the period is IN the delimiter run, so it takes the newline with
 * it, does the whole marker disappear. Same trap as the newline above.
 */
const CLAUSE_DELIMITER = /[。！？!?；;，,、.]+[\s]*|\n+/u

export function splitSentences(message: string): string[] {
  return message
    .split(CLAUSE_DELIMITER)
    .map((part) => part.replace(LIST_MARKER, '').trim())
    .filter((part) => /[\p{L}\p{N}]/u.test(part))
    .filter((part) => !/^\d+$/u.test(part))
}

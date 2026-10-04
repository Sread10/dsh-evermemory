/**
 * Zero-LLM distillation: the quality gate and the scope decision.
 *
 * The gate answers one question — would NOT remembering this cause the model to decide
 * wrongly? — and it answers it with rules rather than a model call, per constraint #8.
 *
 * The gate is deliberately allowed to reject. A memory store's failure mode is not forgetting;
 * it is remembering a hundred things that were never true, each of which then costs budget on
 * every turn it is retrieved and misleads the model on the turn it matters. Rejecting a real
 * preference costs the user one repetition. Storing a fabricated one costs them a wrong answer
 * they have no reason to suspect.
 */

import type { Cue, CueKind } from './patterns.js'
import {
  HEDGE_PATTERNS,
  QUESTION_PATTERNS,
  SESSION_RECALL_PATTERNS,
  SESSION_SCOPED_PATTERNS,
  VAGUE_PATTERNS,
} from './patterns.js'
import { MEMORY_SCOPES, type MemoryScope } from '../constants.js'

/** Why a candidate was rejected. Kept as a value so tests can assert the specific reason. */
export type RejectReason =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'vague'
  | 'question'
  | 'hedged'
  | 'session-recall'
  | 'session-scoped'
  | 'no-content-after-marker'

export interface Judgement {
  readonly accepted: boolean
  readonly reason?: RejectReason
  /** 0-10. Only meaningful when accepted. */
  readonly importance: number
  readonly scope: MemoryScope
}

/** Shortest candidate worth storing, in characters. Below this there is no content to store. */
export const MIN_CHARS = 4

/**
 * Longest candidate worth storing.
 *
 * The store's `maxMemoryChars` deployment limit is the real ceiling; this is the point at
 * which a single cue-bearing sentence has stopped being a memory and become a document.
 * Long-form knowledge belongs in a skill or a file, with a short memory pointing at it —
 * the practice `dsh-destinywind-memory` states as "长知识写成技能，记忆里只留一句索引".
 */
export const MAX_CHARS = 500

/**
 * Base importance by cue kind.
 *
 * Prohibitions outrank preferences because a violated prohibition produces a confident wrong
 * answer, while a forgotten preference produces a merely unhelpful one. A correction outranks
 * both because it means an existing memory is actively WRONG until it is superseded.
 */
const BASE_IMPORTANCE: Record<CueKind, number> = {
  correction: 9,
  prohibition: 8,
  identity: 8,
  preference: 6,
  agreement: 6,
  fact: 4,
}

/** Scope implied by the cue kind before the text is examined. */
const BASE_SCOPE: Record<CueKind, MemoryScope> = {
  identity: 'identity',
  // Corrections are resolved to a scope by the merge, since they inherit the scope of the
  // statement they correct; `global` is the safe default because it is visible everywhere.
  correction: 'global',
  prohibition: 'global',
  preference: 'global',
  agreement: 'project',
  fact: 'project',
}

/** Phrases that pin a statement to the user rather than to a project. */
const GLOBAL_MARKERS = /(?:我(?:个人)?(?:喜欢|偏好|习惯|希望)|我的习惯|我一贯|by default i|personally i|my preference)/iu

/** Phrases that pin a statement to the current project or team. */
const PROJECT_MARKERS = /(?:这个?项目|本?项目|我们(?:项目|团队|组|公司)|代码库|这个?仓库|this project|our (?:project|team|repo|codebase)|the codebase)/iu

/** Phrases that make a statement true of the user across every project. */
const IDENTITY_MARKERS = /(?:我是|我叫|我的名字|称呼我|叫我|my name is|call me|i am a|i'?m a)/iu

/**
 * Entities that mark a statement as a project convention no matter which cue found it.
 *
 * A sentence naming a specific technology is almost always a decision about this codebase, so
 * filing it as a global preference would leak one project's stack into every other project's
 * context — the exact cross-contamination the project layer exists to prevent.
 */
const TECHNOLOGY_MARKERS = /(?:\b(?:pnpm|npm|yarn|bun|node|deno|bun|typescript|javascript|python|rust|go|java|kotlin|swift|ruby|php|react|vue|svelte|angular|solid|next|nuxt|vite|webpack|rollup|esbuild|tsdown|sqlite|postgres|mysql|mongodb|redis|docker|kubernetes|k8s|terraform|nginx|graphql|rest|grpc|tailwind|sass|less|jest|vitest|mocha|playwright|cypress|eslint|prettier|biome)\b|(?:数据库|前端|后端|框架|语言|构建|部署|测试框架|包管理|依赖))/iu

/**
 * The quality gate.
 *
 * Order is load-bearing. The session-recall check runs before everything else because a
 * question ABOUT memory ("你记得我之前说过什么吗") otherwise satisfies several cue patterns
 * and distils into a memory of the user asking a question — a self-amplifying failure, since
 * that entry is then retrieved the next time they ask.
 */
export function judge(cue: Cue, hasProject: boolean, vouched = false): Judgement {
  const text = cue.text.trim()
  const fallbackScope = BASE_SCOPE[cue.kind]

  if (text === '') return { accepted: false, reason: 'empty', importance: 0, scope: fallbackScope }

  if (matchesAny(text, SESSION_RECALL_PATTERNS)) {
    return { accepted: false, reason: 'session-recall', importance: 0, scope: fallbackScope }
  }

  // Vague before length: several of the vague markers ARE short ("照旧", "同上"), and reporting
  // those as "too short" would hide the more useful reason. A vague candidate is rejected for
  // being unreadable out of context, and that is what the log should say.
  if (matchesAny(text, VAGUE_PATTERNS)) {
    return { accepted: false, reason: 'vague', importance: 0, scope: fallbackScope }
  }

  // The length window applies to MINED text only. It exists because a cue word can be found inside
  // a fragment that says nothing on its own, and inside a dump that says too much to be a rule —
  // and both of those are properties of the pattern, not of the sentence. Text the caller vouched
  // for is a different input class: a ZCode note is a paragraph, a Claude memory is a section, and
  // refusing either for being 700 characters long would make the importer store nothing. The
  // ceiling that remains is the caller's: `maxMemoryChars`, checked where the text came from.
  if (!vouched && text.length < MIN_CHARS) {
    return { accepted: false, reason: 'too-short', importance: 0, scope: fallbackScope }
  }

  // Measured before truncation rather than after: a 5000-character dump that happens to start
  // with "我喜欢" is not a preference, and truncating it would hide that.
  if (!vouched && text.length > MAX_CHARS) {
    return { accepted: false, reason: 'too-long', importance: 0, scope: fallbackScope }
  }

  // The interrogative and hedge checks apply to mined text only, for the reason the length window
  // above does: both ask whether the SENTENCE is a statement, and a sentence is not what a vouched
  // input is. Measured against a real store, an anchored ZCode note was thrown away because one of
  // its clauses contained 可能 — and the note was a standing record the user wrote deliberately,
  // which is exactly what this store exists to keep. In the other direction the check still earns
  // its place on the live path, where a musing about what one might do must not become a rule.
  if (!vouched && matchesAny(text, QUESTION_PATTERNS)) {
    return { accepted: false, reason: 'question', importance: 0, scope: fallbackScope }
  }

  if (!vouched && matchesAny(text, HEDGE_PATTERNS)) {
    return { accepted: false, reason: 'hedged', importance: 0, scope: fallbackScope }
  }

  if (hasProject && matchesAny(text, SESSION_SCOPED_PATTERNS)) {
    // Only rejected when there IS a project. Without one the caller keeps the memory
    // session-scoped anyway, and a session-scoped store is exactly where "这次改动" belongs.
    return { accepted: false, reason: 'session-scoped', importance: 0, scope: fallbackScope }
  }

  const scope = decideScope(cue, hasProject)
  return { accepted: true, importance: importanceFor(cue, text), scope }
}

/**
 * Chooses the layer a candidate belongs to.
 *
 * Identity is decided by the cue kind alone — the other three layers are the plugin's to write
 * and the identity layer is the user's, so a preference merely *mentioning* the user must not
 * be promoted into a file the user hand-edits.
 */
export function decideScope(cue: Cue, hasProject: boolean): MemoryScope {
  if (cue.kind === 'identity' || matchesAny(cue.text, IDENTITY_MARKERS)) return 'identity'

  if (!hasProject) {
    // No project identity means no project layer to write to. Constraint #4's fallback chain
    // ends at "session-scoped temporary memory only, never the project layer", and that is
    // this branch.
    return 'global'
  }

  if (matchesAny(cue.text, GLOBAL_MARKERS)) return 'global'
  if (matchesAny(cue.text, PROJECT_MARKERS)) return 'project'
  if (matchesAny(cue.text, TECHNOLOGY_MARKERS)) return 'project'

  return BASE_SCOPE[cue.kind]
}

/**
 * Scores how costly it would be to forget this.
 *
 * The score is a tie-breaker for eviction and a signal for ordering, not a truth claim, so it
 * is computed from surface features that are cheap and deterministic. Anything that would need
 * real judgement to score is handled by rejecting the candidate instead.
 */
export function importanceFor(cue: Cue, text: string): number {
  let score = BASE_IMPORTANCE[cue.kind]

  // Explicit storage instructions are unambiguous intent. The user said the word.
  if (/(?:记住|记一下|记下来|帮我记|remember (?:that|this)|make a note|note that)/iu.test(text)) {
    score += 1
  }

  // A prohibition needs to be complete to be obeyed: which thing, and what to do instead.
  if (cue.kind === 'prohibition' && /(?:改用|换成|而是|instead|use\b)/iu.test(text)) score += 1

  // Stated as a rule rather than an incident. "永远/始终/always/never" survive repetition.
  if (/(?:永远|始终|一直|每次都|一律|always|never|every time|without exception)/iu.test(text)) {
    score += 1
  }

  // Preferences stated with a reason are more stable than bare ones, but only slightly: the
  // reason can change while the preference stands.
  if (/(?:因为|由于|原因是|because|since|as\b)/iu.test(text)) score += 1

  // A candidate carrying its own file path or command is directly actionable.
  if (/(?:^|\s)[./~][\w./-]+|`[^`]+`|\b[a-z-]+ --?[\w-]+/u.test(text)) score += 1

  return Math.max(0, Math.min(10, score))
}

/** True when any pattern matches. Accepts one pattern or a list, so callers read naturally. */
function matchesAny(text: string, patterns: RegExp | readonly RegExp[]): boolean {
  if (patterns instanceof RegExp) return patterns.test(text)
  return patterns.some((pattern) => pattern.test(text))
}

/** Type guard used by the collector to reject a scope that came from persisted data. */
export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
}
